import { requestHostUpdate } from "./commands/update.js";
import { MemoryRecent } from "./memory/recent.js";
import { MemoryWorker } from "./memory/worker.js";
import { prepareStartupMemory } from "./memory/startup.js";
import { inspectMemory } from "./memory/migration.js";
import { cleanupBackgroundArchives, cleanupConfirmedArchivesOnStartup } from "./runtime/siwc/background-cleanup.js";
import { SerialQueue } from "./util/serial-queue.js";
import { FileService } from "./files/service.js";
import { RecentReview } from "./knowledge/review.js";
import { IlinkAdapter } from "./channels/ilink/adapter.js";
import { IlinkStore } from "./channels/ilink/store.js";
import { createCredentialEncryption } from "./runtime/siwc/credential-encryption.js";
import { VoiceService } from "./voice/service.js";
import { TelegramVoiceTransport } from "./voice/telegram.js";
import { VoiceSettingsStore } from "./voice/settings.js";
import { VoiceStore } from "./voice/store.js";
import { BailianSpeech } from "./voice/bailian.js";
import { VoicePanel } from "./voice/panel.js";
import { withTimeout } from "./util/timeout.js";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { GatewayConfig } from "./config/index.js";
import { controlTunnelUrl, validateServeConfig } from "./config/index.js";
import { TelegramAdapter } from "./channels/telegram/adapter.js";
import type { InboundMessage } from "./channels/types.js";
import type { ReplyOutcome } from "./channels/reply.js";
import { recordDeliveredAssistant } from "./delivery/coordinator.js";
import { ActiveChannelRouter } from "./channels/active.js";
import { GatewayCommandRouter, TELEGRAM_COMMANDS } from "./commands/router.js";
import { CommandPanels } from "./commands/panels.js";
import { creditSummary } from "./commands/credits.js";
import { providerLabel } from "./commands/providers.js";
import { DiagnosticRegistry } from "./commands/diagnostics.js";
import { systemDiagnostics } from "./commands/system-diagnostics.js";
import { readJsonFile } from "./util/atomic-json.js";
import { heartbeatEligible, dateKey, type HeartbeatState } from "./heartbeat/policy.js";
import { localMinutes } from "./heartbeat/planner.js";
import { Gateway } from "./gateway.js";
import { ExpressionStore } from "./expression/store.js";
import { HeartbeatRunner } from "./heartbeat/runner.js";
import { MediaStore } from "./media/store.js";
import type { ManagedChatRuntime } from "./runtime/types.js";
import { SessionStore } from "./sessions/store.js";
import { LocalCoreContextProvider, renderRecentSummary } from "./core/context.js";
import { LocalKnowledgeStore } from "./knowledge/store.js";
import { CompactionNoticeLedger } from "./runtime/siwc/compaction-notice.js";
import { ControlCenter } from "./control/server.js";
import { ControlData } from "./control/data.js";
import { HostMonitor } from "./control/host.js";
import { TaskTraceStore } from "./observability/store.js";
import { persistContextObservation } from "./control/context-observation.js";
import {
  acquireInstanceLock,
  instanceOwnerAlive,
  readInstanceOwner,
  waitForInstanceRelease,
  type InstanceLock,
} from "./service/instance-lock.js";

export type GatewayShutdownReason = "takeover" | "telegram-conflict" | "signal";

