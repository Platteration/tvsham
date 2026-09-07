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
