import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A compact four-frame contact sheet for GIF-style Telegram media. */
export async function animationPreview(path: string, durationSeconds?: number): Promise<Uint8Array | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-animation-"));
  const output = join(directory, "preview.png");
  const duration = Number.isFinite(durationSeconds) && durationSeconds! > 0 ? durationSeconds! : 4;
  const fps = Math.max(0.1, Math.min(4, 4 / duration));
  try {
    await run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y",
      "-protocol_whitelist", "file,pipe", "-i", path, "-an", "-sn", "-dn",
      "-vf", `fps=${fps.toFixed(3)},scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2,tile=2x2:nb_frames=4`,
      "-frames:v", "1", output], { timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true });
    return await readFile(output);
  } catch {
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