export class GatewayService {
  static async create(config:GatewayConfig,runtime:ManagedChatRuntime,requestShutdown:(reason:GatewayShutdownReason)=>void=()=>undefined):Promise<GatewayService>{
    validateServeConfig(config);
    await GatewayService.takeOverPreviousInstance(config);
    const lock=await acquireInstanceLock(config.dataDir);
    try{
      let effective=config;
      if(config.memoryGraphEnabled!==false){
        if(!config.telegram?.ownerId)effective={...config,memoryGraphEnabled:false,memoryGraphState:'missing_owner'};
        else{
          try{await prepareStartupMemory(config.dataDir,config.telegram.ownerId,lock);effective={...config,memoryGraphEnabled:true};}
          catch{
            // Fail closed on damaged state; a failed optional snapshot must not block intact chat data.
            await inspectMemory(config.dataDir);
            effective={...config,memoryGraphEnabled:false,memoryGraphState:'preparation_failed'};
            console.error('[memory] preparation_failed; normal chat may continue. Check disk space and data directory permissions.');
          }
        }
      }
      const service=new GatewayService(effective,runtime,requestShutdown);service.instanceLock=lock;return service;
    }catch(error){await lock.release();throw error;}
  }
  private readonly sessions: SessionStore;
  private readonly conversationQueue = new SerialQueue();
  private readonly voice: VoiceService;
  private readonly ilink?: IlinkAdapter;
  private readonly expressions: ExpressionStore;
  private readonly gatewayContext: LocalCoreContextProvider;
  private readonly localKnowledge?: LocalKnowledgeStore;
  private readonly gateway: Gateway;
  private readonly memoryWorker?: MemoryWorker;
  private chatInFlight=0;
  private readonly compactionNotices: CompactionNoticeLedger;
  private readonly telegram?: TelegramAdapter;
  private readonly activeChannels: ActiveChannelRouter;
  private readonly panels: CommandPanels;
  private readonly diagnostics: DiagnosticRegistry;
  private readonly commands: GatewayCommandRouter;
  private readonly heartbeat?: HeartbeatRunner;
  private readonly recentReview?: RecentReview;
  private readonly control?: ControlCenter;
  private readonly taskTraces?: TaskTraceStore;
  private server?: Server;
  private instanceLock?: InstanceLock;

