import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

let resolvedFfmpeg: string | null | undefined;

/** Locate an ffmpeg binary: explicit env, PATH, then the ffmpeg-static package. */
export async function ffmpegBinary(): Promise<string | null> {
  if (resolvedFfmpeg !== undefined) return resolvedFfmpeg;
  const candidates: string[] = [];
  if (config.ffmpegPath) candidates.push(config.ffmpegPath);
  candidates.push("ffmpeg");
  try {
    const mod = (await import("ffmpeg-static")) as unknown as { default?: string | null };
    if (mod.default) candidates.push(mod.default);
  } catch {
    /* optional dependency */
  }
  for (const c of candidates) {
    try {
      await execFileAsync(c, ["-version"]);
      resolvedFfmpeg = c;
      return c;
    } catch {
      /* try next */
    }
  }
  resolvedFfmpeg = null;
  return null;
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const bin = await ffmpegBinary();
  if (!bin) throw new Error("ffmpeg not found. Install ffmpeg or set FFMPEG_PATH.");
  return execFileAsync(bin, ["-hide_banner", "-loglevel", "error", ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Duration in seconds, parsed from ffmpeg's own stderr so we don't need ffprobe. */
export async function probeDuration(file: string): Promise<number> {
  const bin = await ffmpegBinary();
  if (!bin) throw new Error("ffmpeg not found. Install ffmpeg or set FFMPEG_PATH.");
  // ffmpeg exits non-zero when no output is given; we only want the stderr banner.
  const stderr = await new Promise<string>((resolve) => {
    execFile(bin, ["-hide_banner", "-i", file], (_err, _out, err) => resolve(String(err)));
  });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export interface ExtractedFrame {
  /** Seconds into the clip. */
  t: number;
  jpeg: Buffer;
}

/**
 * Pull `count` JPEG frames spread evenly over the first `maxSeconds` of the clip,
 * downscaled so the long edge is at most `maxEdge` px.
 */
export async function extractFrames(
  file: string,
  opts: { count: number; maxSeconds: number; maxEdge?: number; workDir: string },
): Promise<ExtractedFrame[]> {
  const duration = await probeDuration(file);
  const span = Math.max(0.5, Math.min(duration || opts.maxSeconds, opts.maxSeconds));
  const maxEdge = opts.maxEdge ?? 896;
  const frames: ExtractedFrame[] = [];
  for (let i = 0; i < opts.count; i++) {
    // Avoid the very first frame (often black) and the last (often cut off).
    const t = span * ((i + 0.5) / opts.count);
    const out = path.join(opts.workDir, `frame-${i}.jpg`);
    try {
      await run([
        "-ss",
        t.toFixed(2),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        `scale='if(gt(iw,ih),min(${maxEdge},iw),-2)':'if(gt(iw,ih),-2,min(${maxEdge},ih))'`,
        "-q:v",
        "4",
        "-y",
        out,
      ]);
      frames.push({ t, jpeg: await fs.readFile(out) });
    } catch (err) {
      // A seek past the end just yields no frame; keep going.
      if (frames.length === 0 && i === opts.count - 1) throw err;
    }
  }
  return frames;
}

/** Extract mono 16 kHz audio (first `maxSeconds`) as a WAV file for speech-to-text. */
export async function extractAudio(
  file: string,
  opts: { maxSeconds: number; workDir: string },
): Promise<string | null> {
  const out = path.join(opts.workDir, "audio.wav");
  try {
    await run([
      "-i",
      file,
      "-t",
      String(opts.maxSeconds),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-y",
      out,
    ]);
    const stat = await fs.stat(out);
    return stat.size > 1024 ? out : null;
  } catch {
    return null;
  }
}
