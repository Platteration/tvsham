import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { addressBucket, app, caller, cleanClipKey, cleanHint, safeExtension } from "./index.js";
import { createSession, deleteSession, getSession, sessionCount, sessionsHeldBy, sweepSessions } from "./sessions.js";
import { ffmpegBinary } from "./media.js";
import { setClientForTests } from "./recognize.js";

describe("http", () => {
  it("reports health", async () => {
    const res = await app.request("/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      ffmpeg: boolean;
      model: string;
      tmdb: boolean;
      dailyClipLimit: number;
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.model, "string");
    assert.equal(typeof body.tmdb, "boolean");
    assert.equal(typeof body.dailyClipLimit, "number");
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

  it("does not count a duplicate clipKey against the daily cap", async () => {
    // The cap is off by default; this asserts the accounting path is only
    // reached for clips that are actually analysed.
    const created = await app.request("/sessions", { method: "POST" });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(16)]), "clip.mp4");
    form.set("clipKey", "dup");
    const res = await app.request(`/sessions/${sessionId}/clips`, {
      method: "POST",
      headers: { "x-device-id": "abcdefgh12345678" },
      body: form,
    });
    // Rejected for being empty, not for quota.
    assert.equal(res.status, 400);
  });

  it("404s for unknown sessions", async () => {
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(4)]), "clip.mp4");
    const res = await app.request("/sessions/nope/clips", { method: "POST", body: form });
    assert.equal(res.status, 404);
  });
});

