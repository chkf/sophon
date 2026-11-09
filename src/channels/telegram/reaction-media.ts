import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramSticker } from "../types.js";
import type { TelegramApiClient } from "./types.js";

const exec = promisify(execFile);
const MAX = 20 * 1024 * 1024;
const limits = { timeout: 30_000, maxBuffer: 256 * 1024, windowsHide: true };
const scale = "scale=w='if(gte(iw,ih),512,-2)':h='if(gte(iw,ih),-2,512)'";
export interface ReactionMedia { method: "sendSticker" | "sendAnimation"; field: "sticker" | "animation"; media: string | File; label: string }

/** Local conversion precedes the one sending attempt. Never fall back after an uncertain send. */
export async function prepareReactionMedia(api: TelegramApiClient, sticker: TelegramSticker): Promise<ReactionMedia> {
  // Only TGS keeps native-ID delivery; raster/video sources are uploaded afresh.
  if (sticker.format === "animated")
    return { method:"sendSticker",field:"sticker",media:sticker.fileId,label:"[已发送贴纸]" };
  const info = await api.getFile(sticker.fileId);
  if (!info.file_path || (info.file_size ?? 0) > MAX) throw Error("表情素材不可用或超过 20MB。");
  const bytes = await api.downloadFile(info.file_path, MAX);
  if (bytes.byteLength > MAX) throw Error("表情素材超过 20MB。");
  const root = await mkdtemp(join(tmpdir(), "sophon-reaction-"));
  try {
    const input = join(root, "input"); await writeFile(input, bytes, {mode:0o600});
    const probe = JSON.parse((await exec("ffprobe", ["-v","error","-protocol_whitelist","file,pipe","-show_streams","-show_format","-of","json",input], limits)).stdout);
    const stream = probe.streams?.find((s: {codec_type?:string}) => s.codec_type === "video");
    if (!stream || !(stream.width > 0) || !(stream.height > 0) || stream.width * stream.height > 32_000_000)
      throw Error("表情素材尺寸无效或过大。");
    const duration = Number(probe.format?.duration ?? stream.duration);
    const still = sticker.format === "image" || sticker.format === "static";
    const convert = async (output: string, args: string[]) => {
      await exec("ffmpeg", ["-nostdin","-v","error","-threads","1","-filter_threads","1","-protocol_whitelist","file,pipe","-i",input,
        "-map","0:v:0","-an","-threads","1",...args,output], limits);
    };
    const file = async (path:string, name:string, mime:string, max:number) => {
      if ((await stat(path)).size > max) return undefined;
      return new File([new Uint8Array(await readFile(path))], name, {type:mime});
    };
    if (still) {
      const output = join(root,"sticker.webp");
      await convert(output,["-vf",scale,"-frames:v","1","-c:v","libwebp","-quality","80"]);
      const media = await file(output,"sticker.webp","image/webp",512*1024);
      if (!media) throw Error("静态表情转换后超过贴纸大小限制。");
      return {method:"sendSticker",field:"sticker",media,label:"[已发送贴纸]"};
    }
    if (Number.isFinite(duration) && duration > 0 && duration <= 3) {
      const output=join(root,"sticker.webm");
      // Conversion failure can fall back locally, before any send has happened.
      try {
        await convert(output,["-vf",scale+",fps=30","-c:v","libvpx-vp9","-b:v","0","-crf","38","-deadline","realtime","-cpu-used","6"]);
        const media=await file(output,"sticker.webm","video/webm",256*1024);
        if(media)return {method:"sendSticker",field:"sticker",media,label:"[已发送贴纸]"};
      } catch { /* Use an ordinary animation below. */ }
    }
    if (sticker.format === "gif") return {method:"sendAnimation",field:"animation",media:sticker.fileId,label:"[已发送 GIF]"};
    // Document IDs cannot be reused as another Telegram media type: upload converted bytes.
    if (!Number.isFinite(duration) || duration <= 0 || duration > 120) throw Error("动图时长无法确认或超过转换上限（120 秒）。");
    const output=join(root,"animation.mp4");
    await convert(output,["-vf",scale+",fps=30","-c:v","libx264","-pix_fmt","yuv420p","-preset","veryfast","-crf","25","-movflags","+faststart","-fs",String(MAX+1)]);
    const media=await file(output,"animation.mp4","video/mp4",MAX);
    if(!media)throw Error("动图转换后超过 20MB。");
    return {method:"sendAnimation",field:"animation",media,label:"[已发送 GIF]"};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("贴纸转换需要 ffmpeg 和 ffprobe，请安装后重试。", {cause:error});
    throw error;
  } finally { await rm(root,{recursive:true,force:true}); }
}