  constructor(
    private readonly config: GatewayConfig,
    private readonly runtime: ManagedChatRuntime,
    private readonly requestShutdown: (reason: GatewayShutdownReason) => void = () => undefined,
  ) {
    validateServeConfig(config);

    const media = new MediaStore(join(config.dataDir, "media"));
    this.sessions = new SessionStore(config.dataDir);
    const enabled=config.memoryGraphEnabled;
    if(enabled===true && !config.telegram?.ownerId)throw Error('记忆图需要正式管理员会话。');
    const memory=enabled===true?this.sessions.enableMemory(config.telegram!.ownerId):undefined;
    if(memory)this.memoryWorker=new MemoryWorker(memory,runtime,()=>!this.stopping&&this.chatInFlight===0);
    this.expressions = new ExpressionStore(config.dataDir);
    const speechSettings=new VoiceSettingsStore(config.dataDir);
    const speechClient=new BailianSpeech(config.voice ?? {});
    const speechQueue=new SerialQueue();
    this.voice = new VoiceService(speechSettings, new VoiceStore(config.dataDir),speechClient,undefined,speechQueue);
    this.localKnowledge = new LocalKnowledgeStore(config.dataDir, "formal");
    this.compactionNotices = new CompactionNoticeLedger(config.dataDir);
    this.gatewayContext = new LocalCoreContextProvider(config.dataDir,
      () => renderRecentSummary(memory?new MemoryRecent(memory).remainingDirectory(this.localKnowledge!.listRecent()):this.localKnowledge!.listRecent()),
      () => this.expressions.snapshot(), () => this.localKnowledge!.getRecentRevision());
    const files = config.files?.enabled && config.telegram ? new FileService(config.dataDir,
      config.files.generatedDir, config.telegram.ownerId, file => {
        if (!this.telegram) throw new Error("Telegram is unavailable for document delivery");
        return this.telegram.sendDocumentToOwner(file);
      }) : undefined;
    if (config.recentReview?.enabled && config.telegram) this.recentReview = new RecentReview(config.dataDir,
      config.telegram.ownerId, runtime, this.sessions, this.localKnowledge, this.gatewayContext, this.conversationQueue, () => !!memory && new MemoryRecent(memory).enabled());
    this.gateway = new Gateway(runtime, this.sessions, this.gatewayContext,
      config.maxToolRounds, config.heartbeat.timezone,
      undefined, this.expressions, this.localKnowledge, async message =>
        message.senderId===config.telegram?.ownerId && message.conversationId===config.telegram?.ownerId &&
        this.voice.configured() && (await this.voice.settings.get()).tts,
      async checkpoint => {
        if (!this.telegram) return;
        if (!(await this.compactionNotices.claim(checkpoint))) return;
        const reason = checkpoint.reason === "seven_days"
          ? "距离上次成功压缩已满 7 天" : "上下文达到容量阈值（120K token）";
        await this.telegram.notifyTemporary(
          "🧠 Gateway 上下文已压缩\n原因：" + reason + "\n历史检查点已保存，对话可以继续。", 60_000);
      }, config.control ? observation => persistContextObservation(config.dataDir, observation) : undefined, files, memory);

    if (config.telegram) {
      const telegramVoice=new TelegramVoiceTransport(this.voice,config.telegram.ownerId);
      this.telegram = new TelegramAdapter({
        showStageDirections: async () => (await this.expressions.snapshot()).showStageDirections === true,
        ...config.telegram,
        dataDir: config.dataDir,
        mediaStore: media,
        commands: TELEGRAM_COMMANDS,
        conversationQueue: this.conversationQueue,
        onCallback: (query, api) => telegramVoice.callback(query, api),
        sendVoice: (api, target, text, id, nativeReply, onSent, instruction, preview) => telegramVoice.send(api, target, text, id, preview === true, nativeReply, onSent, instruction),
        sendProactiveVoice: (api, target, text, instruction, deliveryId) => telegramVoice.proactive(api, target, text, instruction, deliveryId),
        onPanel: (command, message) => this.panels.open(command, message),
        onPollingConflict: () => this.requestShutdown("telegram-conflict"),
        onReplyDelivered: async ({ conversationId, senderId, reply, images, deliveryId, complete, platformMessages }) => {
          await this.gateway.commitDeliveredAssistant("telegram", conversationId, senderId, reply, images, deliveryId, complete, platformMessages);
        },
        onReplyDeliveryFailed: async ({ conversationId, deliveryId }) => {
          await this.gateway.discardUndeliveredAssistant("telegram", conversationId, deliveryId);
        },
        onProactiveDelivered: async ({ conversationId, senderId, reply, images, deliveryId }) => {
          await recordDeliveredAssistant(this.sessions, "telegram", conversationId, senderId, reply, images, deliveryId);
        },
      });
    }
    if (config.ilink && config.telegram) {
      this.ilink = new IlinkAdapter({
        showStageDirections: async () => (await this.expressions.snapshot()).showStageDirections === true, ownerId: config.telegram.ownerId,
        store: new IlinkStore(config.dataDir, createCredentialEncryption(process.platform, config.credentialKeyFile)),
        media, queue: this.conversationQueue,
        bind: (owner, user) => this.sessions.bindOwnerSession(owner, user),
        activate: () => this.activeChannels.setActive("wechat"),
        qrPhoto: bytes => this.telegram!.showQr(bytes),
        notify: text => this.telegram!.notify(text, () => this.ilink!.panel()),
        lookupReference: (user, botId, id) => this.sessions.findPlatformMessage("wechat", user, botId, id),
        proactiveDelivered: async (user, text, id, at, fragments) => {
          await recordDeliveredAssistant(this.sessions, "wechat", user, user, text, undefined, id, at, { origin: "proactive" }, fragments);
        },
        delivered: async (user, text, id, complete, fragments) => {
          await this.gateway.commitDeliveredAssistant("wechat", user, user, text, undefined, id, complete, fragments);
        },
        discarded: (user, id) => this.gateway.discardUndeliveredAssistant("wechat", user, id),
      });
    }

    const defaultChannel = config.heartbeat.channel
      ?? (this.telegram ? "telegram" : this.ilink ? "wechat" : "off");
    this.activeChannels = new ActiveChannelRouter(
      config.dataDir,
      { telegram: this.telegram, wechat: this.ilink },
      defaultChannel,
    );
    const logDir = config.logDir ?? join(config.dataDir, "logs");
    if (config.control) {
      this.taskTraces = new TaskTraceStore(config.dataDir, { secrets: [config.telegram?.token,
        config.api?.apiKey, config.openrouter?.apiKey, config.voice?.apiKey].filter((value): value is string => Boolean(value)) });
      this.control = new ControlCenter({
        publicUrl: config.control.publicUrl,
        temporary: config.control.tunnel === "cloudflare",
        tunnelReady: config.control.tunnel === "cloudflare" && process.env.SOPHON_MANAGED_HOST === "1" && !!controlTunnelUrl(process.env.SOPHON_CONTROL_TUNNEL_URL),
        data: new ControlData(config.dataDir, { sessions: this.sessions, knowledge: this.localKnowledge,
          context: this.gatewayContext, expressions: this.expressions, timezone: config.heartbeat.timezone,
          memory: {ownerId: config.telegram?.ownerId, enabled: config.memoryGraphEnabled,
            runtimeStatus:()=>config.memoryGraphState??this.memoryWorker?.status()},
          editHistory: async (id, work) => { if(!runtime.editHistory)throw Error("历史编辑不可用。");await runtime.editHistory(id,work); } }),
        traces: this.taskTraces, host: new HostMonitor(config.dataDir),
        mutate: work => this.conversationQueue.run(async () => work()),
        heartbeat: async () => {
          const now = new Date();
          const state = await readJsonFile<HeartbeatState>(join(config.dataDir, "heartbeat", "state.json"),
            { dateKey: dateKey(now, config.heartbeat.timezone), sentToday: 0, recent: [] });
          return { enabled: config.heartbeat.enabled, timezone: config.heartbeat.timezone,
            plan: state.plan ?? null, nextCheckAt: state.nextCheckAt ?? null,
            attemptsToday: state.dateKey === dateKey(now, config.heartbeat.timezone) ? state.sentToday : 0,
            activeChannel: await this.activeChannels.getActive() };
        },
      });
    }
    this.commands = new GatewayCommandRouter(runtime, this.activeChannels, undefined, undefined, this.expressions,
      message => {
        if (message.channel !== "telegram" || message.senderId !== config.telegram?.ownerId || message.conversationId !== config.telegram?.ownerId) {
          return "控制中心入口仅向已配置的管理员私聊提供。";
        }
        return this.control?.loginMessage() ?? "控制中心未启用；请配置 GATEWAY_CONTROL_TUNNEL=cloudflare 并使用 npm start。";
      }, async (message, args) => {
        if(message.channel!=="telegram" || message.senderId!==config.telegram?.ownerId || message.conversationId!==config.telegram?.ownerId)
          return "更新功能仅向已配置的管理员私聊提供。";
        return requestHostUpdate(args);
      });

    this.diagnostics = new DiagnosticRegistry(systemDiagnostics(config.dataDir, {
      services: async () => {
        const session=await withTimeout(runtime.getSession(), 8000, "认证查询");
        const context=await this.gatewayContext.load();
        return "Gateway：运行中\nProvider："+providerLabel(await runtime.getProvider?.()??"api")+"\n认证："+session.status+"\n本地 Core："+(context.available?"可用":"不可用");
      },
      queue: () => this.telegram?.queueSummary()??"Telegram 未启用。",
      heartbeat: async () => {
        const active=await this.activeChannels.getActive();const now=new Date();
        const state=await readJsonFile<HeartbeatState>(join(config.dataDir,"heartbeat","state.json"),{dateKey:dateKey(now,config.heartbeat.timezone),sentToday:0,recent:[]});
        const policy=heartbeatEligible(now,config.heartbeat,state,await this.sessions.latestActivityAt());
        const minutes=localMinutes(now,config.heartbeat.timezone);
        const next=state.plan?.date===dateKey(now,config.heartbeat.timezone)?state.plan.wakes.find(w=>!w.consumed && Number(w.time.slice(0,2))*60+Number(w.time.slice(3))>=minutes)?.time:undefined;
        return "主动消息："+(!config.heartbeat.enabled?"未启用":active)+"\n当天尝试："+(state.dateKey===dateKey(now,config.heartbeat.timezone)?state.sentToday:0)+
          "\n下一计划唤醒："+(next??state.nextCheckAt??"尚无计划")+"\n当前条件："+(!config.heartbeat.enabled?"未启用":active==="off"?"渠道关闭":policy.reason??"满足基础条件，到点后仍可选择静默")+"\n时区："+config.heartbeat.timezone;
      },
    }));
    this.panels=new CommandPanels(runtime,this.activeChannels,this.expressions,this.diagnostics,logDir,
      config.heartbeat.timezone,()=>creditSummary(config.openrouter?.apiKey,process.env.GATEWAY_OPENROUTER_MANAGEMENT_KEY),this.ilink,new VoicePanel(this.voice,()=>this.telegram?.previewVoice()??Promise.resolve(false)));

    if (config.heartbeat.enabled) {
      this.heartbeat = new HeartbeatRunner(
        config.dataDir,
        config.heartbeat,
        runtime,
        this.sessions,
        this.gatewayContext,
        this.activeChannels,
        this.expressions,
        undefined,
        this.localKnowledge,
        this.conversationQueue,
        async () => { const settings=await this.voice.settings.get();return this.voice.configured()&&settings.tts&&settings.proactive; },
        this.taskTraces,
        memory ? () => ({...memory.context(), refresh: () => memory.context()}) : undefined,
      );
    }
  }
  private async handleInbound(message: InboundMessage): Promise<ReplyOutcome | undefined> {
    if (this.stopping) return undefined;
    const command = message.channel === "telegram" ? await this.commands.handle(message) : undefined;
    if (command !== undefined) return { kind: "local_reply", text: command };
    try { message = await this.voice.preprocess(message); }
    catch (error) { return { kind: "local_reply", text: error instanceof Error ? error.message : "附件或语音处理失败，请重发。" }; }
    this.chatInFlight++;
    try { return await this.gateway.handle(message); } finally { this.chatInFlight--; }
  }

