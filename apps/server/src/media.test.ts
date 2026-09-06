import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, after, describe, it } from "node:test";
import { promisify } from "node:util";
import { extractAudio, extractFrames, ffmpegBinary, probeDuration } from "./media.js";

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

  it("extracts mono 16 kHz wav audio", async () => {
    const wav = await extractAudio(clip, { maxSeconds: 60, workDir: dir });
    assert.ok(wav);
    const buf = await fs.readFile(wav!);
    assert.equal(buf.subarray(0, 4).toString(), "RIFF");
    assert.equal(buf.readUInt16LE(22), 1, "channels");
    assert.equal(buf.readUInt32LE(24), 16000, "sample rate");
  });
});
