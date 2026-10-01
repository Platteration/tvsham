import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, after, describe, it } from "node:test";
import { promisify } from "node:util";
import { config } from "./config.js";
import { assertDecodable, extractAudio, extractFrames, ffmpegBinary, probe, probeDuration } from "./media.js";

const execFileAsync = promisify(execFile);

/**
 * The peak resident memory of every process this one starts while `work` runs,
 * in MB, read from the kernel's own high-water mark.
 *
 * The point of measuring rather than asserting a refusal: a decode bomb is
 * refused either way, and what the first fix round missed is that refusing it
 * cost 749 MB, because the numbers the refusal is based on are read out of the
 * ffmpeg run that already allocated them. Linux only, which is what CI runs;
 * elsewhere the caller skips.
 */
function childProcesses(pid: number | string, found = new Set<string>()): Set<string> {
  let tasks: string[] = [];
  try {
    tasks = readdirSync(`/proc/${pid}/task`);
  } catch {
    return found; // Exited between the two reads; whatever it peaked at is already recorded.
  }
  for (const task of tasks) {
    let children = "";
    try {
      children = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8");
    } catch {
      continue;
    }
    for (const child of children.split(/\s+/).filter(Boolean)) {
      if (found.has(child)) continue;
      found.add(child);
      childProcesses(child, found);
    }
  }
  return found;
}

function peakRssKb(pid: string): number {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function peakChildMemoryMb(work: () => Promise<unknown>): Promise<number> {
  const peaks = new Map<string, number>();
  // VmHWM only grows, so sampling often enough to catch a short-lived child is
  // all this needs; the last sample after `work` settles catches the rest.
  const sample = () => {
    for (const pid of childProcesses(process.pid)) peaks.set(pid, Math.max(peaks.get(pid) ?? 0, peakRssKb(pid)));
  };
  const timer = setInterval(sample, 5);
  try {
    await work();
  } finally {
    sample();
    clearInterval(timer);
  }
  return Math.max(0, ...peaks.values()) / 1024;
}

describe("media", () => {
  let dir = "";
  let clip = "";

  before(async () => {
    const bin = await ffmpegBinary();
    assert.ok(bin, "ffmpeg must be available for media tests");
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tvsham-media-"));
    clip = path.join(dir, "clip.mp4");
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=12",
      "-f", "lavfi", "-i", "sine=frequency=440",
      "-t", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", clip,
    ]);
  });

  after(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("probes duration", async () => {
    const d = await probeDuration(clip);
    assert.ok(d > 4.5 && d < 5.5, `duration was ${d}`);
  });

  it("extracts evenly spaced jpeg frames", async () => {
    const frames = await extractFrames(clip, { count: 4, maxSeconds: 60, workDir: dir });
    assert.equal(frames.length, 4);
    assert.deepEqual(frames.map((f) => Number(f.t.toFixed(3))), [0.625, 1.875, 3.125, 4.375]);
    for (const f of frames) {
      assert.ok(f.jpeg.length > 500);
      assert.equal(f.jpeg[0], 0xff);
      assert.equal(f.jpeg[1], 0xd8);
    }
  });

  it("reads the frame size, not just the duration", async () => {
    const p = await probe(clip);
    assert.equal(p.width, 320);
    assert.equal(p.height, 180);
  });

  it("refuses to decode more pixels than the budget allows", async () => {
    const original = config.maxPixels;
    (config as { maxPixels: number }).maxPixels = 1000; // the clip is 320x180
    try {
      await assertDecodable(clip);
      assert.fail("expected an oversized clip to be refused");
    } catch (err) {
      assert.match(String(err), /larger than this server will decode/);
    } finally {
      (config as { maxPixels: number }).maxPixels = original;
    }
  });

  it("refuses to decode a clip longer than the budget allows", async () => {
    const original = config.maxDurationSeconds;
    (config as { maxDurationSeconds: number }).maxDurationSeconds = 1; // the clip is 5s
    try {
      await assertDecodable(clip);
      assert.fail("expected an overlong clip to be refused");
    } catch (err) {
      assert.match(String(err), /longer than this server will decode/);
    } finally {
      (config as { maxDurationSeconds: number }).maxDurationSeconds = original;
    }
  });

  it("accepts a clip inside the budget", async () => {
    const p = await assertDecodable(clip);
    assert.ok(p.seconds > 4.5);
  });

  it("settles rather than hanging when ffmpeg cannot read the input", async () => {
    const junk = path.join(dir, "not-a-video.mp4");
    await fs.writeFile(junk, Buffer.alloc(4096, 0x41));
    const p = await probe(junk);
    assert.equal(p.seconds, 0);
    assert.equal(p.width, 0);
  });

  // The saved name is forced to a video extension, but ffmpeg chooses the
  // demuxer from the content: a playlist that happens to be called clip.mp4 is
  // opened by the concat demuxer, which names further local files for the
  // `file` protocol to read. Only the demuxer whitelist stops that, and the
  // proof it is doing the work is that the file it points at is a real,
  // decodable video: without the whitelist this probes as 320x180.
  it("refuses a playlist that names another local file, whatever it is called", async () => {
    const playlist = path.join(dir, "playlist-as-clip.mp4");
    await fs.writeFile(playlist, `ffconcat version 1.0\nfile '${path.basename(clip)}'\n`);
    const p = await probe(playlist);
    assert.equal(p.width, 0, "the concat demuxer must not be selected");
    await assert.rejects(assertDecodable(playlist), /could not be read as video/);
  });

  it("uses a span the caller already probed instead of probing again", async () => {
    // Proven by effect: a 2s span over a 5s clip must sample only the first 2s.
    const frames = await extractFrames(clip, { count: 4, maxSeconds: 60, workDir: dir, spanSeconds: 2 });
    assert.deepEqual(frames.map((f) => Number(f.t.toFixed(3))), [0.25, 0.75, 1.25, 1.75]);
  });

  it("returns what it got when the clip is shorter than the sampling asks for", async () => {
    // 40 frames from a 5 second clip: whatever comes back must still be in order
    // and correctly timed, rather than throwing or misnumbering.
    const frames = await extractFrames(clip, { count: 40, maxSeconds: 60, workDir: dir });
    assert.ok(frames.length > 0 && frames.length <= 40);
    for (let i = 1; i < frames.length; i++) {
      assert.ok(frames[i]!.t > frames[i - 1]!.t, "timestamps must increase");
    }
    assert.ok(frames.at(-1)!.t <= 5, "no frame may claim a time past the clip");
  });

  it("extracts mono 16 kHz wav audio", async () => {
    const wav = await extractAudio(clip, { maxSeconds: 60, workDir: dir });
    assert.ok(wav);
    const buf = await fs.readFile(wav!);
    assert.equal(buf.subarray(0, 4).toString(), "RIFF");
    assert.equal(buf.readUInt16LE(22), 1, "channels");
    assert.equal(buf.readUInt32LE(24), 16000, "sample rate");
  });
});