  async start(): Promise<void> {
    if(!this.instanceLock){
      await GatewayService.takeOverPreviousInstance(this.config);
      this.instanceLock = await acquireInstanceLock(this.config.dataDir);
    }
    try {
      // The old Gateway is stopped; verify SQLite integrity before starting channels.
      await this.sessions.prepare();
      await cleanupBackgroundArchives(this.config.dataDir);
      await cleanupConfirmedArchivesOnStartup(this.config.dataDir);
      this.taskTraces?.recoverInterrupted();
      const session = await this.runtime.getSession();
      if (session.status !== "connected" || !session.sharing) {
        throw new Error("Selected runtime is not ready. For API providers check the configured endpoint, model and credentials; for SIWC run auth:login / auth:reconsent.");
      }

      const contextReady = await this.gatewayContext.load();
      if (!contextReady.available) {
        throw new Error("Local Core is missing or invalid; refusing to start messaging.");
      }
      // Empty Recent is valid for a new/fully cleared local database.
      // SQLite schema/integrity and reviewed Core remain the startup boundary.

      // Bind the local service endpoint before starting Telegram long polling.
      // If an older Gateway still owns the port, this instance exits before it
      // can create a second getUpdates request and trigger Telegram 409 conflicts.
      await this.startHttpServer();
      this.control?.start();
      if (this.telegram) await this.telegram.start((message) => this.handleInbound(message));
      if (this.ilink) await this.ilink.start((message) => this.handleInbound(message));
      await this.heartbeat?.start();
      this.recentReview?.start();
      this.memoryWorker?.start();

      console.error(
        "[gateway] ready on http://" + this.config.server.host + ":" + this.config.server.port +
        " (telegram=" + Boolean(this.telegram) + ", wechat=" + Boolean(this.ilink) + ")",
      );
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  private stopping?: Promise<void>;
  stop(): Promise<void> {
    return this.stopping ??= this.cleanup();
  }

  private async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (work: () => unknown | Promise<unknown>) => {
      try { await work(); } catch (error) { errors.push(error); }
    };
    this.diagnostics.stop();
    this.control?.beginShutdown();
    // Drain decisions and deliveries before releasing their runtime and lock.
    await attempt(() => this.heartbeat?.stop());
    await attempt(() => this.recentReview?.stop());
    await attempt(() => this.ilink?.stop());
    await attempt(() => this.telegram?.stop());
    await attempt(() => this.memoryWorker?.stop());
    await attempt(() => this.runtime.close?.());
    await attempt(() => this.control?.close());
    await attempt(() => this.taskTraces?.close());
    await attempt(() => this.voice.close());
    await attempt(() => this.localKnowledge?.close());
    await attempt(() => this.sessions.close());
    await attempt(async () => {
      if (this.server) {
        const server = this.server;
        this.server = undefined;
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    });
    await attempt(() => this.instanceLock?.release());
    this.instanceLock = undefined;
    if (errors.length) throw new AggregateError(errors, "Gateway cleanup failed");
  }

  private static localControlHost(config:GatewayConfig): string {
    const host = config.server.host;
    if (host === "0.0.0.0" || host === "::" || host === "[::]") return "127.0.0.1";
    return host;
  }

  private static async takeOverPreviousInstance(config:GatewayConfig): Promise<void> {
    const owner = await readInstanceOwner(config.dataDir);
    if (!owner || owner.pid === process.pid || !instanceOwnerAlive(owner)) return;

    const url =
      "http://" + GatewayService.localControlHost(config) + ":" + config.server.port +
      "/__gateway/takeover";
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "x-gateway-takeover-token": owner.takeoverToken },
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      throw new Error(
        "An older Gateway instance is still active (pid=" + owner.pid + "), " +
        "but it does not support safe handoff. Stop it once, then start the new Gateway again.",
      );
    }

    if (response.status !== 202) {
      throw new Error(
        "Gateway takeover was rejected by the active instance (pid=" + owner.pid + ").",
      );
    }

    const released = await waitForInstanceRelease(config.dataDir, owner.pid, 6_000);
    if (!released) {
      throw new Error(
        "The previous Gateway instance did not exit in time (pid=" + owner.pid + ").",
      );
    }
  }

