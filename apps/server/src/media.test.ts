import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, after, describe, it } from "node:test";
import { promisify } from "node:util";
import { config } from "./config.js";
import { assertDecodable, extractAudio, extractFrames, ffmpegBinary, probe, probeDuration } from "./media.js";

const execFileAsync = promisify(execFile);

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
    // Would be refused if the 2000x2000 artwork counted towards the budget.
    const original = config.maxPixels;
    (config as { maxPixels: number }).maxPixels = 320 * 180;
    try {
      await assertDecodable(clipPath);
    } finally {
      (config as { maxPixels: number }).maxPixels = original;
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
