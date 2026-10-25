import { createHash } from "node:crypto";
import { safeToolOutput } from "../tool-output.js";
import { safeTraceStart, safeTraceFinish } from "../../observability/runtime-trace.js";
import { tracedToolStatus } from "../trace-content.js";
import { SerialQueue } from "../../util/serial-queue.js";
import { isMissingPreviousResponseError, isRetryableTransportError, isSubscriptionUsageLimitError, tagInboundRetryability } from "../retry-policy.js";
import type { LaneState, ResponseSnapshot, StatefulResponsesSocket, StatefulResponsesSocketFactory, StatefulResponseOptions, StatefulResponseResult } from "./stateful-types.js";
import { ResponsesTransport, defaultSocketFactory } from "./responses-transport.js";
import { LaneStore } from "./lane-store.js";
import { planRecovery } from "./recovery.js";
import { hasUnresolvedToolEvidence } from "./responses-codec.js";
import { readRecoveryHistoryWindow } from "./history-window.js";
import { checkpointFromItems, sevenDayCompactionDue, SIWC_AUTO_COMPACT_TOKENS,
  SIWC_WEEKLY_COMPACT_TOKENS, standaloneCompact, type StandaloneCompactor } from "./compaction.js";
import { withHistoryTool } from "../history-tool.js";
import { blockTextualToolCall } from "../tool-call-integrity.js";
import { logRecoveryBreakdown } from "./context-diagnostics.js";
import { responseTools, currentUserItem, bootstrapPolicyItem, liveContextItem, emptyUsage, callsFrom, addUsage, hasCompaction, pruneToLatestCompaction, textFrom, replaceVisibleReplyText, transcriptItems, historicalAttachmentItems } from "./responses-codec.js";
export type { StatefulResponsesSocket, StatefulResponsesSocketFactory, StatefulResponseOptions, StatefulResponseResult } from "./stateful-types.js";
export { summarizeContextItems } from "./context-diagnostics.js";
export type { ContextPayloadSummary } from "./context-diagnostics.js";
export { hasUnresolvedToolEvidence, pruneToLatestCompaction } from "./responses-codec.js";
export function compactThresholdForModel(_model: string): number {
  return SIWC_AUTO_COMPACT_TOKENS;
}

/** Old releases embedded per-turn Persona as developer input items. Those items
 * persist through previous_response_id and must be removed by replaying the
 * canonical transcript when it is safe to do so. Opaque checkpoints and
 * unreconstructed media cannot be discarded merely to change speaking style. */
function isLegacyPersonaInput(item: Record<string, unknown>): boolean {
  return item.role === "developer" && typeof item.content === "string" &&
    item.content.includes("【Gateway Persona：当前语言和性格表现预设】") &&
    // The current unified policy deliberately includes Persona. Only the old
    // standalone Persona items need migration; matching their label alone
    // would discard a healthy response chain on every formal turn.
    !item.content.startsWith(String(bootstrapPolicyItem("").content));
}

function unresolvedToolItems(items: Record<string, unknown>[]): Record<string, unknown>[] {
  let lastAssistant = -1;
  for (const [index, item] of items.entries()) {
    if (item.type === "message" && item.role === "assistant") lastAssistant = index;
  }
  const evidence = items.slice(lastAssistant + 1).filter(item =>
    item.type === "function_call" || item.type === "function_call_output");
  const calls = new Map(evidence.filter(item => item.type === "function_call")
    .map(item => [item.call_id, item]));
  const contextRead = /^gateway_(recent|core|persona)_read$/;
  const contextWrite = /^gateway_(recent_(create|write|delete)|(core|persona)_write)$/;
  const parsedObject = (value: unknown): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(String(value));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  };
  const identity = (value: Record<string, unknown>): Record<string, unknown> => ({
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(Number.isSafeInteger(value.expected_revision) ? { expected_revision: value.expected_revision } : {}),
  });
  return evidence.flatMap(item => {
    const call = item.type === "function_call" ? item : calls.get(item.call_id);
    const name = String(call?.name ?? "");
    // Read-only snapshots can be re-read. Keeping them would reintroduce a
    // deleted Recent body through a failed tool round instead of liveContext.
    if (contextRead.test(name)) return [];
    if (!contextWrite.test(name)) return [item];
    const args = parsedObject(call?.arguments);
    const target = { ...identity(args), ...(Array.isArray(args.items)
      ? { items: args.items.filter(value => value && typeof value === "object").map(value => identity(value as Record<string, unknown>)) }
      : {}) };
    if (item.type === "function_call") return [{ ...item, arguments: JSON.stringify(target) }];
    const result = parsedObject(item.output);
    const updated = [result.created, result.updated].find(value => value && typeof value === "object") as Record<string, unknown> | undefined;
    const resultId = updated?.id ?? result.resultId;
    const resultRevision = updated?.revision ?? result.resultRevision;
    const argumentHash = result.argumentsRedacted === true && typeof result.argumentHash === "string" && /^[a-f0-9]{64}$/.test(result.argumentHash)
      ? result.argumentHash : createHash("sha256").update(String(call?.arguments ?? "")).digest("hex");
    return [{ ...item, output: JSON.stringify({
      status: "reconcile_current_context", argumentsRedacted: true,
      argumentHash,
      ...target,
      ...(typeof resultId === "string" ? { resultId } : {}),
      ...(Number.isSafeInteger(resultRevision) ? { resultRevision } : {}),
      message: "这个写入操作可能已生效；上下文已更新，旧参数和结果正文已移除。先用当前专用读取工具核对，不要重复写入；上方参数仅为定位元数据，不能用于重放。",
    }) }];
  });
}

