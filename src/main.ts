import { loadConfig, validateServeConfig } from "./config/index.js";
import { ProviderRuntime, lazyRuntime } from "./runtime/providers.js";
import { OpenRouterRuntime } from "./runtime/openrouter.js";
import { ApiRuntime } from "./runtime/api.js";
import { createSiwcRuntime } from "./runtime/siwc/index.js";
import { GatewayService, type GatewayShutdownReason } from "./service.js";
import { LocalCoreContextProvider } from "./core/context.js";
import { SessionStore } from "./sessions/store.js";
import { renderLocalPolicy, renderLocalData } from "./core/render.js";
import { LOCAL_CONTEXT_TOOLS } from "./core/tools.js";
import { LOCAL_KNOWLEDGE_TOOLS } from "./knowledge/tools.js";
import { initializeGateway } from "./setup.js";
import { exportCore, importCore } from "./state/migration.js";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { environmentLogSecrets, installFileLogging } from "./service/logging.js";

function printUsage(): void {
  console.log([
    "Sophon",
    "  npm run init                  Create a fresh local database and neutral context",
    "  npm run core -- export <file> Export the current Core as Markdown",
    "  npm run core -- import <file> Validate and replace Core from Markdown",
    "",
    "Runtime:",
    "  npm run bootstrap:siwc        Fetch and build the pinned official SIWC DevKit",
    "  npm run auth:login            Sign in with ChatGPT in the system browser",
    "  npm run auth:login -- --headless  Print a login URL and wait on loopback port 1455",
    "  npm run auth:status           Show the safe connection/session state",
    "  npm run auth:reconsent        Re-open consent if plan usage was not granted",
    "  npm run runtime:models        Discover models available to the current Provider",
    "  npm run runtime:test          Send a minimal test request; API providers require --allow-paid",
    "  npm run runtime:diagnose      Compare a clean request, Gateway context/tools, and saved history (read-only diagnostic)",
    "",
    "Gateway:",
    "  npm run gateway:check         Check Provider, local Core and channel configuration without starting channels",
    "  npm run serve                 Start Telegram/WeChat, sessions and heartbeat",
  ].join("\n"));
}

