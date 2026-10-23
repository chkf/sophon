import { Buffer } from "node:buffer";
export interface ContextPayloadSummary {
  items: number;
  rawJsonBytes: number;
  structuralJsonBytes: number;
  userItems: number;
  userTextChars: number;
  userTextBytes: number;
  assistantItems: number;
  assistantTextChars: number;
  assistantTextBytes: number;
  developerItems: number;
  developerTextChars: number;
  developerTextBytes: number;
  reasoningItems: number;
  reasoningEncryptedBytes: number;
  functionCallItems: number;
  functionCallArgumentBytes: number;
  functionOutputItems: number;
  functionOutputBytes: number;
  compactionItems: number;
  compactionEncryptedBytes: number;
  webSearchItems: number;
  otherItems: number;
  imageParts: number;
  imagePayloadBytes: number;
  fileParts: number;
  filePayloadBytes: number;
}

function decodedDataUrlBytes(value: string): number {
  if (!value.startsWith("data:")) return 0;
  const comma = value.indexOf(",");
  if (comma < 0) return 0;
  const metadata = value.slice(0, comma);
  const payload = value.slice(comma + 1);
  if (!metadata.includes(";base64")) return Buffer.byteLength(payload, "utf8");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
}

function textCharsFromContent(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const value = part as Record<string, unknown>;
    if (
      (value.type === "input_text" || value.type === "output_text") &&
      typeof value.text === "string"
    ) {
      chars += value.text.length;
    }
  }
  return chars;
}

function scanMedia(value: unknown, summary: ContextPayloadSummary): void {
  if (Array.isArray(value)) {
    for (const item of value) scanMedia(item, summary);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "input_image" && typeof record.image_url === "string") {
    summary.imageParts += 1;
    summary.imagePayloadBytes += decodedDataUrlBytes(record.image_url);
  }
  if (record.type === "input_file" && typeof record.file_data === "string") {
    summary.fileParts += 1;
    summary.filePayloadBytes += decodedDataUrlBytes(record.file_data);
  }
  for (const child of Object.values(record)) scanMedia(child, summary);
}

function structuralJsonBytes(item: Record<string, unknown>): number {
  const text = JSON.stringify(item, (key, value) => {
    if (
      (key === "image_url" || key === "file_data") &&
      typeof value === "string" &&
      value.startsWith("data:")
    ) {
      return "<binary-payload>";
    }
    return value;
  }) ?? "";
  return Buffer.byteLength(text, "utf8");
}

export function summarizeContextItems(items: Record<string, unknown>[]): ContextPayloadSummary {
  const summary: ContextPayloadSummary = {
    items: items.length,
    rawJsonBytes: 0,
    structuralJsonBytes: 0,
    userItems: 0,
    userTextChars: 0,
    userTextBytes: 0,
    assistantItems: 0,
    assistantTextChars: 0,
    assistantTextBytes: 0,
    developerItems: 0,
    developerTextChars: 0,
    developerTextBytes: 0,
    reasoningItems: 0,
    reasoningEncryptedBytes: 0,
    functionCallItems: 0,
    functionCallArgumentBytes: 0,
    functionOutputItems: 0,
    functionOutputBytes: 0,
    compactionItems: 0,
    compactionEncryptedBytes: 0,
    webSearchItems: 0,
    otherItems: 0,
    imageParts: 0,
    imagePayloadBytes: 0,
    fileParts: 0,
    filePayloadBytes: 0,
  };

  for (const item of items) {
    const raw = JSON.stringify(item) ?? "";
    summary.rawJsonBytes += Buffer.byteLength(raw, "utf8");
    summary.structuralJsonBytes += structuralJsonBytes(item);
    scanMedia(item, summary);

    const role = typeof item.role === "string" ? item.role : "";
    const type = typeof item.type === "string" ? item.type : "";
    const textChars = textCharsFromContent(item.content);

    if (role === "user") {
      summary.userItems += 1;
      summary.userTextChars += textChars;
      summary.userTextBytes += Buffer.byteLength(
        typeof item.content === "string" ? item.content : JSON.stringify(item.content) ?? "",
        "utf8",
      );
    } else if (role === "assistant" || (type === "message" && role === "assistant")) {
      summary.assistantItems += 1;
      summary.assistantTextChars += textChars;
      summary.assistantTextBytes += Buffer.byteLength(
        typeof item.content === "string" ? item.content : JSON.stringify(item.content) ?? "",
        "utf8",
      );
    } else if (role === "developer") {
      summary.developerItems += 1;
      summary.developerTextChars += textChars;
      summary.developerTextBytes += Buffer.byteLength(
        typeof item.content === "string" ? item.content : JSON.stringify(item.content) ?? "",
        "utf8",
      );
    } else if (type === "reasoning") {
      summary.reasoningItems += 1;
      if (typeof item.encrypted_content === "string") {
        summary.reasoningEncryptedBytes += Buffer.byteLength(item.encrypted_content, "utf8");
      }
    } else if (type === "function_call") {
      summary.functionCallItems += 1;
      if (typeof item.arguments === "string") {
        summary.functionCallArgumentBytes += Buffer.byteLength(item.arguments, "utf8");
      }
    } else if (type === "function_call_output") {
      summary.functionOutputItems += 1;
      if (typeof item.output === "string") {
        summary.functionOutputBytes += Buffer.byteLength(item.output, "utf8");
      }
    } else if (type === "compaction") {
      summary.compactionItems += 1;
      if (typeof item.encrypted_content === "string") {
        summary.compactionEncryptedBytes += Buffer.byteLength(item.encrypted_content, "utf8");
      }
    } else if (type === "web_search_call") {
      summary.webSearchItems += 1;
    } else {
      summary.otherItems += 1;
    }
  }
  return summary;
}

export function logRecoveryBreakdown(
  sessionId: string,
  model: string,
  source: "none" | "checkpoint" | "transcript",
  checkpointDisposition: "none" | "used" | "replaced_by_transcript",
  checkpointCandidate: Record<string, unknown>[],
  recoveryItems: Record<string, unknown>[],
  initialInput: Record<string, unknown>[],
  tools: Record<string, unknown>[],
): void {
  const checkpoint = summarizeContextItems(checkpointCandidate);
  const recovery = summarizeContextItems(recoveryItems);
  const request = summarizeContextItems(initialInput);
  const toolSchemaBytes = Buffer.byteLength(JSON.stringify(tools) ?? "", "utf8");
  console.error("[runtime-recovery-breakdown] " + JSON.stringify({
    session: sessionId,
    model,
    source,
    checkpointDisposition,
    checkpoint,
    recovery,
    initialRequest: request,
    freshInputStructuralBytes: Math.max(0, request.structuralJsonBytes - recovery.structuralJsonBytes),
    freshInputRawBytes: Math.max(0, request.rawJsonBytes - recovery.rawJsonBytes),
    toolSchemaBytes,
  }));
}
