import { lookup } from "node:dns";
import { isIP } from "node:net";
import { get } from "node:https";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeAttachment, RuntimeImage } from "./types.js";

export const IMAGE_LIMIT = 8 * 1024 * 1024;
function publicAddress(address: string): boolean {
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address); // global unicast only
  const n = address.split(".").map(Number);
  return n.length === 4 && ![0, 10, 127].includes(n[0]!) && n[0]! < 224 &&
    !(n[0] === 169 && n[1] === 254) && !(n[0] === 172 && n[1]! >= 16 && n[1]! <= 31) &&
    !(n[0] === 192 && [0, 168].includes(n[1]!)) && !(n[0] === 100 && n[1]! >= 64 && n[1]! <= 127) &&
    !(n[0] === 198 && [18, 19].includes(n[1]!));
}
export async function downloadImage(url: string): Promise<Buffer> {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.username || target.password || (target.port && target.port !== "443")) throw new Error("Image URL rejected.");
  const literal = target.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && !publicAddress(literal)) throw new Error("Image URL rejected.");
  return new Promise((resolve, reject) => {
    const request = get(target, {
      lookup: (hostname, options, callback) => lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error) return callback(error, []);
        if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return callback(new Error("Image URL rejected."), []);
        // Node may request one address or all addresses. Pin the validated DNS result.
        if (options.all) callback(null, addresses);
        else (callback as unknown as (error: Error | null, address: string, family: number) => void)(null, addresses[0]!.address, addresses[0]!.family);
      }),
    }, response => {
      if (response.statusCode !== 200 || Number(response.headers["content-length"] ?? 0) > IMAGE_LIMIT) {
        response.destroy(); reject(new Error("Image download rejected.")); return;
      }
      const parts: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > IMAGE_LIMIT) { response.destroy(new Error("Image exceeds limit.")); return; }
        parts.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(parts)));
      response.on("error", () => reject(new Error("Image download failed.")));
    });
    request.setTimeout(30_000, () => request.destroy(new Error("Image download timeout.")));
    request.on("error", () => reject(new Error("Image download failed.")));
  });
}

export function imageInfo(bytes: Buffer): { mimeType: string; width: number; height: number; extension: string } {
  if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new Error("Image size invalid.");
  let info: { mimeType: string; width: number; height: number; extension: string } | undefined;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString("ascii",12,16) === "IHDR") {
    info = { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), extension: "png" };
  } else if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xff) { offset++; continue; }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        info = { mimeType: "image/jpeg", height: bytes.readUInt16BE(offset+5), width: bytes.readUInt16BE(offset+7), extension: "jpg" }; break;
      }
      offset += 2 + length;
    }
  } else if (bytes.length >= 30 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP") {
    const format = bytes.toString("ascii",12,16);
    if (format === "VP8X") info = { mimeType: "image/webp", width: 1 + bytes.readUIntLE(24,3), height: 1 + bytes.readUIntLE(27,3), extension: "webp" };
    if (format === "VP8 " && bytes.subarray(23,26).equals(Buffer.from([0x9d,0x01,0x2a]))) info = { mimeType: "image/webp", width: bytes.readUInt16LE(26)&0x3fff, height: bytes.readUInt16LE(28)&0x3fff, extension: "webp" };
    if (format === "VP8L" && bytes[20] === 0x2f) { const bits=bytes.readUInt32LE(21); info={ mimeType:"image/webp", width:(bits&0x3fff)+1,height:((bits>>>14)&0x3fff)+1,extension:"webp" }; }
  }
  if (!info || info.width < 1 || info.height < 1 || info.width + info.height > 10_000 || Math.max(info.width/info.height,info.height/info.width) > 20) throw new Error("Image format or dimensions unsupported.");
  return info;
}

export async function attachmentData(attachment: RuntimeAttachment): Promise<string> {
  if (attachment.kind !== "image") throw new Error("OpenRouter 当前只支持图片附件，文件输入未启用。");
  const bytes = await readFile(attachment.path);
  const info = imageInfo(bytes);
  return "data:" + info.mimeType + ";base64," + bytes.toString("base64");
}

export async function saveGeneratedImage(dataDir: string, item: { b64_json?: string; url?: string; media_type?: string }, prompt: string, model: string): Promise<RuntimeImage> {
  let bytes: Buffer;
  if (typeof item.b64_json === "string") {
    const raw = item.b64_json.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    if (raw.length > Math.ceil(IMAGE_LIMIT/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error("Image base64 invalid.");
    bytes = Buffer.from(raw, "base64");
  } else if (typeof item.url === "string") {
    if (item.url.startsWith("data:")) return saveGeneratedImage(dataDir, { b64_json: item.url }, prompt, model);
    bytes = await downloadImage(item.url);
  } else throw new Error("OpenRouter 没有返回真实图片。");
  const info = imageInfo(bytes);
  if (item.media_type && item.media_type !== info.mimeType) throw new Error("Image MIME mismatch.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = join(dataDir,"media","generated");
  await mkdir(directory, { recursive: true });
  const path = join(directory, sha256 + "." + info.extension);
  await writeFile(path, bytes, { mode: 0o600 });
  return { kind: "image", path, mimeType: info.mimeType, width: info.width, height: info.height, size: bytes.length, sha256, prompt, model };
}
