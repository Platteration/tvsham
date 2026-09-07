import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { app, cleanHint, safeExtension } from "./index.js";
import { ffmpegBinary } from "./media.js";
import { setClientForTests } from "./recognize.js";

describe("http", () => {
  it("reports health", async () => {
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; ffmpeg: boolean; model: string };
    assert.equal(body.ok, true);
    assert.equal(typeof body.model, "string");
  });

  it("creates and describes a session", async () => {
    const created = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "screen" }),
    });
    assert.equal(created.status, 201);
    const { sessionId } = (await created.json()) as { sessionId: string };
    assert.ok(sessionId);

    const got = await app.request(`/sessions/${sessionId}`);
    assert.equal(got.status, 200);
    const body = (await got.json()) as { status: string; wantsMore: boolean; links: unknown[] };
    assert.equal(body.status, "listening");
    assert.equal(body.wantsMore, true);
    assert.deepEqual(body.links, []);

    const gone = await app.request(`/sessions/${sessionId}`, { method: "DELETE" });
    assert.equal(gone.status, 204);
    assert.equal((await app.request(`/sessions/${sessionId}`)).status, 404);
  });

  it("rejects an upload without a clip field", async () => {
    const created = await app.request("/sessions", { method: "POST" });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const form = new FormData();
    form.set("nope", "x");
    const res = await app.request(`/sessions/${sessionId}/clips`, { method: "POST", body: form });
    assert.equal(res.status, 400);
  });

  it("rejects an empty clip", async () => {
    const created = await app.request("/sessions", { method: "POST" });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(16)]), "clip.mp4");
    const res = await app.request(`/sessions/${sessionId}/clips`, { method: "POST", body: form });
    assert.equal(res.status, 400);
  });

  it("does not analyse a clip twice when the same clipKey is re-sent", async () => {
    const bin = await ffmpegBinary();
    assert.ok(bin);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tvsham-http-"));
    const clipPath = path.join(dir, "clip.mp4");
    await promisify(execFile)(bin!, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=160x90:rate=8", "-t", "2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", clipPath,
    ]);
    let analyses = 0;
    setClientForTests({
      beta: { messages: { create: async () => { analyses++; return { stop_reason: "end_turn", content: [{ type: "text", text: "TITLE: x" }] }; } } },
      messages: { parse: async () => ({ parsed_output: { kind: "unknown", title: "x", year: null, season: null, episodeNumber: null, episodeTitle: null, creator: null, creatorHandle: null, platform: null, wikipediaTitle: null, wikipediaEpisodeTitle: null, youtubeUrl: null, videoUrl: null, confidence: 0, evidence: "", alternatives: [] } }) },
    } as unknown as Anthropic);
    try {
      const created = await app.request("/sessions", { method: "POST" });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const bytes = await fs.readFile(clipPath);
      const send = async () => {
        const form = new FormData();
        form.set("clip", new Blob([bytes], { type: "video/mp4" }), "clip.mp4");
        form.set("clipKey", "k1");
        return app.request(`/sessions/${sessionId}/clips`, { method: "POST", body: form });
      };
      const first = await send();
      assert.equal(first.status, 200);
      const second = await send();
      assert.equal(second.status, 200);
      const body = (await second.json()) as { secondsAnalysed: number };
      assert.equal(analyses, 1);
      assert.equal(body.secondsAnalysed, 2);
    } finally {
      setClientForTests(null);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("only keeps known video extensions from the upload name", () => {
    assert.equal(safeExtension("clip.MOV"), ".mov");
    assert.equal(safeExtension("clip.webm"), ".webm");
    assert.equal(safeExtension("clip.exe"), ".mp4");
    assert.equal(safeExtension("../../etc/passwd"), ".mp4");
    assert.equal(safeExtension(undefined), ".mp4");
  });

  it("rejects an upload over the size cap before parsing it", async () => {
    const created = await app.request("/sessions", { method: "POST" });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const res = await app.request(`/sessions/${sessionId}/clips`, {
      method: "POST",
      headers: { "content-type": "video/mp4", "content-length": String(500 * 1024 * 1024) },
      body: new Blob([new Uint8Array(1024)]),
    });
    assert.equal(res.status, 413);
  });

  it("normalises the optional hint", () => {
    assert.equal(cleanHint("  90s   sitcom\non Netflix "), "90s sitcom on Netflix");
    assert.equal(cleanHint("   "), undefined);
    assert.equal(cleanHint(42), undefined);
    assert.equal(cleanHint(undefined), undefined);
    assert.equal(cleanHint("x".repeat(500))?.length, 120);
  });

  it("404s for unknown sessions", async () => {
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(4)]), "clip.mp4");
    const res = await app.request("/sessions/nope/clips", { method: "POST", body: form });
    assert.equal(res.status, 404);
  });
});