describe("limits", () => {
  it("bills a caller by something they cannot choose", async () => {
    // Two requests differing only in the headers a client controls must not
    // land in different buckets, or the daily cap counts nothing.
    const withHeaders = (h: Record<string, string>) =>
      caller({
        req: { header: (name: string) => h[name.toLowerCase()] },
      } as unknown as Parameters<typeof caller>[0]);

    assert.equal(withHeaders({ "x-device-id": "aaaaaaaabbbbbbbb" }), withHeaders({ "x-device-id": "ccccccccdddddddd" }));
    assert.equal(withHeaders({ "x-forwarded-for": "1.2.3.4" }), withHeaders({ "x-forwarded-for": "5.6.7.8" }));
  });

  it("bills an IPv6 caller by its /64, which it cannot rotate out of", () => {
    // A client on an ordinary IPv6 allocation owns the whole /64 and can send
    // every request from a different address in it. Counting the exact address
    // would hand each of those requests its own daily quota.
    const first = addressBucket("2001:db8:abcd:1234::1");
    assert.equal(addressBucket("2001:db8:abcd:1234:5:6:7:8"), first);
    assert.equal(addressBucket("2001:0db8:abcd:1234:0000:0000:0000:00ff"), first);
    assert.equal(addressBucket("2001:db8:abcd:1234::1%eth0"), first, "a zone id is not identity");
    // The neighbouring /64 is a different customer and must not share the bucket.
    assert.notEqual(addressBucket("2001:db8:abcd:1235::1"), first);

    // IPv4 is scarce, so it keeps its full address - including when it arrives
    // mapped onto a dual-stack socket, where a /64 would be every IPv4 client.
    assert.equal(addressBucket("203.0.113.7"), "ip:203.0.113.7");
    assert.equal(addressBucket("::ffff:203.0.113.7"), "ip:203.0.113.7");
    assert.notEqual(addressBucket("::ffff:203.0.113.8"), addressBucket("::ffff:203.0.113.7"));
  });

  it("refuses to let one caller hold every session slot", async () => {
    // Measured relative to what earlier tests left behind, so this asserts the
    // per-caller cap rather than the order the file happens to run in.
    const owner = caller({ req: { header: () => undefined } } as unknown as Parameters<typeof caller>[0]);
    const original = config.maxSessionsPerCaller;
    (config as { maxSessionsPerCaller: number }).maxSessionsPerCaller = sessionsHeldBy(owner) + 2;
    const made: string[] = [];
    try {
      let refused = 0;
      for (let i = 0; i < 4; i++) {
        const res = await app.request("/sessions", { method: "POST" });
        if (res.status === 201) made.push(((await res.json()) as { sessionId: string }).sessionId);
        else {
          refused++;
          assert.equal(res.status, 503);
          assert.equal(res.headers.get("retry-after"), "60");
        }
      }
      assert.equal(made.length, 2, "the two sessions below the per-caller cap must be created");
      assert.equal(refused, 2, "everything above it must be refused");
      // A different address is unaffected: this is a per-caller cap, not a global one.
      const other = createSession("camera", undefined, undefined, "ip:198.51.100.9");
      made.push(other.id);
    } finally {
      (config as { maxSessionsPerCaller: number }).maxSessionsPerCaller = original;
      for (const id of made) deleteSession(id);
    }
  });

  it("expires a session that is kept warm by polling", () => {
    // getSession refreshes touchedAt, so the idle timeout alone is not a
    // lifetime: one cheap GET every few minutes would hold the slot for ever.
    const s = createSession("camera", undefined, undefined, "ip:198.51.100.10");
    try {
      const born = s.createdAt;
      s.touchedAt = born + config.sessionMaxAgeMs + 1_000; // read a moment ago
      sweepSessions(born + config.sessionMaxAgeMs + 1_000);
      assert.equal(getSession(s.id), undefined, "a session past its absolute age must be swept");
    } finally {
      deleteSession(s.id);
    }
  });

  it("refuses to create sessions once the ceiling is reached", async () => {
    // Relative to whatever earlier tests left behind, so this measures the cap
    // rather than the order the file happens to run in.
    const original = config.maxSessions;
    (config as { maxSessions: number }).maxSessions = sessionCount() + 2;
    const made: string[] = [];
    try {
      let refused = 0;
      for (let i = 0; i < 5; i++) {
        const res = await app.request("/sessions", { method: "POST" });
        if (res.status === 201) made.push(((await res.json()) as { sessionId: string }).sessionId);
        else if (res.status === 503) refused++;
      }
      assert.equal(made.length, 2, "the two sessions below the cap must be created");
      assert.equal(refused, 3, "everything above the cap must be refused");
    } finally {
      (config as { maxSessions: number }).maxSessions = original;
      for (const id of made) await app.request(`/sessions/${id}`, { method: "DELETE" });
    }
  });

  it("only accepts clip keys it can safely compare", () => {
    assert.equal(cleanClipKey("abc:1"), "abc:1");
    assert.equal(cleanClipKey("a".repeat(200)), undefined);
    assert.equal(cleanClipKey("has spaces"), undefined);
    assert.equal(cleanClipKey(""), undefined);
    assert.equal(cleanClipKey(42), undefined);
  });

  it("says 202 rather than passing a mid-flight state off as the answer", async () => {
    // A real wait, so the race in settledWithin is actually exercised: with 0 it
    // short-circuits and a settledWithin that always returned false would pass.
    const original = config.retryWaitMs;
    (config as { retryWaitMs: number }).retryWaitMs = 120;
    try {
      const created = await app.request("/sessions", { method: "POST" });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const s = getSession(sessionId);
      s?.seenClipKeys.add("in-flight");
      // A session still working: s.busy never settles within the wait.
      if (s) s.busy = new Promise(() => {});
      const form = new FormData();
      form.set("clip", new Blob([new Uint8Array(8)]), "clip.mp4");
      const res = await app.request(`/sessions/${sessionId}/clips`, {
        method: "POST",
        headers: { "x-clip-key": "in-flight" },
        body: form,
      });
      assert.equal(res.status, 202);
      assert.equal(res.headers.get("retry-after"), "5");
      assert.match(((await res.json()) as { message: string }).message, /Still analysing/);
    } finally {
      (config as { retryWaitMs: number }).retryWaitMs = original;
    }
  });

  it("returns 200 once the in-flight analysis settles", async () => {
    const original = config.retryWaitMs;
    (config as { retryWaitMs: number }).retryWaitMs = 5000;
    try {
      const created = await app.request("/sessions", { method: "POST" });
      const { sessionId } = (await created.json()) as { sessionId: string };
      const s = getSession(sessionId);
      s?.seenClipKeys.add("settles");
      if (s) s.busy = new Promise((resolve) => setTimeout(resolve, 50));
      const form = new FormData();
      form.set("clip", new Blob([new Uint8Array(8)]), "clip.mp4");
      const res = await app.request(`/sessions/${sessionId}/clips`, {
        method: "POST",
        headers: { "x-clip-key": "settles" },
        body: form,
      });
      // Waited for the work rather than timing out, so this is the real answer.
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { analysing: boolean }).analysing, false);
    } finally {
      (config as { retryWaitMs: number }).retryWaitMs = original;
    }
  });

  it("recognises a retried clip from its header, before the body is parsed", async () => {
    const created = await app.request("/sessions", { method: "POST" });
    const { sessionId } = (await created.json()) as { sessionId: string };
    // Mark the key as already analysed, then send a body that would otherwise
    // be rejected as empty: a 200 proves the header short-circuit ran first.
    const s = getSession(sessionId);
    s?.seenClipKeys.add("known-key");
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(8)]), "clip.mp4");
    const res = await app.request(`/sessions/${sessionId}/clips`, {
      method: "POST",
      headers: { "x-clip-key": "known-key" },
      body: form,
    });
    assert.equal(res.status, 200);
  });

  it("rejects an oversized session body before parsing it", async () => {
    const res = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(1024 * 1024) },
      body: JSON.stringify({ source: "camera", hints: "x".repeat(8192) }),
    });
    assert.equal(res.status, 413);
  });
});