  setControlTunnelUrl(value: unknown, reason?: unknown): void { this.control?.setTunnelUrl(value,reason); }

  private async startHttpServer(): Promise<void> {
    this.server = createServer(async (req, res) => {
      try {
        if (await this.control?.handle(req, res)) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/__gateway/takeover" && req.method === "POST") {
          const token = req.headers["x-gateway-takeover-token"];
          if (
            !this.instanceLock ||
            typeof token !== "string" ||
            token !== this.instanceLock.takeoverToken
          ) {
            res.writeHead(403, { "content-type": "text/plain" });
            res.end("forbidden");
            return;
          }
          res.writeHead(202, { "content-type": "text/plain" });
          res.end("handoff accepted");
          queueMicrotask(() => this.requestShutdown("takeover"));
          return;
        }
        if (url.pathname === "/healthz") {
          const body = JSON.stringify(await this.healthSnapshot());
          res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
          res.end(body);
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } catch (error) {
        console.error("[gateway] HTTP error:", error instanceof Error ? error.message : error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        if (!res.writableEnded) res.end("internal error");
      }
    });
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.server.port, this.config.server.host, () => resolve());
    });
  }

  private async healthSnapshot(probe = true): Promise<Record<string, unknown>> {
    if (!probe) {
      const context = this.gatewayContext.peek();
      return { cached: true,
        localCore: context?.available ?? false,
        core: { available: context?.available ?? false, revision: context?.data?.coreRevision },
        channels: { telegram: Boolean(this.telegram), wechat: Boolean(this.ilink), proactive: await this.activeChannels.getActive() } };
    }
    const [runtime, context, proactiveChannel] = await Promise.all([
      this.runtime.getSession(), this.gatewayContext.load(), this.activeChannels.getActive(),
    ]);
    return {
      at: new Date().toISOString(),
      pid: process.pid,
      ok: runtime.status === "connected" && runtime.sharing && context.available,
      runtime: { provider: await this.runtime.getProvider?.() ?? "api", status: runtime.status, sharing: runtime.sharing },
      localCore: context.available,
      core: { available: context.available, revision: context.data?.coreRevision },
      channels: { telegram: Boolean(this.telegram), wechat: Boolean(this.ilink), proactive: proactiveChannel },
    };
  }
}
