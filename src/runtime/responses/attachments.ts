import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { RuntimeAttachment } from "../types.js";

function mimeFor(path: string, supplied?: string): string {
  if (supplied) return supplied;
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".txt") return "text/plain";
  if (extension === ".md") return "text/markdown";
  if (extension === ".json") return "application/json";
  if (extension === ".csv") return "text/csv";
  if (extension === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (extension === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (extension === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}

function supportedImageMime(mime: string): boolean {
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime.toLowerCase());
}

export async function attachmentPart(attachment: RuntimeAttachment): Promise<Record<string, unknown> | undefined> {
  const bytes = await readFile(attachment.path).catch(() => { throw Object.assign(new Error("附件缓存不可读取，请重新发送文件。"), { code: "attachment_unreadable" }); });
  const mime = mimeFor(attachment.path, attachment.mimeType);
  const data = "data:" + mime + ";base64," + bytes.toString("base64");

  if (attachment.kind === "image") {
    if (!supportedImageMime(mime)) throw Object.assign(new Error("当前模型图片格式不支持，请使用 JPEG、PNG、WebP 或 GIF。"), { code: "attachment_unreadable" });
    return { type: "input_image", image_url: data, detail: "auto" };
  }
  if (attachment.kind === "file") {
    return {
      type: "input_file",
      filename: attachment.fileName || "attachment" + extname(attachment.path),
      file_data: data,
    };
  }
  return undefined;
}