function checkpointMatches(items: Record<string, unknown>[],
  checkpoint: LaneState["checkpoint"]): boolean {
  if (!checkpoint) return false;
  const opaque = [...items].reverse().find(item => item.type === "compaction");
  return Boolean(opaque && createHash("sha256").update(JSON.stringify(opaque)).digest("hex") === checkpoint.sha256);
}

export class StatefulResponsesBridge {
  private readonly lanes = new Map<string, LaneState>();
  private readonly operations = new SerialQueue();
  private readonly store: LaneStore;
  private readonly transport: ResponsesTransport;
  private readonly socketRotationTimers = new Map<StatefulResponsesSocket, ReturnType<typeof setTimeout>>();
  private readonly expiredSockets = new Set<StatefulResponsesSocket>();
  private readonly activeSessions = new Set<string>();

  constructor(
    dataDir: string,
    private readonly socketFactory: StatefulResponsesSocketFactory = defaultSocketFactory,
    idleTimeoutMs = 300_000,
    retryDelay: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly socketLifetimeMs = 50 * 60_000,
    private readonly now: () => Date = () => new Date(),
    private readonly compactContext: StandaloneCompactor = standaloneCompact,
  ) {
    this.store = new LaneStore(dataDir);
    this.transport = new ResponsesTransport(idleTimeoutMs, retryDelay);
  }

  private async loadLane(sessionId: string, model: string, ephemeral = false): Promise<LaneState> {
    if (ephemeral) {
      if (this.lanes.has(sessionId)) throw new Error("Temporary SIWC session ID was reused.");
      const lane: LaneState = { sessionId, model, ephemeral: true, contextItems: [], needsBootstrap: true };
      this.lanes.set(sessionId, lane);
      return lane;
    }
    const existing = this.lanes.get(sessionId);
    if (existing) {
      if (existing.model !== model) {
        await this.store.archive(sessionId, { version: 2, sessionId, model: existing.model,
          contextItems: existing.contextItems, controlRevision: existing.controlRevision,
          contextRevision: existing.contextRevision, historyCursor: existing.historyCursor,
          startedAt: existing.startedAt, lastCompactedAt: existing.lastCompactedAt,
          checkpoint: existing.checkpoint }, "model-change");
        existing.model = model;
        existing.previousResponseId = undefined;
        existing.controlRevision = undefined;
        existing.contextRevision = undefined;
        existing.contextItems = [];
        existing.historyCursor = undefined;
        existing.attachmentCursor = undefined;
        existing.coverageVerified = true;
        existing.needsBootstrap = true;
        existing.needsWindowRebase = false;
        existing.checkpoint = undefined;
        existing.lastCompactedAt = undefined;
        existing.startedAt = undefined;
      }
      return existing;
    }

    let persisted: Awaited<ReturnType<LaneStore["read"]>>;
    try {
      persisted = await this.store.read(sessionId);
    } catch (error) {
      if (!(await this.store.quarantineRecoverable(sessionId, error))) throw error;
      console.error("[runtime-recovery-degraded] session=" + sessionId +
        " corrupt checkpoint archived; falling back to SQLite transcript only. reason=" +
        (error instanceof Error ? error.message : "unknown"));
    }
    if (persisted && persisted.model !== model) {
      await this.store.archive(sessionId, persisted, "model-change");
    }
    const usable = (persisted?.version === 1 || persisted?.version === 2) && persisted.model === model &&
      Array.isArray(persisted.contextItems);
    const lane: LaneState = {
      sessionId,
      model,
      ...(usable ? {
        controlRevision: persisted!.controlRevision,
        contextRevision: persisted!.contextRevision,
        contextItems: persisted!.pendingPreparedItems ?? persisted!.contextItems,
        historyCursor: persisted!.historyCursor,
        attachmentCursor: persisted!.attachmentCursor,
        coverageVerified: persisted!.version === 2 ? persisted!.coverageVerified !== false : false,
        // v1's 48K rebase flag is retired, never applied to an upgraded lane.
        startedAt: persisted!.startedAt,
        lastCompactedAt: persisted!.pendingPreparedLastCompactedAt ?? persisted!.lastCompactedAt,
        checkpoint: persisted!.pendingPreparedCheckpoint ?? persisted!.checkpoint,
        pendingDeliveryItems: persisted!.pendingDeliveryItems,
        pendingRecoveryWithoutPrepared: Boolean(persisted!.pendingDeliveryItems && !persisted!.pendingPreparedItems),
        pendingDeliveryId: persisted!.pendingDeliveryId,
        pendingDeliveryCheckpoint: persisted!.pendingDeliveryCheckpoint,
        pendingDeliveryLastCompactedAt: persisted!.pendingDeliveryLastCompactedAt,
      } : {
        contextItems: [],
        coverageVerified: true,
      }),
      needsBootstrap: true,
    };
    this.lanes.set(sessionId, lane);
    return lane;
  }

  private persistLane(lane: LaneState): Promise<void> {
    return lane.ephemeral ? Promise.resolve() : this.store.save(lane);
  }

