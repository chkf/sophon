import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { RuntimeAttachment } from "../types.js";
import { animationPreview } from "../../media/animation-preview.js";

function mimeFor(path: string, supplied?: string): string {
  const normalized = supplied?.split(";")[0]?.trim().toLowerCase();
  if (normalized && normalized !== "application/octet-stream") return normalized;
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webm") return "video/webm";
  if (extension === ".mp4") return "video/mp4";
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
  const mime = mimeFor(attachment.fileName || attachment.path, attachment.mimeType);
  const data = "data:" + mime + ";base64," + bytes.toString("base64");

  if (attachment.kind === "image" || (attachment.kind === "file" && supportedImageMime(mime))) {
    if (!supportedImageMime(mime)) throw Object.assign(new Error("当前模型图片格式不支持，请使用 JPEG、PNG、WebP 或 GIF。"), { code: "attachment_unreadable" });
    return { type: "input_image", image_url: data, detail: "auto" };
  }
  if (attachment.kind === "file") {
    // Telegram may display a silent MP4 as a GIF while delivering it as a document.
    // Responses rejects video/mp4 input_file; pass a bounded visual preview instead.
    if (["video/mp4", "video/webm"].includes(mime.toLowerCase()) || [".mp4", ".webm"].includes(extname(attachment.path).toLowerCase())) {
      const preview = await animationPreview(attachment.path);
      if (!preview) throw Object.assign(new Error("动图预览失败，请重新发送或换成 GIF。"), { code: "attachment_unreadable" });
      return { type: "input_image", image_url: "data:image/png;base64," + Buffer.from(preview).toString("base64"), detail: "auto" };
    }
    return {
      type: "input_file",
      filename: attachment.fileName || "attachment" + extname(attachment.path),
      file_data: data,
    };
  }
  return undefined;
}

/** Older checkpoints may contain image bytes wrapped as input_file. Repair only the wire copy. */
export function normalizeImageFileInput(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  return input.map(item => {
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) return item;
    return {...item, content:item.content.map((part: Record<string, unknown>) => {
      if (part?.type !== "input_file" || typeof part.file_data !== "string" ||
          !/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(part.file_data)) return part;
      return {type:"input_image",image_url:part.file_data,detail:"auto"};
    })};
  });
}
