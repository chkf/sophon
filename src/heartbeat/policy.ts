import type { ReplySegment } from "../runtime/reply-segments.js";
import { dateKey, isQuietTime } from "../util/clock-window.js";
export { dateKey, isQuietTime } from "../util/clock-window.js";
import type { RuntimeImage } from "../runtime/types.js";
import { createHash } from "node:crypto";
import type { ChannelName } from "../channels/types.js";
import type { DailyWakePlan } from "./planner.js";

export interface HeartbeatPolicyConfig {
  timezone: string;
  quietStart: string;
  quietEnd: string;
  cooldownMinutes: number;
  dailyCap: number;
}

export interface HeartbeatPendingSend {
  /** Optional local observation link; never a delivery authorization. */
  traceId?: string;
  replySegments?: ReplySegment[];
  voiceText?: string;
  voiceInstruction?: string;
  images?: RuntimeImage[];
  stickerIndex?: number;
  fingerprint: string;
  text: string;
  target: string;
  channel?: ChannelName;
  at: string;
}

export interface HeartbeatState {
  dateKey: string;
  sentToday: number;
  lastSentAt?: string;
  nextCheckAt?: string;
  planAttemptAt?: string;
  plan?: DailyWakePlan;
  pending?: HeartbeatPendingSend;
  recent: Array<{ fingerprint: string; at: string; text?: string }>;
}

function latestTimestamp(...values: Array<string | undefined>): string | undefined {
  let latest: { value: string; time: number } | undefined;
  for (const value of values) {
    if (!value) continue;
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) continue;
    if (!latest || time > latest.time) latest = { value, time };
  }
  return latest?.value;
}

export function heartbeatFingerprint(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function heartbeatEligible(
  now: Date,
  config: HeartbeatPolicyConfig,
  state: HeartbeatState,
  lastConversationAt?: string,
): { eligible: boolean; reason?: string } {
  if (config.dailyCap <= 0) return { eligible: false, reason: "daily-cap-disabled" };
  if (isQuietTime(now, config.timezone, config.quietStart, config.quietEnd)) {
    return { eligible: false, reason: "quiet-hours" };
  }
  if (state.dateKey === dateKey(now, config.timezone) && state.sentToday >= config.dailyCap) {
    return { eligible: false, reason: "daily-cap" };
  }

  const lastActivityAt = latestTimestamp(lastConversationAt, state.lastSentAt);
  if (lastActivityAt && config.cooldownMinutes > 0) {
    const elapsed = now.getTime() - new Date(lastActivityAt).getTime();
    if (elapsed < config.cooldownMinutes * 60_000) return { eligible: false, reason: "cooldown" };
  }
  return { eligible: true };
}
