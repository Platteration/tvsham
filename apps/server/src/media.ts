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
  return execFileAsync(bin, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    maxBuffer: 16 * 1024 * 1024,
    // The input is attacker-supplied, so decoding must not be able to run away.
    timeout: config.ffmpegTimeoutMs,
    killSignal: "SIGKILL",
  });
}

/**
 * The input is chosen by whoever uploaded it: only local files, and only the
 * demuxers we expect. Without this, ffmpeg picks a demuxer from the file's
 * content and the .mp4 extension means nothing.
 */
const INPUT_GUARDS = ["-protocol_whitelist", "file"];

export interface Probe {
  seconds: number;
  /** The video stream ffmpeg would actually decode frames from. */
  width: number;
  height: number;
  /**
   * Pixels in the largest attached picture (cover art). ffmpeg never selects it
   * for frame extraction, but the demuxer still decodes it while probing, so it
   * needs its own bound rather than being ignored.
   */
  coverPixels: number;
}

/**
 * Read what the container claims, from ffmpeg's own banner so we don't need
 * ffprobe. Always settles: a hung ffmpeg would otherwise hold a slot forever.
 */
export async function probe(file: string): Promise<Probe> {
  const bin = await ffmpegBinary();
  if (!bin) throw new Error("ffmpeg not found. Install ffmpeg or set FFMPEG_PATH.");
  // ffmpeg exits non-zero when no output is given; we only want the stderr banner.
  const stderr = await new Promise<string>((resolve) => {
    const child = execFile(
      bin,
      ["-hide_banner", "-nostdin", ...INPUT_GUARDS, "-i", file],
      { timeout: config.ffmpegTimeoutMs, killSignal: "SIGKILL" },
      (_err, _out, err) => {
        clearTimeout(timer);
        resolve(String(err));
      },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("");
    }, config.ffmpegTimeoutMs);
    timer.unref?.();
  });

  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const seconds = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;

  // Take the largest video stream, not the first one listed: ffmpeg decodes the
  // stream it selects (by default disposition and resolution), so measuring
  // stream #0 lets a file hide a huge stream behind a tiny one.
  let width = 0;
  let height = 0;
  let coverPixels = 0;
  for (const line of stderr.split("\n")) {
    const m = /Video:.*?,\s*(\d{2,6})x(\d{2,6})/.exec(line);
    if (!m) continue;
    const w = Number(m[1]);
    const h = Number(m[2]);
    // Cover art is counted separately: it is not the stream frames come from,
    // so it must not stand in for the video, but it is still decoded on every
    // probe and so cannot be waved through either.
    if (line.includes("(attached pic)")) {
      coverPixels = Math.max(coverPixels, w * h);
      continue;
    }
    if (w * h > width * height) {
      width = w;
      height = h;
    }
  }
  return { seconds, width, height, coverPixels };
}

/** Kept for callers that only want the length. */
export async function probeDuration(file: string): Promise<number> {
  return (await probe(file)).seconds;
}

/**
 * Refuse work that is disproportionate to the upload's size before any decoding
 * happens: a tiny file can declare enormous dimensions or hours of runtime.
 */
export async function assertDecodable(file: string): Promise<Probe> {
  const p = await probe(file);
  // A probe that found nothing means ffmpeg could not read the file, or it timed
  // out. Either way there is no budget to check it against, so refuse rather
  // than fall through to decoding it with default limits.
  if (p.width === 0 || p.height === 0) {
    throw new Error("Clip could not be read as video.");
  }
  const pixels = p.width * p.height;
  if (pixels > config.maxPixels) {
    throw new Error(`Clip is ${p.width}x${p.height}, larger than this server will decode.`);
  }
  if (p.coverPixels > config.maxPixels) {
    throw new Error("Clip carries artwork larger than this server will decode.");
  }
  if (p.seconds > config.maxDurationSeconds) {
    throw new Error(`Clip is ${Math.round(p.seconds)}s long, longer than this server will decode.`);
  }
  return p;
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
        ...INPUT_GUARDS,
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
        "-threads",
        "1",
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
      ...INPUT_GUARDS,
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