  private clearRotationTimer(socket: StatefulResponsesSocket): void {
    const timer = this.socketRotationTimers.get(socket);
    if (timer) clearTimeout(timer);
    this.socketRotationTimers.delete(socket);
    this.expiredSockets.delete(socket);
  }

  private invalidateLaneConnection(lane: LaneState, expectedSocket?: StatefulResponsesSocket): void {
    if (expectedSocket && lane.socket !== expectedSocket) {
      this.clearRotationTimer(expectedSocket);
      return;
    }
    if (lane.socket) this.clearRotationTimer(lane.socket);
    lane.socket = undefined;
    lane.socketToken = undefined;
    lane.previousResponseId = undefined;
    lane.needsBootstrap = true;
  }

  /** Connections expire server-side after 60 minutes, even when idle.
   * Retire them at 50 minutes so the SDK never receives an unobserved
   * connection-limit error outside an active response stream.
   */
  private scheduleRotation(lane: LaneState, socket: StatefulResponsesSocket): void {
    const timer = setTimeout(() => {
      this.socketRotationTimers.delete(socket);
      if (lane.socket !== socket) return;
      if (this.activeSessions.has(lane.sessionId)) {
        this.expiredSockets.add(socket);
        return;
      }
      socket.close();
      this.invalidateLaneConnection(lane, socket);
    }, this.socketLifetimeMs);
    timer.unref?.();
    this.socketRotationTimers.set(socket, timer);
  }

  private ensureSocket(lane: LaneState, accessToken: string): StatefulResponsesSocket {
    if (lane.socket && lane.socketToken === accessToken && !this.expiredSockets.has(lane.socket)) return lane.socket;
    lane.socket?.close();
    this.invalidateLaneConnection(lane);

    const socket = this.socketFactory(accessToken);
    lane.socket = socket;
    lane.socketToken = accessToken;
    lane.previousResponseId = undefined;
    lane.needsBootstrap = true;
    socket.onClose(() => this.invalidateLaneConnection(lane, socket));
    this.scheduleRotation(lane, socket);
    return socket;
  }

