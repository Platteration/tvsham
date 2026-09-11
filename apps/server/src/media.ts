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
 * The input is chosen by whoever uploaded it, so both halves of what ffmpeg may
 * do with it are pinned down. `-protocol_whitelist file` keeps it off the
 * network. `-format_whitelist` keeps it to the containers a phone records:
 * ffmpeg picks the demuxer from the file's *content*, so the .mp4 extension we
 * force on the saved name means nothing — an upload that begins
 * "ffconcat version 1.0" is opened by the concat demuxer, which then names
 * other local files for the still-permitted `file` protocol to open, and
 * whatever lands in a frame is described back to the uploader in `evidence`.
 * `-max_streams` bounds how many streams one file may declare at all.
 * All three apply to the input that follows them.
 */
function inputGuards(): string[] {
  return [
    "-protocol_whitelist",
    "file",
    "-format_whitelist",
    "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts",
    // The pixel budgets bound one stream; nothing bounds how many a container
    // may declare, and ffmpeg opens a decoder for every stream in the file
    // while probing it — sixty copies of a within-budget stream is a 1.6 MB
    // upload that costs 1.5 GB before any budget can look at it. This applies
    // *before* that allocation, which is what the budgets cannot do: libavformat
    // refuses the input outright, and that reaches the caller as "could not be
    // read". How much each of the streams it does allow may then cost is
    // `probeBudget()`, below.
    "-max_streams",
    String(config.maxStreams),
  ];
}

/**
 * The probe's own bound, on top of the guards above.
 *
 * `-max_streams` caps how many decoders ffmpeg may open; nothing caps what each
 * one then allocates, and `assertDecodable`'s pixel budgets cannot, because
 * they are read *out of* this run's banner — by the time they refuse a file the
 * memory has already been taken. The cost is in `find_stream_info`, which
 * decodes frames from every stream to fill in what the container did not
 * declare: eight streams declaring 8192x4608 are a 1.4 MB upload that costs
 * 736 MB to refuse, and three of those at once is past the 2 GB the shipped
 * compose file allows the container. Reading a fixed short prefix and giving up
 * on the analysis costs 113 MB for that file, and 39 MB for a real 4096x2304
 * clip, which is what it cost before: everything read below — dimensions,
 * stream count, duration — comes out of the container's own header either way.
 */
function probeBudget(): string[] {
  return ["-probesize", String(config.probeBytes), "-analyzeduration", "0"];
}

/**
 * The probe as a command, under an address-space limit when one is configured.
 *
 * `exec` on purpose: the shell replaces itself with ffmpeg, so the pid stays
 * the process we time out and kill, and there is no orphan left behind when it
 * is. A shell that cannot set the limit runs ffmpeg anyway — this is the second
 * line, not the bound.
 */
function probeCommand(bin: string, args: string[]): { file: string; args: string[] } {
  if (config.probeMemoryMb <= 0 || process.platform === "win32") return { file: bin, args };
  return {
    file: "/bin/sh",
    // Arguments, never interpolation: the file name in `args` comes from the
    // upload, and a shell that could see it is a shell that could run it.
    args: [
      "-c",
      'ulimit -v "$1" 2>/dev/null; shift; exec "$@"',
      "sh",
      String(config.probeMemoryMb * 1024),
      bin,
      ...args,
    ],
  };
}

/** Said once per process: a probe that produces nothing is not a clip problem. */
let warnedEmptyProbe = false;

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
  /**
   * Every picture the file would have ffmpeg decode, added up: each video
   * stream and each attached picture. A container may carry many, and the
   * memory a probe costs follows the total rather than the biggest one.
   */
  totalPixels: number;
  /** Video streams the container declares, cover art included. */
  videoStreams: number;
}

/**
 * Read what the container claims, from ffmpeg's own banner so we don't need
 * ffprobe. Always settles: a hung ffmpeg would otherwise hold a slot forever.
 */
