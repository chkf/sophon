import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Attachment, AttachmentKind, ChannelName } from "../channels/types.js";

export interface SaveMediaInput {
  channel: ChannelName;
  kind: AttachmentKind;
  bytes: Uint8Array;
  fileName?: string;
  mimeType?: string;
  remoteId?: string;
}

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml", "application/yaml"];
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv", ".tsv", ".xml", ".yaml", ".yml", ".log"]);

function safeExtension(fileName?: string): string {
  const extension = fileName ? extname(fileName).toLowerCase() : "";
  return /^[.][a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

function isTextLike(fileName?: string, mimeType?: string): boolean {
  if (mimeType && TEXT_MIME_PREFIXES.some((prefix) => mimeType.toLowerCase().startsWith(prefix))) return true;
  return Boolean(fileName && TEXT_EXTENSIONS.has(extname(fileName).toLowerCase()));
}

export class MediaStore {
  constructor(
    private readonly rootDir: string,
    private readonly maxBytes = 20 * 1024 * 1024,
    private readonly maxTextPreviewBytes = 32 * 1024,
  ) {}

  async save(input: SaveMediaInput): Promise<Attachment> {
    if (input.bytes.byteLength > this.maxBytes) {
      throw new Error("Attachment exceeds the Gateway media limit of " + this.maxBytes + " bytes.");
    }
    const digest = createHash("sha256").update(input.bytes).digest("hex");
    const directory = join(this.rootDir, input.channel);
    const path = join(directory, digest + safeExtension(input.fileName));
    await mkdir(directory, { recursive: true });
    await writeFile(path, input.bytes, { mode: 0o600 });

    let textPreview: string | undefined;
    if (isTextLike(input.fileName, input.mimeType)) {
      textPreview = Buffer.from(input.bytes)
        .subarray(0, this.maxTextPreviewBytes)
        .toString("utf8")
        .replace(/\u0000/g, "")
        .trim();
    }

    return {
      kind: input.kind,
      ...(input.fileName ? { fileName: input.fileName } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      size: input.bytes.byteLength,
      localPath: path,
      ...(textPreview ? { textPreview } : {}),
      ...(input.remoteId ? { remoteId: input.remoteId } : {}),
    };
  }
}