async function main(): Promise<void> {
  const [scope, action, ...rest] = process.argv.slice(2);
  if (!scope || scope === "help" || scope === "--help" || scope === "-h") {
    printUsage();
    return;
  }

  const headlessAuth = scope === "auth" && action === "login" && rest.includes("--headless");
  const headlessPort = 1455;
  const config = loadConfig();
  if (scope === "init") {
    await initializeGateway(config.dataDir);
    console.log("Gateway initialized. Configure .env, then run npm run serve.");
    return;
  }
  if (scope === "core") {
    if (rest.length !== 1 || (action !== "import" && action !== "export")) {
      throw new Error("Usage: npm run core -- <import|export> <markdown-file>");
    }
    if (action === "export") await exportCore(config.dataDir, resolve(rest[0]!));
    else await importCore(config.dataDir, resolve(rest[0]!));
    console.log("Core " + action + " complete.");
    return;
  }
  const siwc = lazyRuntime(() => createSiwcRuntime({
    dataDir: config.dataDir,
    devkitDir: config.siwcDevkitDir,
    preferredModel: config.model,
    credentialKeyFile: config.credentialKeyFile,
    ...(headlessAuth ? {
      redirectPort: headlessPort,
      openBrowser: async (url: string) => {
        console.log([
          "",
          "Headless ChatGPT sign-in",
          `1. Keep an SSH local forward open: 127.0.0.1:${headlessPort} -> VPS 127.0.0.1:${headlessPort}`,
          "2. Open this one-time URL in the browser on the device that owns the local forward:",
          "",
          url,
          "",
          "Waiting for the loopback callback…",
        ].join("\n"));
      },
    } : {}),
  }));

  const runtime = scope === "auth" ? siwc : new ProviderRuntime(config.dataDir, {
    siwc, openrouter: new OpenRouterRuntime({ dataDir: config.dataDir, timezone: config.heartbeat.timezone, ...config.openrouter }),
    api: new ApiRuntime({ dataDir: config.dataDir, ...config.api }),
  }, config.provider);

  if (scope === "auth" && action === "login") {
    console.log(headlessAuth
      ? `Preparing headless Continue with ChatGPT on 127.0.0.1:${headlessPort}…`
      : "Opening the system browser for Continue with ChatGPT…");
    console.log(JSON.stringify(await runtime.signIn(), null, 2));
    return;
  }
  if (scope === "auth" && action === "reconsent") {
    console.log("Opening the system browser to update ChatGPT plan usage consent…");
    console.log(JSON.stringify(await runtime.signIn({ reconsent: true }), null, 2));
    return;
  }
  if (scope === "auth" && action === "status") {
    console.log(JSON.stringify(await runtime.getSession(), null, 2));
    return;
  }
  if (scope === "runtime" && action === "models") {
    console.table(await runtime.listModels());
    return;
  }
  if (scope === "runtime" && action === "test") {
    if ((await runtime.getProvider?.()) !== "siwc" && !rest.includes("--allow-paid")) throw new Error("Paid test requires --allow-paid.");
    const text = rest.filter(arg => arg !== "--allow-paid").join(" ").trim() || "Reply with exactly: Sophon runtime works.";
    const result = await runtime.reply({ purpose: "diagnostic", text, sessionId: "cli-runtime-test", operationId: "cli-runtime-test:" + Date.now() });
    console.log("[" + (result.model ?? "unknown model") + "] " + result.text);
    return;
  }
  if (scope === "runtime" && action === "diagnose") {
    // Explicit operator-only diagnostic. It never changes provider/model or
    // touches the live Telegram lane, and never executes real Gateway tools.
    const provider = await runtime.getProvider?.() ?? "siwc";
    if (provider !== "siwc" && !rest.includes("--allow-paid")) {
      throw new Error("Paid provider diagnostic requires --allow-paid.");
    }
    const selected = await runtime.getModelSelection();
    const snapshot = await new LocalCoreContextProvider(config.dataDir).load();
    if (!snapshot.available || !snapshot.data) {
      throw new Error("Diagnostic Gateway context unavailable: " + (snapshot.error ?? "unknown"));
    }
    const sessions = config.telegram ? new SessionStore(config.dataDir) : undefined;
    let original;
    try { original = config.telegram ? await sessions!.get("telegram", config.telegram.ownerId) : undefined; }
    finally { sessions?.close(); }
    const tools = [...LOCAL_CONTEXT_TOOLS, ...LOCAL_KNOWLEDGE_TOOLS];
    const diagnosticPrompt = "仅做连通性诊断：请精确回复 diagnostic-ready，不调用工具。";
    const contextual = {
      instructions: renderLocalPolicy(snapshot),
      context: {
        controlRevision: snapshot.data.coreRevision,
        contextRevision: snapshot.data.recentRevision,
        content: renderLocalData(snapshot),
      },
      tools,
      maxToolRounds: 1,
      async executeTool() {
        // Diagnostics expose local schemas but never change saved context.
        return { error: "诊断模式禁止执行工具。" };
      },
    };
    const cases = [
      { label: "A: clean provider request", messages: [] as Array<{role:"user"|"assistant";content:string}>, withContext: false },
      { label: "B: same provider with Gateway policy/context/tool schemas", messages: [] as Array<{role:"user"|"assistant";content:string}>, withContext: true },
      ...(original?.messages.length ? [{
        label: "C: same provider with saved Telegram text history",
        messages: original.messages.map(m => ({ role: m.role, content: m.content })),
        withContext: true,
      }] : []),
    ];
    console.log("SIWC isolation diagnosis; model=" + (selected.resolvedModel ?? "unknown") +
      "; saved history messages=" + (original?.messages.length ?? 0));
    console.log("Stages use fresh temporary session IDs, never invoke real tools and never write to live Telegram history.");
    let failed = false;
    const temporarySessionIds: string[] = [];
    const originalConsoleError = console.error;
    // Diagnostics should show the stage result, not verbose plaintext history
    // breakdowns or thousands of characters of internal runtime telemetry.
    console.error = (...values: unknown[]) => {
      if (typeof values[0] === "string" &&
          /^\[runtime(?:-step|-recovery-breakdown)?\]/.test(values[0])) return;
      originalConsoleError(...values);
    };
    try {
      for (const item of cases) {
        const started = Date.now();
        const diagnosticSessionId = "cli-isolation-" + randomUUID();
        temporarySessionIds.push(diagnosticSessionId);
        try {
          const answer = await runtime.reply({
            purpose: "diagnostic",
            stateful: true,
            sessionId: diagnosticSessionId,
            messages: [...item.messages, { role: "user", content: diagnosticPrompt }],
            ...(item.withContext ? contextual : {}),
          });
          console.log(item.label + ": PASS (" + Math.round((Date.now() - started) / 1000) +
            "s, input tokens=" + (answer.usage?.inputTokens ?? "n/a") + ")");
        } catch (error) {
          failed = true;
          const msg = error instanceof Error ? error.message : String(error);
          const code = error && typeof error === "object" && "code" in error
            ? String((error as {code?:unknown}).code ?? "unknown") : "unknown";
          console.log(item.label + ": FAIL (" + Math.round((Date.now() - started) / 1000) +
            "s, code=" + code + ", errorClass=" + (error instanceof Error ? error.name : "unknown") +
            ", missingPrevious=" + /previous response.*not found/i.test(msg) + ")");
        }
      }
      if (cases.length < 3) console.log("C: SKIPPED; no saved owner Telegram transcript found.");
    } finally {
      // A one-shot CLI must not keep Stateful Responses WebSockets alive after
      // the final PASS. Delete temporary lanes, then close transport handles.
      for (const id of temporarySessionIds) {
        try {
          await runtime.resetSession?.(id);
        } catch {
          originalConsoleError("[diagnostic] could not clean one temporary session");
        }
      }
      try {
        await runtime.close?.();
      } finally {
        console.error = originalConsoleError;
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }
  if (scope === "gateway" && action === "check") {
    const localContext = await new LocalCoreContextProvider(config.dataDir).load();
    const session = await runtime.getSession();
    const issues: string[] = [];
    try { validateServeConfig(config); }
    catch (error) { issues.push(error instanceof Error ? error.message : "Channel configuration is invalid."); }
    if (!localContext.available) issues.push("Initialize or restore the local Core before starting.");
    if (session.status !== "connected" || !session.sharing) issues.push("Selected provider is not connected.");
    else {
      try {
        if (!(await runtime.getModelSelection()).resolvedModel) issues.push("Select an available chat model.");
      } catch { issues.push("Selected chat model is unavailable or not configured."); }
    }
    console.log(JSON.stringify({
      ready: issues.length === 0,
      issues,
      provider: await runtime.getProvider?.() ?? "siwc",
      runtime: session,
      localCore: { available: localContext.available, revision: localContext.data?.coreRevision },
      configuredChannels: {
        telegram: Boolean(config.telegram),
        wechat: Boolean(config.ilink),
      },
      heartbeat: config.heartbeat.enabled,
      maxToolRounds: config.maxToolRounds === 0 ? "unlimited" : config.maxToolRounds,
    }, null, 2));
    if (issues.length) process.exitCode = 1;
    await runtime.close?.();
    return;
  }
  if (scope === "serve") {
    const logging = await installFileLogging({
      directory: config.logDir ?? resolve(config.dataDir, "logs"),
      enabled: process.env.GATEWAY_LOG_ENABLED?.trim().toLowerCase() !== "false",
      secrets: [config.telegram?.token, config.openrouter?.apiKey, config.api?.apiKey,
        config.voice?.apiKey, ...environmentLogSecrets(process.env)],
    });
    const shutdownState: { reason: GatewayShutdownReason } = { reason: "signal" };
    let resolveShutdown: () => void = () => undefined;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const requestShutdown = (reason: GatewayShutdownReason) => {
      shutdownState.reason = reason;
      resolveShutdown();
    };
    const onSignal = () => requestShutdown("signal");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const onHostMessage = (message: unknown) => {
      if(process.env.SOPHON_MANAGED_HOST !== "1") return;
      const input = message as {type?:string; url?:unknown; reason?:unknown};
      if(input?.type === "sophon:shutdown") onSignal();
      if(input?.type === "sophon:control-url") service?.setControlTunnelUrl(input.url,input.reason);
    };
    process.on("message", onHostMessage);
    if(process.env.SOPHON_MANAGED_HOST === "1") process.once("disconnect", onSignal);

    let service: GatewayService | undefined;
    try {
      service = await GatewayService.create(config, runtime, requestShutdown);
      await service.start();
      if(process.env.SOPHON_MANAGED_HOST === "1" && process.send) process.send({type:"sophon:ready"});
      await shutdown;
    } catch (error) {
      const detail = logging.redact(error instanceof Error ? error.message : String(error));
      console.error("[gateway] service failed:", detail);
      throw new Error(detail);
    } finally {
      try { await service?.stop(); }
      catch (error) {
        const detail = logging.redact(error instanceof Error ? error.message : String(error));
        console.error("[gateway] service shutdown failed:", detail);
        throw new Error(detail);
      } finally {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
        process.removeListener("message", onHostMessage);
        process.removeListener("disconnect", onSignal);
        await logging.close();
      }
    }

    if (shutdownState.reason === "takeover") {
      process.exitCode = 75;
    } else if (shutdownState.reason === "telegram-conflict") {
      process.exitCode = 76;
    }
    return;
  }

  printUsage();
  throw new Error("Unknown command: " + [scope, action].filter(Boolean).join(" "));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Sophon error: " + message);
  process.exitCode = 1;
});
