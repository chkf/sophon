import type { ChatMessage } from "../types.js";
import { hasCompaction, hasUnresolvedToolEvidence, hasUnreconstructedMedia, transcriptItems } from "./responses-codec.js";
export async function planRecovery(checkpoint: Record<string, unknown>[], messages: ChatMessage[] | (() => Promise<ChatMessage[]>), timezone = "UTC") {
  const opaqueRequired = checkpoint.length > 0 && (hasCompaction(checkpoint) || hasUnresolvedToolEvidence(checkpoint));
  const transcript = opaqueRequired ? [] : await transcriptItems(typeof messages === "function" ? await messages() : messages, timezone);
  if (checkpoint.length > 0 && (opaqueRequired || hasUnreconstructedMedia(checkpoint, transcript) || !transcript.length)) {
    return { checkpointDisposition: "used" as const, recoverySource: "checkpoint" as const, recoveryItems: checkpoint };
  }
  return { checkpointDisposition: checkpoint.length ? "replaced_by_transcript" as const : "none" as const,
    recoverySource: transcript.length ? "transcript" as const : "none" as const, recoveryItems: transcript };
}