export async function probe(file: string): Promise<Probe> {
  const bin = await ffmpegBinary();
  if (!bin) throw new Error("ffmpeg not found. Install ffmpeg or set FFMPEG_PATH.");
  // ffmpeg exits non-zero when no output is given; we only want the stderr banner.
  const command = probeCommand(bin, ["-hide_banner", "-nostdin", ...inputGuards(), ...probeBudget(), "-i", file]);
  const stderr = await new Promise<string>((resolve) => {
    const child = execFile(
      command.file,
      command.args,
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

  // ffmpeg says *something* about every file it opens, even an unreadable one,
  // so nothing at all means it never got to look: it was killed by the timeout
  // or by the address-space limit. The caller refuses the clip either way; this
  // is so an operator whose limit is too low for their machine can see why
  // every upload suddenly reads as unplayable.
  if (!stderr.trim() && !warnedEmptyProbe) {
    warnedEmptyProbe = true;
    console.warn(
      `[media] ffmpeg produced no output while probing a clip: it hit FFMPEG_TIMEOUT_MS (${config.ffmpegTimeoutMs}ms)` +
        `${config.probeMemoryMb > 0 ? ` or PROBE_MEMORY_MB (${config.probeMemoryMb}MB)` : ""}, or it is not runnable here.`,
    );
  }

  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const seconds = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;

  // Take the largest video stream, not the first one listed: ffmpeg decodes the
  // stream it selects (by default disposition and resolution), so measuring
  // stream #0 lets a file hide a huge stream behind a tiny one.
  let width = 0;
  let height = 0;
  let coverPixels = 0;
  // Keyed by ffmpeg's own "#file:index" rather than counted per line, because
  // the banner names a stream more than once: under the probe budget above,
  // every stream whose codec parameters it gave up on is named again in a
  // "Could not find codec parameters for stream N (Video: ..., 8192x4608)"
  // line carrying the same dimensions. Counting those would add a file's
  // streams up twice and refuse legitimate clips for pixels they do not have.
  const pixelsByStream = new Map<string, number>();
  for (const line of stderr.split("\n")) {
    // Only the stream listing, which is the one place each stream appears once.
    const listed = /^\s*Stream #(\d+:\d+)/.exec(line);
    if (!listed || !line.includes("Video:")) continue;
    if (pixelsByStream.has(listed[1]!)) continue;
    const m = /Video:.*?,\s*(\d{2,6})x(\d{2,6})/.exec(line);
    // Dimensions we cannot read are treated as too large rather than as zero.
    pixelsByStream.set(listed[1]!, m ? Number(m[1]) * Number(m[2]) : Number.POSITIVE_INFINITY);
    // Cover art is counted separately: it is not the stream frames come from,
    // so it must not stand in for the video, but it is still decoded on every
    // probe and so cannot be waved through either.
    if (line.includes("(attached pic)")) {
      coverPixels = m ? Math.max(coverPixels, Number(m[1]) * Number(m[2])) : Number.POSITIVE_INFINITY;
      continue;
    }
    if (!m) continue;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w * h > width * height) {
      width = w;
      height = h;
    }
  }
  let totalPixels = 0;
  for (const pixels of pixelsByStream.values()) totalPixels += pixels;
  return { seconds, width, height, coverPixels, totalPixels, videoStreams: pixelsByStream.size };
}

/** Kept for callers that only want the length. */
export async function probeDuration(file: string): Promise<number> {
  return (await probe(file)).seconds;
}

/**
 * Refuse work that is disproportionate to the upload's size before frames are
 * extracted from it: a tiny file can declare enormous dimensions or hours of
 * runtime.
 *
 * These budgets are checked against what `probe()` read, so they are applied
 * after that one bounded ffmpeg run and before every other one. What bounds the
 * probe itself is `-max_streams` (how many decoders may be opened at all) and
 * `probeBudget()` (how far ffmpeg may read before it answers), not the numbers
 * below.
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
  // Every stream above is one ffmpeg opens a decoder for, so the budget has to
  // hold for the file as a whole and not only for its largest picture: a stack
  // of within-budget streams costs the sum of them, not the maximum. Refused
  // here rather than during the probe, which is why the probe has a bound of
  // its own.
  if (p.totalPixels > config.maxPixels) {
    throw new Error(`Clip carries ${p.videoStreams} video streams, more pixels than this server will decode.`);
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
 *
 * One ffmpeg run does the whole set. Seeking to each frame separately means a
 * spawn per frame, and measured on this machine it is roughly five times slower
 * for a typical 8-second camera clip (390ms against 82ms) — every spawn re-opens
 * and re-probes the file, which is the bulk of the work at that length.
 *
 * Pass `spanSeconds` when the caller has already probed the clip, to save the
 * extra probe this would otherwise do.
 */
export async function extractFrames(
  file: string,
  opts: { count: number; maxSeconds: number; maxEdge?: number; workDir: string; spanSeconds?: number },
): Promise<ExtractedFrame[]> {
  const duration = opts.spanSeconds ?? (await probeDuration(file));
  const span = Math.max(0.5, Math.min(duration || opts.maxSeconds, opts.maxSeconds));
  const maxEdge = opts.maxEdge ?? 896;
  const interval = span / opts.count;
  // Start half an interval in: the very first frame of a clip is often black.
  const offset = interval / 2;
  const pattern = path.join(opts.workDir, "frame-%03d.jpg");

  await run([
    ...inputGuards(),
    "-ss",
    offset.toFixed(3),
    "-i",
    file,
    "-vf",
    `fps=${(1 / interval).toFixed(6)},scale='if(gt(iw,ih),min(${maxEdge},iw),-2)':'if(gt(iw,ih),-2,min(${maxEdge},ih))'`,
    "-frames:v",
    String(opts.count),
    "-q:v",
    "4",
    "-threads",
    "1",
    "-fps_mode",
    "passthrough",
    "-y",
    pattern,
  ]);

  // ffmpeg numbers its output from 1. Fewer files than asked for just means the
  // clip ran out, and since the shortfall is always at the end the index still
  // maps to the right timestamp.
  const frames: ExtractedFrame[] = [];
  for (let i = 0; i < opts.count; i++) {
    const out = path.join(opts.workDir, `frame-${String(i + 1).padStart(3, "0")}.jpg`);
    try {
      frames.push({ t: offset + i * interval, jpeg: await fs.readFile(out) });
    } catch {
      break;
    }
  }
  if (frames.length === 0) throw new Error("No frames could be extracted from the clip.");
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
      ...inputGuards(),
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