  private async run(options: StatefulResponseOptions): Promise<StatefulResponseResult> {
    options = withHistoryTool(options);
    const lane = await this.loadLane(options.sessionId, options.model, options.ephemeral === true);
    if (lane.pendingDeliveryItems) throw new Error("Previous reply delivery has not been settled.");
    if (!lane.startedAt) {
      const first = options.history?.count ? (await options.history.readRange(0, 1))[0] : undefined;
      lane.startedAt = first?.at && Number.isFinite(Date.parse(first.at)) ? first.at : this.now().toISOString();
    }

    const controlChanged = Boolean(options.context?.controlRevision && lane.controlRevision &&
      options.context.controlRevision !== lane.controlRevision);
    if (controlChanged) {
      // A previous_response_id or opaque compaction may still contain deleted
      // Core/Persona instructions. Rebuilding on an explicit control change
      // prevents stale opaque instructions from silently overriding new policy.
      // Ordinary Recent directory changes are never a rebase trigger.
      await this.store.archive(lane.sessionId, { version: 2, sessionId: lane.sessionId,
        model: lane.model, contextItems: lane.contextItems, historyCursor: lane.historyCursor,
        controlRevision: lane.controlRevision, contextRevision: lane.contextRevision,
        startedAt: lane.startedAt, lastCompactedAt: lane.lastCompactedAt,
        checkpoint: lane.checkpoint }, "control-change");
      const coldHistory = options.history ? await readRecoveryHistoryWindow(options.history) : undefined;
      if (coldHistory?.truncated) {
        console.error("[runtime-recovery-degraded] explicit Core/Persona change requires a " +
          "checkpoint-free transcript; cold-start safety budget truncated older messages. " +
          "Original SQLite records and archived checkpoint remain available. session=" + options.sessionId);
      }
      const transcript = coldHistory
        ? await transcriptItems(coldHistory.messages, options.timezone)
        : options.messages.length > 1
          ? await transcriptItems(options.messages.slice(0, -1), options.timezone)
          : lane.contextItems.filter(item => item.role === "user" || item.role === "assistant");
      const toolEvidence = unresolvedToolItems(lane.contextItems);
      lane.socket?.close();
      this.invalidateLaneConnection(lane);
      lane.contextItems = [...transcript, ...toolEvidence];
      lane.historyCursor = options.history?.count;
      lane.attachmentCursor = options.history?.count;
      lane.coverageVerified = true;
      lane.controlRevision = options.context!.controlRevision;
      lane.contextRevision = options.context!.contextRevision;
      lane.checkpoint = undefined;
      lane.needsWindowRebase = false;
      lane.needsBootstrap = true;
      console.error("[runtime-context] session=" + options.sessionId +
        " rebase=control-revision" +
        " retained_tool_items=" + toolEvidence.length);
    }

    // One-time migration from old in-input Persona prompts. An open SIWC chain
    // cannot surgically remove its earlier developer items. Only rebase when
    // planRecovery confirms the durable transcript can replace the checkpoint
    // without discarding opaque compaction, unresolved tools or rich media.
    if (lane.contextItems.some(isLegacyPersonaInput)) {
      const migration = await planRecovery(lane.contextItems, options.history
        ? () => options.history!.readRange(0, options.history!.count)
        : options.messages.slice(0, -1), options.timezone);
      // Even when opaque compaction, unresolved tools or media require the
      // checkpoint, we can remove visible legacy Persona developer items while
      // retaining that evidence. Encrypted compaction itself stays untouched.
      lane.socket?.close();
      this.invalidateLaneConnection(lane);
      if (migration.recoverySource === "transcript") {
        lane.contextItems = [];
        lane.historyCursor = undefined;
      } else {
        lane.contextItems = lane.contextItems.filter(item => !isLegacyPersonaInput(item));
      }
      lane.controlRevision = undefined;
      lane.contextRevision = undefined;
      lane.needsBootstrap = true;
      await this.persistLane(lane);
    }
    const weeklyDue = !lane.ephemeral &&
      sevenDayCompactionDue(lane.startedAt, lane.lastCompactedAt, this.now().getTime());
    let explicitlyCompacted = false;
    // Standalone compaction works on a settled local window only. If SIWC plan
    // credentials reject /responses/compact, the ordinary next response uses a
    // lower server-side threshold. No paid Provider or fake checkpoint is used.
    if (weeklyDue && lane.previousResponseId && lane.contextItems.length &&
      !hasUnresolvedToolEvidence(lane.contextItems) &&
      (!options.history || options.history.count === lane.historyCursor)) {
      let compactedItems: Record<string, unknown>[] | undefined;
      try {
        compactedItems = await this.compactContext(options.accessToken, options.model, lane.contextItems);
      } catch (error) {
        const status = (error && typeof error === "object" && "status" in error)
          ? String((error as { status: unknown }).status) : "unsupported-or-unavailable";
        console.error("[siwc-compaction] standalone attempt did not produce a checkpoint; " +
          "will try in-response compaction, status=" + status);
      }
      if (compactedItems) {
        const at = this.now().toISOString();
        const checkpoint = checkpointFromItems(lane.sessionId, options.model, compactedItems,
          lane.historyCursor ?? 0, "seven_days", at);
        const before = { items: lane.contextItems, checkpoint: lane.checkpoint,
          lastCompactedAt: lane.lastCompactedAt };
        lane.contextItems = compactedItems;
        lane.checkpoint = checkpoint;
        lane.lastCompactedAt = at;
        try {
          await this.persistLane(lane);
        } catch (error) {
          lane.contextItems = before.items;
          lane.checkpoint = before.checkpoint;
          lane.lastCompactedAt = before.lastCompactedAt;
          throw error;
        }
        lane.socket?.close();
        this.invalidateLaneConnection(lane);
        explicitlyCompacted = true;
      }
    }
    const preTurnState = {
      model: lane.model,
      startedAt: lane.startedAt,
      lastCompactedAt: lane.lastCompactedAt,
      checkpoint: lane.checkpoint,
      controlRevision: lane.controlRevision,
      contextRevision: lane.contextRevision,
      contextItems: [...lane.contextItems],
      historyCursor: lane.historyCursor,
      attachmentCursor: lane.attachmentCursor,
      coverageVerified: lane.coverageVerified,
    };
    // Reads and local unpaid intents are safe to replay after a failed model
    // continuation; writes and unknown tools are potentially irreversible.
    let unsafeToolInvocationStarted = false;
    const captureTraceContent = Boolean(options.trace && options.trace.captureContent !== false);
    const replayableTools = new Set((options.tools ?? []).filter((tool) => tool.readOnly === true || tool.replaySafe === true).map((tool) => tool.name));
    let socket = this.ensureSocket(lane, options.accessToken);
    const tools = responseTools(options.tools ?? []);
    const currentUser = await currentUserItem(options.messages,
      options.attachments ?? options.messages.at(-1)?.attachments ?? [], options.timezone);
    const input: Record<string, unknown>[] = [];

    const recovering = lane.previousResponseId === undefined;
    const checkpointCandidate = recovering ? [...lane.contextItems] : [];
    const checkpointNeeded = checkpointCandidate.length > 0 &&
      (hasCompaction(checkpointCandidate) || hasUnresolvedToolEvidence(checkpointCandidate));
    // On v1 legacy checkpoints the coverage cursor was only a pre-turn marker,
    // not an acknowledged message sequence. Never treat it as a verified delta
    // cursor; wait for a new delivery to establish a reliable v2 boundary.
    const verifiedCursor = lane.coverageVerified === false ? undefined : lane.historyCursor;
    const replayStart = recovering && !checkpointNeeded ? 0
      : verifiedCursor ?? options.history?.count ?? 0;
    const window = options.history
      ? await readRecoveryHistoryWindow(options.history, replayStart)
      : undefined;
    if (window && recovering) {
      console.error("[runtime-history-recovery] session=" + options.sessionId +
        " start_seq=" + replayStart + " retained=" + window.messages.length +
        " total=" + window.totalMessages + " estimated_tokens=" + window.estimatedTokens +
        " degraded=" + window.truncated);
    }
    const recovery = recovering ? await planRecovery(checkpointCandidate,
      checkpointNeeded ? [] : window?.messages ?? options.messages.slice(0, -1), options.timezone)
      : { checkpointDisposition: "none" as const, recoverySource: "none" as const, recoveryItems: [] };
    const { checkpointDisposition, recoverySource, recoveryItems } = recovery;
    input.push(...recoveryItems);
    if (options.history) {
      const count = options.history.count;
      if (lane.historyCursor !== undefined && lane.historyCursor > count) throw new Error("Session transcript moved behind its runtime cursor; refusing unsafe continuation.");
      if (recoverySource !== "transcript" && verifiedCursor !== undefined &&
          count > (recovering && !checkpointNeeded ? verifiedCursor : replayStart)) {
        // Exactly the SQLite messages not yet represented by this checkpoint or
        // open model chain. This also covers intervening turns on another model.
        const deltaStart = recovering && !checkpointNeeded ? verifiedCursor : replayStart;
        input.push(...await transcriptItems(deltaStart === replayStart ? window!.messages
          : (await readRecoveryHistoryWindow(options.history, deltaStart)).messages, options.timezone));
      } else if (recovering && recoverySource === "checkpoint" && verifiedCursor === undefined && count) {
        console.error("[runtime-recovery-degraded] legacy checkpoint has no verified cursor; " +
          "not replaying an ambiguous overlap; SQLite history remains searchable.");
      }
      if (!recovering) {
        // Assistant image/file bytes can arrive after the model response through
        // a separate delivery path. The text is covered at acknowledgement,
        // but these historical media bytes still need one injection.
        const from = lane.attachmentCursor ?? lane.historyCursor ?? 0;
        // Entries after the verified cursor were already replayed as delta
        // transcript above; adding their media again would double inject it.
        const to = Math.min(count, verifiedCursor ?? count);
        for (let start = from; start < to; start += 128) {
          const delta = await options.history.readRange(start, Math.min(128, to - start));
          for (const message of delta) if (message.role === "assistant" && message.attachments?.length) {
            input.push(...await historicalAttachmentItems(message, options.timezone));
          }
        }
      }
      lane.attachmentCursor = count;
      lane.historyCursor = count;
    }
    const recoveryInputItemCount = recoveryItems.length;

    if ((recovering || lane.needsBootstrap || controlChanged) && options.instructions) {
      const resetVoicePreference = recovering && options.resetVoicePreferenceOnReconnect
        ? "\nTelegram 回复形式已重置为默认偏好；历史消息中的临时文字回复要求不再延续。"
        : "";
      input.push(bootstrapPolicyItem(options.instructions + resetVoicePreference));
    }
    if (options.context && (recovering || lane.needsBootstrap || controlChanged)) {
      const live = liveContextItem(options.context);
      if (live) input.push(live);
    }
    // Per-response instructions are not inherited through previous_response_id.
    // Never append Persona or temporal instructions to replayable chat input.
    input.push(currentUser);

    if (recovering) {
      logRecoveryBreakdown(
        options.sessionId,
        options.model,
        recoverySource,
        checkpointDisposition,
        checkpointCandidate,
        recoveryItems,
        input,
        tools,
      );
    }

    const usage = emptyUsage();
    let compacted = explicitlyCompacted;
    let toolRounds = 0;
    let previousResponseId = lane.previousResponseId;
    let nextInput = input;
    let continuationRecoveryUsed = false;
    if (recovering) {
      // Rebuild the local checkpoint from the selected safe recovery source.
      // Completed tool/reasoning history is represented by the durable transcript;
      // Compaction, unresolved tool evidence or legacy media keeps the checkpoint.
      lane.contextItems = [...input];
    } else {
      lane.contextItems.push(...input);
    }
    // Persist the revisions alongside the input, including turns which fail
    // after a write. Otherwise a first-turn deletion followed by a transport
    // failure would leave an unversioned stale checkpoint on disk.
    if (options.context) {
      lane.controlRevision = options.context.controlRevision;
      lane.contextRevision = options.context.contextRevision;
    }
    let recoverableItems = [...lane.contextItems];

    try {
      // Preserve the new user input even if the process exits during generation.
      await this.persistLane(lane);
      let stepIndex = 0;
      let maxWorkingTokens = 0;
      for (;;) {
        stepIndex += 1;
        const usedPreviousResponseId = Boolean(previousResponseId);
        const stepInputItems = nextInput.length;
        let completed: { response: ResponseSnapshot; retries: number; traceStepId?: string };
        try {
          completed = await this.transport.completedResponseWithRetry(socket, {
            type: "response.create",
            model: options.model,
            input: nextInput,
            ...(options.turnInstructions?.trim() ? { instructions: options.turnInstructions.trim() } : {}),
            store: false,
            include: ["reasoning.encrypted_content"],
            prompt_cache_key: createHash("sha256").update(options.sessionId).digest("hex").slice(0, 32),
            ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
            ...(tools.length ? { tools, parallel_tool_calls: false } : {}),
            context_management: [{
              type: "compaction",
              compact_threshold: weeklyDue && !explicitlyCompacted
                ? SIWC_WEEKLY_COMPACT_TOKENS : compactThresholdForModel(options.model),
            }],
          }, options.trace);
        } catch (error) {
          if (
            previousResponseId &&
            (isMissingPreviousResponseError(error) || isRetryableTransportError(error)) &&
            !continuationRecoveryUsed &&
            !unsafeToolInvocationStarted
          ) {
            // A failed WebSocket continuation may have evicted its parent.
            // Build a new chain using the complete retained input/output context
            // and previously recorded tool results (without executing them again).
            // This branch is forbidden after any possibly mutating tool.
            continuationRecoveryUsed = true;
            console.error("[runtime] failed previous response continuation; rebuilding from local context session=" +
              options.sessionId + " items=" + lane.contextItems.length +
              " missing_parent=" + isMissingPreviousResponseError(error));
            socket.close();
            this.invalidateLaneConnection(lane, socket);
            socket = this.ensureSocket(lane, options.accessToken);
            previousResponseId = undefined;
            nextInput = [...lane.contextItems];
            continue;
          }
          throw error;
        }
        const { response, retries, traceStepId } = completed;

        if (typeof response.id !== "string" || !response.id) {
          throw new Error("Responses WebSocket returned no response id.");
        }
        addUsage(usage, response.usage);
        let output = Array.isArray(response.output)
          ? response.output.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          : [];
        const stepInputTokens = Number(response.usage?.input_tokens ?? 0) || 0;
        const stepInputDetails = response.usage?.input_tokens_details as Record<string, unknown> | undefined;
        const stepCachedTokens = Number(stepInputDetails?.cached_tokens ?? 0) || 0;
        const stepOutputTokens = Number(response.usage?.output_tokens ?? 0) || 0;
        maxWorkingTokens = Math.max(maxWorkingTokens, stepInputTokens + stepOutputTokens);
        const stepCompacted = hasCompaction(output);
        console.error(
          "[runtime-step] session=" + options.sessionId +
          " model=" + options.model +
          " step=" + stepIndex +
          " input=" + stepInputTokens +
          " cached=" + stepCachedTokens +
          " output=" + stepOutputTokens +
          " previous=" + usedPreviousResponseId +
          " recovering=" + (recovering && !usedPreviousResponseId) +
          " recovery_source=" + (usedPreviousResponseId ? "none" : recoverySource) +
          " recovery_items=" + (usedPreviousResponseId ? 0 : recoveryInputItemCount) +
          " request_items=" + stepInputItems +
          " context_items=" + lane.contextItems.length +
          " retries=" + retries +
          " compacted=" + stepCompacted +
          " threshold=" + (weeklyDue && !explicitlyCompacted
            ? SIWC_WEEKLY_COMPACT_TOKENS : compactThresholdForModel(options.model)),
        );

        const calls = callsFrom(output);
        let text = "";
        if (!calls.length) {
          text = textFrom(output).trim() ||
            (typeof response.output_text === "string" ? response.output_text.trim() : "") ||
            response.streamedText?.trim() || "";
          const verifiedText = blockTextualToolCall(text,(options.tools??[]).map(tool=>tool.name),"siwc");
          const finalized = options.finalizeReplyText?.(verifiedText) ?? verifiedText;
          if (finalized !== text) output = replaceVisibleReplyText(output, finalized);
          text = finalized;
        }
        lane.contextItems.push(...output);
        if (stepCompacted) {
          lane.contextItems = pruneToLatestCompaction(lane.contextItems);
          const at = this.now().toISOString();
          lane.checkpoint = checkpointFromItems(lane.sessionId, options.model, lane.contextItems,
            lane.historyCursor ?? 0, weeklyDue ? "seven_days" : "capacity", at);
          lane.lastCompactedAt = at;
          compacted = true;
          lane.needsBootstrap = true;
        }

        previousResponseId = response.id;
        lane.previousResponseId = response.id;

        if (!calls.length) {
          const replySegments = options.getPreparedReplySegments?.();
          const voiceText = options.getPreparedVoice?.();
          const voiceInstruction = voiceText ? options.getPreparedVoiceInstruction?.() : undefined;
          const nativeReply = options.getPreparedNativeReply?.();
          if (!text && !voiceText && !replySegments?.length) {
            const outputTypes = output.map((item) => String(item.type ?? "unknown")).join(",") || "none";
            throw new Error(
              "Responses WebSocket completed without a final text response (output types: " + outputTypes + ").",
            );
          }
          lane.model = options.model;
          if (options.context) {
            lane.controlRevision = options.context.controlRevision;
            lane.contextRevision = options.context.contextRevision;
          }
          if (!compacted) lane.needsBootstrap = false;
          if (options.deferAssistantCommit) {
            lane.pendingDeliveryItems = recoverableItems;
            lane.pendingDeliveryId = options.deliveryId;
            const rollbackCheckpoint = checkpointMatches(recoverableItems, lane.checkpoint)
              ? lane.checkpoint : checkpointMatches(recoverableItems, preTurnState.checkpoint)
                ? preTurnState.checkpoint : undefined;
            lane.pendingDeliveryCheckpoint = rollbackCheckpoint;
            lane.pendingDeliveryLastCompactedAt = rollbackCheckpoint?.at ?? preTurnState.lastCompactedAt;
          }
          await this.persistLane(lane);
          console.error(
            "[runtime] session=" + options.sessionId +
            " model=" + options.model +
            " turn_input_total=" + usage.inputTokens +
            " turn_cached_total=" + usage.cachedInputTokens +
            " turn_output_total=" + usage.outputTokens +
            " steps=" + stepIndex +
            " recovering=" + recovering +
            " recovery_source=" + recoverySource +
            " recovery_items=" + recoveryInputItemCount +
            " compacted=" + compacted +
            " max_working_tokens=" + maxWorkingTokens +
            " threshold=" + compactThresholdForModel(options.model),
          );
          return { text, usage, compacted,
            ...(replySegments ? {replySegments} : {}),
            ...(lane.checkpoint ? { compaction: lane.checkpoint } : {}),
            ...(voiceText ? {voiceText} : {}), ...(voiceInstruction ? {voiceInstruction} : {}),
            ...(nativeReply ? { nativeReply } : {}) };
        }

        if (!options.executeTool) throw new Error("Model requested a tool but no tool executor is configured.");
        if (options.maxToolRounds && options.maxToolRounds > 0 && toolRounds >= options.maxToolRounds) {
          throw new Error("Gateway tool loop exceeded the configured maximum number of rounds.");
        }

        const outputs: Record<string, unknown>[] = [];
        if (calls.some((call) => call.namespace && call.namespace !== "gateway")) {
          throw new Error("Unexpected tool namespace.");
        }
        // Persist uncertainty before invoking a tool: a process failure must not
        // make a possibly completed write look as though it was never attempted.
        for (const call of calls) {
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output: JSON.stringify({ error: "工具调用结果未确认；可能已经生效。重新执行写操作前，先回读目标并对账，不能盲目重试。" }),
          });
        }
        const toolPrefix = [...lane.contextItems];
        const recordToolResults = async () => {
          lane.contextItems = [...toolPrefix, ...outputs];
          recoverableItems = [...lane.contextItems];
          await this.persistLane(lane);
        };
        await recordToolResults();
        let outputCursor = 0;
        const recordTextUntil = (end: number) => {
          for (; outputCursor < end; outputCursor++) {
            const item = output[outputCursor]!;
            const value = textFrom([item]);
            if (value) options.recordReplyText?.(blockTextualToolCall(value,(options.tools??[]).map(t=>t.name),"siwc"), response.id + ":" + outputCursor);
          }
        };
        for (const [index, call] of calls.entries()) {
          recordTextUntil(output.findIndex(item=>item.type === "function_call" && item.call_id === call.call_id));
          let args: Record<string, unknown>;
          try {
            const parsed = JSON.parse(call.arguments) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            args = parsed as Record<string, unknown>;
          } catch {
            outputs[index] = {
              type: "function_call_output",
              call_id: call.call_id,
              output: JSON.stringify({ error: "工具参数不是有效的 JSON 对象。" }),
            };
            const rejected = safeTraceStart(options.trace, { kind: "system", name: "tool_rejected", parentId: traceStepId,
              input: captureTraceContent ? { name: call.name, arguments: call.arguments } : undefined });
            safeTraceFinish(options.trace, rejected, { status: "failed", error: "工具参数不是有效的 JSON 对象。" });
            await recordToolResults();
            continue;
          }

          const toolTrace = safeTraceStart(options.trace, { kind: "tool", name: call.name, provider: "siwc", parentId: traceStepId, input: captureTraceContent ? args : undefined });
          try {
            if (!replayableTools.has(call.name)) unsafeToolInvocationStarted = true;
            const outputValue = await options.executeTool(call.name, args);
            outputs[index] = {
              type: "function_call_output",
              call_id: call.call_id,
              output: safeToolOutput(outputValue),
            };
            safeTraceFinish(options.trace, toolTrace, { status: tracedToolStatus(outputValue), output: captureTraceContent ? outputValue : undefined });
          } catch (error) {
            safeTraceFinish(options.trace, toolTrace, { status: "failed", error: error instanceof Error ? error.message : String(error) });
            outputs[index] = {
              type: "function_call_output",
              call_id: call.call_id,
              output: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            };
          }
          await recordToolResults();
        }

        nextInput = outputs;
        recordTextUntil(output.length);
        toolRounds += 1;
      }
    } catch (error) {
      // The owner may retry terminal model failures only before irreversible
      // effects. Automatic transport retries remain limited to transient errors.
      const manuallyReplayable = !unsafeToolInvocationStarted && !hasUnresolvedToolEvidence(preTurnState.contextItems);
      const replayableInbound =
        (isRetryableTransportError(error) || isSubscriptionUsageLimitError(error)) && manuallyReplayable;
      if (manuallyReplayable && !compacted) {
        lane.model = preTurnState.model;
        lane.startedAt = preTurnState.startedAt;
        lane.lastCompactedAt = preTurnState.lastCompactedAt;
        lane.checkpoint = preTurnState.checkpoint;
        lane.controlRevision = preTurnState.controlRevision;
        lane.contextRevision = preTurnState.contextRevision;
        lane.contextItems = [...preTurnState.contextItems];
        lane.historyCursor = preTurnState.historyCursor;
        lane.attachmentCursor = preTurnState.attachmentCursor;
        lane.coverageVerified = preTurnState.coverageVerified;
      } else {
        lane.contextItems = recoverableItems;
      }
      lane.pendingDeliveryItems = undefined;
      lane.pendingDeliveryCheckpoint = undefined;
      lane.pendingDeliveryLastCompactedAt = undefined;
      socket.close();
      this.invalidateLaneConnection(lane, socket);
      lane.previousResponseId = undefined;
      lane.needsBootstrap = true;
      lane.contextItems = pruneToLatestCompaction(lane.contextItems);
      await this.persistLane(lane).catch(() => undefined);
      throw tagInboundRetryability(error, replayableInbound, manuallyReplayable);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> { return this.operations.run(operation); }

  reply(options: StatefulResponseOptions): Promise<StatefulResponseResult> {
    return this.enqueue(async () => {
      this.activeSessions.add(options.sessionId);
      try {
        return await this.run(options);
      } finally {
        this.activeSessions.delete(options.sessionId);
        const lane = this.lanes.get(options.sessionId);
        const socket = lane?.socket;
        if (socket && this.expiredSockets.has(socket)) {
          socket.close();
          this.invalidateLaneConnection(lane!, socket);
        }
      }
    });
  }

  commitSession(sessionId: string, _deliveredText: string, deliveryId?: string): Promise<void | boolean> {
    return this.enqueue(async () => {
      const lane = this.lanes.get(sessionId);
      if (lane?.pendingDeliveryItems) {
        if (lane.pendingDeliveryId !== deliveryId) return false;
        if (lane.pendingRecoveryWithoutPrepared) {
          lane.contextItems.push({ role: "assistant", content: _deliveredText });
          lane.pendingRecoveryWithoutPrepared = false;
        }
        lane.pendingDeliveryItems = undefined;
        lane.pendingDeliveryId = undefined;
        lane.pendingDeliveryCheckpoint = undefined;
        lane.pendingDeliveryLastCompactedAt = undefined;
        if (lane.historyCursor !== undefined) {
          // Gateway first appends exactly one user message, then an acknowledged
          // assistant delivery. Only now are both covered by the live chain.
          lane.historyCursor += 2;
          lane.coverageVerified = true;
          if (lane.checkpoint) lane.checkpoint = { ...lane.checkpoint, coveredThroughSeq: lane.historyCursor };
        }
        await this.persistLane(lane);
      } else if (!lane) {
        // A prepared Telegram reply can be delivered after process restart.
        const saved = await this.store.read(sessionId);
        if (saved && Array.isArray(saved.contextItems)) {
          if (saved.pendingDeliveryId !== deliveryId) return false;
          if (saved.pendingPreparedItems) {
            saved.contextItems = saved.pendingPreparedItems;
            saved.checkpoint = saved.pendingPreparedCheckpoint ?? saved.checkpoint;
            saved.lastCompactedAt = saved.pendingPreparedLastCompactedAt ?? saved.lastCompactedAt;
          } else {
            saved.contextItems.push({ role: "assistant", content: _deliveredText });
          }
          delete saved.pendingDeliveryId;
          delete saved.pendingDeliveryItems;
          delete saved.pendingDeliveryCheckpoint;
          delete saved.pendingDeliveryLastCompactedAt;
          delete saved.pendingPreparedItems;
          delete saved.pendingPreparedCheckpoint;
          delete saved.pendingPreparedLastCompactedAt;
          if (saved.version === 2 && saved.historyCursor !== undefined) {
            saved.historyCursor += 2;
            saved.coverageVerified = true;
            if (saved.checkpoint) saved.checkpoint.coveredThroughSeq = saved.historyCursor;
          }
          // v1 stored only the pre-delivery context, not the completed model
          // output. Its delivered message is recovered from SQLite once.
          await this.store.write(sessionId, saved);
        }
      }
    });
  }

  resetSession(sessionId: string, deliveryId?: string): Promise<void | boolean> {
    return this.enqueue(async () => {
      const lane = this.lanes.get(sessionId);
      if (deliveryId && lane && (!lane.pendingDeliveryItems || lane.pendingDeliveryId !== deliveryId)) return false;
      lane?.socket?.close();
      if (lane?.pendingDeliveryItems) {
        lane.contextItems = lane.pendingDeliveryItems;
        lane.checkpoint = lane.pendingDeliveryCheckpoint;
        lane.lastCompactedAt = lane.pendingDeliveryLastCompactedAt;
        lane.pendingDeliveryItems = undefined;
        lane.pendingDeliveryId = undefined;
        lane.pendingDeliveryCheckpoint = undefined;
        lane.pendingDeliveryLastCompactedAt = undefined;
        this.invalidateLaneConnection(lane);
        await this.persistLane(lane);
      } else if (lane) {
        this.lanes.delete(sessionId);
        if (!lane.ephemeral) {
          await this.store.archive(sessionId, { version: 2, sessionId, model: lane.model,
            contextItems: lane.contextItems, historyCursor: lane.historyCursor,
            controlRevision: lane.controlRevision, contextRevision: lane.contextRevision,
            startedAt: lane.startedAt, lastCompactedAt: lane.lastCompactedAt,
            checkpoint: lane.checkpoint }, "explicit-reset");
          await this.store.remove(sessionId);
        }
      }
      if (!lane && deliveryId) {
        const saved = await this.store.read(sessionId);
        if (saved?.pendingDeliveryId === deliveryId) {
          if (saved.pendingDeliveryItems) {
            saved.contextItems = saved.pendingDeliveryItems;
            saved.checkpoint = saved.pendingDeliveryCheckpoint;
            saved.lastCompactedAt = saved.pendingDeliveryLastCompactedAt;
          }
          delete saved.pendingDeliveryId;
          delete saved.pendingDeliveryItems;
          delete saved.pendingDeliveryCheckpoint;
          delete saved.pendingDeliveryLastCompactedAt;
          delete saved.pendingPreparedItems;
          delete saved.pendingPreparedCheckpoint;
          delete saved.pendingPreparedLastCompactedAt;
          await this.store.write(sessionId, saved);
        }
      }
      // With no live lane, disk already contains the pre-delivery checkpoint.
    });
  }

  async close(): Promise<void> {
    await this.operations.drain();
    for (const lane of this.lanes.values()) {
      const socket = lane.socket;
      if (socket) socket.close();
      this.invalidateLaneConnection(lane);
    }
    for (const timer of this.socketRotationTimers.values()) clearTimeout(timer);
    this.socketRotationTimers.clear();
    this.expiredSockets.clear();
  }
}