describe("decode guards", () => {
  let dir = "";

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tvsham-guard-"));
  });

  after(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("measures the largest video stream, not the first one listed", async () => {
    // A decode bomb hides a huge stream behind a small one: ffmpeg decodes the
    // stream it selects, so measuring stream #0 would wave this through.
    const bin = await ffmpegBinary();
    const clipPath = path.join(dir, "two-stream.mp4");
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=64x64:rate=2",
      "-f", "lavfi", "-i", "testsrc=size=4000x4000:rate=1",
      "-map", "0:v", "-map", "1:v", "-t", "1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-disposition:v:0", "0", "-disposition:v:1", "default",
      "-y", clipPath,
    ]);
    const p = await probe(clipPath);
    assert.equal(p.width, 4000, "probe must report the largest stream");
    await assert.rejects(assertDecodable(clipPath), /larger than this server will decode/);
  });

  it("ignores cover art, which is a video stream ffmpeg never decodes as video", async () => {
    const bin = await ffmpegBinary();
    const cover = path.join(dir, "cover.jpg");
    const clipPath = path.join(dir, "with-cover.mp4");
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=2000x2000:rate=1", "-frames:v", "1", "-y", cover,
    ]);
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error",
      "-t", "1", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10",
      "-i", cover,
      "-map", "0:v", "-map", "1:v",
      "-c:v:0", "libx264", "-pix_fmt", "yuv420p", "-c:v:1", "copy",
      "-disposition:v:1", "attached_pic", "-y", clipPath,
    ]);
    const p = await probe(clipPath);
    assert.equal(p.width, 320, "artwork must not be mistaken for the video stream");
    assert.equal(p.coverPixels, 2000 * 2000, "artwork is measured, just separately");
    // Within budget, so it is accepted: artwork does not stand in for the video.
    await assertDecodable(clipPath);

    // But it is not exempt either. The demuxer decodes the picture on every
    // probe, so oversized artwork is its own decode bomb.
    const original = config.maxPixels;
    (config as { maxPixels: number }).maxPixels = 1000 * 1000;
    try {
      await assert.rejects(assertDecodable(clipPath), /artwork larger than this server will decode/);
    } finally {
      (config as { maxPixels: number }).maxPixels = original;
    }
  });

  it("refuses a file that declares more streams than any recording has", async () => {
    // The pixel and duration budgets each measure one stream; the count is its
    // own bomb, because ffmpeg opens a decoder for every stream in the file
    // while probing it. Every stream here is tiny and they total a fraction of
    // one frame's budget, so nothing but the stream cap can refuse this.
    const bin = await ffmpegBinary();
    const one = path.join(dir, "one-stream.mp4");
    const many = path.join(dir, "many-streams.mkv");
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=64x64:rate=2", "-t", "1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", one,
    ]);
    const copies = 40; // far more than a phone records, far fewer than an attack needs
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error", "-i", one,
      ...Array.from({ length: copies }, () => ["-map", "0:v"]).flat(),
      "-c", "copy", "-y", many,
    ]);
    await assert.rejects(assertDecodable(many), /could not be read as video/);
    // The same stream on its own is fine, so this is the count being refused
    // and not the content.
    const p = await assertDecodable(one);
    assert.equal(p.videoStreams, 1);
  });

  it("counts the pixels of every stream, not just the biggest one", async () => {
    // Streams that each sit inside the budget still cost the sum of them to
    // probe, so a stack of within-budget copies is a decode bomb the
    // largest-stream measurement waves through.
    const bin = await ffmpegBinary();
    const clipPath = path.join(dir, "two-video-streams.mp4");
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=4", "-t", "1",
      "-map", "0:v", "-map", "0:v",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", clipPath,
    ]);
    const p = await probe(clipPath);
    assert.equal(p.videoStreams, 2);
    assert.equal(p.totalPixels, 2 * 320 * 180);

    const original = config.maxPixels;
    // Room for one of these streams and no more: the budget is derived from the
    // clip's own size, so it fails for the sum rather than for the maximum.
    (config as { maxPixels: number }).maxPixels = 320 * 180;
    try {
      await assert.rejects(assertDecodable(clipPath), /2 video streams, more pixels than this server will decode/);
    } finally {
      (config as { maxPixels: number }).maxPixels = original;
    }
  });

  it("probes a stack of oversized streams inside one stream's memory, not eight", async (t) => {
    // The budgets in assertDecodable are read *out of* the probe, so they can
    // only refuse a file after ffmpeg has opened a decoder for every stream in
    // it and decoded frames to fill in what the container did not declare. That
    // is what made a 1.4 MB upload cost 749 MB to refuse, three at a time past
    // the 2 GB the shipped compose file allows. The probe's own bound is the
    // fix, and a refusal on its own cannot tell you whether it is working.
    if (process.platform !== "linux") return t.skip("peak memory is read from /proc");
    const bin = await ffmpegBinary();
    const one = path.join(dir, "budget-stream.mp4");
    const many = path.join(dir, "budget-stream-x8.mkv");
    const copies = 8; // config.maxStreams: the most a file may declare at all
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error",
      // Exactly the per-stream budget, so the file is refused for the sum of
      // its streams rather than for any one of them.
      "-f", "lavfi", "-i", "testsrc=size=4096x2304:rate=2", "-t", "0.5",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", one,
    ]);
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error", "-i", one,
      ...Array.from({ length: copies }, () => ["-map", "0:v"]).flat(),
      "-c", "copy", "-y", many,
    ]);

    // The yardstick is the same stream on its own, measured here rather than
    // written down: probing eight of something must not cost eight times
    // probing one of it, whatever this machine's ffmpeg costs to run at all.
    const alone = await peakChildMemoryMb(() => assertDecodable(one));
    assert.ok(alone > 4, `the probe should be visible in /proc, measured ${alone.toFixed(0)} MB`);
    let refusal = "";
    const stacked = await peakChildMemoryMb(async () => {
      await assert.rejects(assertDecodable(many), (err: Error) => {
        refusal = err.message;
        return /more pixels than this server will decode/.test(err.message);
      });
    });
    assert.ok(
      stacked <= alone * 3,
      `probing ${copies} streams cost ${stacked.toFixed(0)} MB against ${alone.toFixed(0)} MB for one of them`,
    );
    // ...and the bound must not have cost us the count: under it ffmpeg names a
    // stream whose parameters it gave up on twice, so a probe that counted
    // banner lines would say fourteen streams here and refuse real clips.
    assert.match(refusal, new RegExp(`carries ${copies} video streams`));
  });

  it("fails closed when a probe cannot fit in the address space it is given", async (t) => {
    // The second line behind the probe budget: if a format or a future ffmpeg
    // allocates before it honours a probe size, the child dies rather than the
    // container. A clip nobody could read is refused, never waved through.
    if (process.platform === "win32") return t.skip("no ulimit");
    const bin = await ffmpegBinary();
    const clipPath = path.join(dir, "ordinary.mp4");
    await execFileAsync(bin!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10", "-t", "1",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", clipPath,
    ]);
    await assertDecodable(clipPath); // fine with the shipped limit
    const original = config.probeMemoryMb;
    (config as { probeMemoryMb: number }).probeMemoryMb = 16;
    try {
      await assert.rejects(assertDecodable(clipPath), /could not be read as video/);
    } finally {
      (config as { probeMemoryMb: number }).probeMemoryMb = original;
    }
    // ...and turning it off is what an operator whose machine needs more does.
    (config as { probeMemoryMb: number }).probeMemoryMb = 0;
    try {
      await assertDecodable(clipPath);
    } finally {
      (config as { probeMemoryMb: number }).probeMemoryMb = original;
    }
  });

  it("refuses a file it could not read at all, rather than falling through", async () => {
    // A probe that finds nothing means an unreadable file or a timed-out ffmpeg.
    // Treating that as "no dimensions, so within budget" would let it through.
    const junk = path.join(dir, "junk.mp4");
    await fs.writeFile(junk, Buffer.alloc(4096, 0x41));
    await assert.rejects(assertDecodable(junk), /could not be read as video/);
  });
});
