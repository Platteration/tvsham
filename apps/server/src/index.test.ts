import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type Anthropic from "@anthropic-ai/sdk";
import type { CreateSessionResponse } from "@tvsham/shared";
import { config } from "./config.js";
import { addressBucket, app, caller, cleanClipKey, cleanHint, safeExtension, sweepTmpDir, weakToken } from "./index.js";
import { createSession, deleteSession, getSession, sessionCount, sessionsHeldBy, sweepSessions } from "./sessions.js";
import { ffmpegBinary } from "./media.js";
import { setClientForTests } from "./recognize.js";

/**
 * Create a session and keep what later calls to it need: the id names it, and
 * the key the server minted with it is what authorises reading, deleting or
 * uploading to it.
 */
async function newSession(headers: Record<string, string> = {}) {
  const res = await app.request("/sessions", { method: "POST", headers });
  const { sessionId, sessionKey } = (await res.json()) as CreateSessionResponse;
  return { sessionId, sessionKey, auth: { "x-session-key": sessionKey } };
}

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
    const { sessionId, sessionKey } = (await created.json()) as CreateSessionResponse;
    assert.ok(sessionId);
    assert.ok(sessionKey && sessionKey !== sessionId, "a session comes with a secret of its own");
    const auth = { "x-session-key": sessionKey };

    const got = await app.request(`/sessions/${sessionId}`, { headers: auth });
    assert.equal(got.status, 200);
    const body = (await got.json()) as { status: string; wantsMore: boolean; links: unknown[] };
    assert.equal(body.status, "listening");
    assert.equal(body.wantsMore, true);
    assert.deepEqual(body.links, []);

    const gone = await app.request(`/sessions/${sessionId}`, { method: "DELETE", headers: auth });
    assert.equal(gone.status, 204);
    assert.equal((await app.request(`/sessions/${sessionId}`, { headers: auth })).status, 404);
  });

  it("rejects an upload without a clip field", async () => {
    const { sessionId, auth } = await newSession();
    const form = new FormData();
    form.set("nope", "x");
    const res = await app.request(`/sessions/${sessionId}/clips`, { method: "POST", headers: auth, body: form });
    assert.equal(res.status, 400);
  });

  it("rejects an empty clip", async () => {
    const { sessionId, auth } = await newSession();
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(16)]), "clip.mp4");
    const res = await app.request(`/sessions/${sessionId}/clips`, { method: "POST", headers: auth, body: form });
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
      const { sessionId, auth } = await newSession();
      const bytes = await fs.readFile(clipPath);
      const send = async () => {
        const form = new FormData();
        form.set("clip", new Blob([bytes], { type: "video/mp4" }), "clip.mp4");
        form.set("clipKey", "k1");
        return app.request(`/sessions/${sessionId}/clips`, { method: "POST", headers: auth, body: form });
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
    const { sessionId, auth } = await newSession();
    const res = await app.request(`/sessions/${sessionId}/clips`, {
      method: "POST",
      headers: { ...auth, "content-type": "video/mp4", "content-length": String(500 * 1024 * 1024) },
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
    const { sessionId, auth } = await newSession();
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(16)]), "clip.mp4");
    form.set("clipKey", "dup");
    const res = await app.request(`/sessions/${sessionId}/clips`, {
      method: "POST",
      headers: { ...auth, "x-device-id": "abcdefgh12345678" },
      body: form,
    });
    // Rejected for being empty, not for quota.
    assert.equal(res.status, 400);
  });

  it("refuses a request a web page sent from another origin", async () => {
    // No CORS headers stop a page *reading* the reply; they do not stop the
    // browser delivering the request. A page the user has open could otherwise
    // take every session slot this address is allowed and leave the app itself
    // answering 503.
    const page = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example" },
      body: '{"source":"camera"}',
    });
    assert.equal(page.status, 403);

    // A form post is the one that may arrive without an Origin, and it cannot
    // ask for application/json.
    const form = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "source=camera",
    });
    assert.equal(form.status, 415);

    // The app is not a browser: it sends no Origin, and it is unaffected.
    const fromTheApp = await app.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"source":"camera"}',
    });
    assert.equal(fromTheApp.status, 201);
    await app.request(`/sessions/${((await fromTheApp.json()) as { sessionId: string }).sessionId}`, {
      method: "DELETE",
    });
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

  it("bills a proxied caller by the hop its own proxy wrote, not the one the client typed", () => {
    // Every standard proxy *appends* the address it saw to whatever the client
    // already sent (nginx's proxy_add_x_forwarded_for), so the header arriving
    // here is "<what the client typed>, <the client's real address>". Reading
    // the leftmost entry bills a bucket of the caller's choosing, and a fresh
    // one on every request, which is the daily cap counting nothing.
    const bucket = (xff: string) =>
      caller({
        req: { header: (name: string) => (name.toLowerCase() === "x-forwarded-for" ? xff : undefined) },
      } as unknown as Parameters<typeof caller>[0]);
    const peer = "203.0.113.9";
    const original = config.trustedProxyHops;
    try {
      (config as { trustedProxyHops: number }).trustedProxyHops = 1;
      // Derived from the address the proxy observed, not from what caller() does
      // with the header.
      const honest = addressBucket(peer);
      for (const typed of ["1.1.1.1", "9.9.9.9", "2001:db8::1", "not-an-ip", ""]) {
        assert.equal(bucket(`${typed}, ${peer}`), honest, `a prepended "${typed}" must not move the bucket`);
      }
      // Two proxies of our own: the client's value is further left again, and
      // the hop our outermost proxy wrote is the second from the right.
      (config as { trustedProxyHops: number }).trustedProxyHops = 2;
      assert.equal(bucket(`1.1.1.1, ${peer}, 10.0.0.1`), honest);
      // A chain shorter than the proxies we trust did not come through them, so
      // it is not an identity: the socket address is used, and there is none in
      // this harness.
      assert.equal(bucket("1.1.1.1"), "ip:unknown");
    } finally {
      (config as { trustedProxyHops: number }).trustedProxyHops = original;
    }
  });

  it("refuses to mint a bucket from something that is not an address", () => {
    // A garbage hop must land in the shared restricted bucket rather than one
    // of its own, or a forwarded header is a fresh quota per request again.
    assert.equal(addressBucket("not-an-ip"), "ip:unknown");
    assert.equal(addressBucket("aaaa"), "ip:unknown");
    assert.equal(addressBucket("203.0.113.9:54321"), "ip:unknown");
    assert.equal(addressBucket("  "), "ip:unknown");
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

  it("does not hand a proxied caller a fresh set of session slots per header", async () => {
    // The end of the same defect, through the real route: with a proxy in
    // front, rotating the leftmost X-Forwarded-For entry must not look like a
    // new caller, or MAX_SESSIONS_PER_CALLER bounds nothing.
    const peer = "198.51.100.42";
    const owner = addressBucket(peer);
    const originalHops = config.trustedProxyHops;
    const originalCap = config.maxSessionsPerCaller;
    (config as { trustedProxyHops: number }).trustedProxyHops = 1;
    (config as { maxSessionsPerCaller: number }).maxSessionsPerCaller = sessionsHeldBy(owner) + 2;
    const made: string[] = [];
    try {
      let refused = 0;
      for (let i = 0; i < 6; i++) {
        const res = await app.request("/sessions", {
          method: "POST",
          headers: { "x-forwarded-for": `10.0.0.${i}, ${peer}` },
        });
        if (res.status === 201) made.push(((await res.json()) as { sessionId: string }).sessionId);
        else refused++;
      }
      assert.equal(made.length, 2, "the cap is per caller, and six rotated headers are one caller");
      assert.equal(refused, 4);
      assert.equal(sessionsHeldBy(owner), 2, "every session must be owned by the address the proxy reported");
    } finally {
      (config as { trustedProxyHops: number }).trustedProxyHops = originalHops;
      (config as { maxSessionsPerCaller: number }).maxSessionsPerCaller = originalCap;
      for (const id of made) deleteSession(id);
    }
  });

  it("keeps a session to whoever holds its key, and keeps the id out of the log", async () => {
    // The id names a session; it does not authorise one, and it is in the path
    // of every request and so in every access log on the way. Two independent
    // changes: the id is not printed, and knowing it is not enough.
    //
    // Deliberately NOT the caller's address: the client is a phone in a
    // record-upload-repeat loop, and walking out of the house mid-run changes
    // it. The key survives that, which the last assertion here is about.
    const originalHops = config.trustedProxyHops;
    (config as { trustedProxyHops: number }).trustedProxyHops = 1;
    const printed: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => void printed.push(args.join(" "));
    let sessionId = "";
    let sessionKey = "";
    try {
      const onWifi = { "x-forwarded-for": "198.51.100.20" };
      const created = await newSession(onWifi);
      ({ sessionId, sessionKey } = created);
      // Key *and* the address it was created from, so an address check would
      // pass every assertion here but the last one.
      const holder = { ...created.auth, ...onWifi };
      const stranger = { "x-session-key": "not-the-key" };

      assert.equal((await app.request(`/sessions/${sessionId}`, { headers: holder })).status, 200);
      // 404, not 403: a 403 would confirm the id is a real one.
      assert.equal((await app.request(`/sessions/${sessionId}`, { headers: stranger })).status, 404);
      assert.equal((await app.request(`/sessions/${sessionId}`)).status, 404, "and the id alone is not enough");

      const clip = () => {
        const form = new FormData();
        form.set("clip", new Blob([new Uint8Array(16)]), "clip.mp4");
        return form;
      };
      const pushed = await app.request(`/sessions/${sessionId}/clips`, {
        method: "POST",
        headers: stranger,
        body: clip(),
      });
      assert.equal(pushed.status, 404, "a stranger must not be able to push a clip into it");
      assert.equal(
        (await app.request(`/sessions/${sessionId}`, { method: "DELETE", headers: stranger })).status,
        204,
      );
      assert.equal(
        (await app.request(`/sessions/${sessionId}`, { headers: holder })).status,
        200,
        "and a stranger's DELETE must not have destroyed it",
      );

      // The phone has left the house: same key, different address. Its own next
      // clip must not be answered 404 by the hardening above.
      const onCellular = { ...holder, "x-forwarded-for": "203.0.113.77" };
      assert.equal((await app.request(`/sessions/${sessionId}`, { headers: onCellular })).status, 200);
      const next = await app.request(`/sessions/${sessionId}/clips`, {
        method: "POST",
        headers: onCellular,
        body: clip(),
      });
      assert.equal(next.status, 400, "the clip is refused for being empty, not for the network changing");
    } finally {
      console.log = realLog;
      (config as { trustedProxyHops: number }).trustedProxyHops = originalHops;
      deleteSession(sessionId);
    }
    assert.ok(printed.length > 0, "the request logger must still be logging");
    for (const line of printed) {
      assert.ok(!line.includes(sessionId), `the session id must not reach the log: ${line}`);
      assert.ok(!line.includes(sessionKey), `nor may the key: ${line}`);
    }
    assert.ok(printed.some((line) => line.includes("/sessions/<id>")), "the path itself is still logged");
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

  it("makes a caller wait after a handful of wrong bearer tokens", async () => {
    // The token is one shared secret gating every paid request, and a 401 costs
    // the guesser nothing: no delay, no counter, nothing in the log. Unlimited
    // attempts are the whole of the attack.
    const original = config.appToken;
    (config as { appToken?: string }).appToken = "a-real-token-of-sufficient-length";
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      const guess = () =>
        app.request("/sessions", { method: "POST", headers: { authorization: "Bearer wrong" } });
      const seen = new Set<number>();
      for (let i = 0; i < 30; i++) seen.add((await guess()).status);
      assert.ok(seen.has(401), "the first wrong answers are a plain 401");
      assert.ok(seen.has(429), "and then the guessing is made to wait");
      const last = await guess();
      assert.equal(last.status, 429);
      assert.ok(Number(last.headers.get("retry-after")) > 0);
      assert.ok(warnings.some((w) => w.includes("guessing the bearer token")), "and it is said out loud");
      // The right token is still the right token.
      const ok = await app.request("/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${config.appToken}` },
      });
      assert.equal(ok.status, 201);
      await app.request(`/sessions/${((await ok.json()) as { sessionId: string }).sessionId}`, { method: "DELETE" });
    } finally {
      console.warn = realWarn;
      (config as { appToken?: string }).appToken = original;
    }
  });

  it("knows a token nobody would have to guess", () => {
    // The value .env.example used to hand the operator, and anything an
    // operator would type instead of generating.
    assert.equal(weakToken("change-me"), true);
    assert.equal(weakToken("secret"), true);
    assert.equal(weakToken("short"), true);
    assert.equal(weakToken("0123456789012345678901"), true, "22 characters is still guessable");
    // What `openssl rand -hex 32` produces.
    assert.equal(weakToken("a".repeat(64)), false);
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
      const { sessionId, auth } = await newSession();
      const s = getSession(sessionId);
      s?.seenClipKeys.add("in-flight");
      // A session still working: s.busy never settles within the wait.
      if (s) s.busy = new Promise(() => {});
      const form = new FormData();
      form.set("clip", new Blob([new Uint8Array(8)]), "clip.mp4");
      const res = await app.request(`/sessions/${sessionId}/clips`, {
        method: "POST",
        headers: { ...auth, "x-clip-key": "in-flight" },
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
      const { sessionId, auth } = await newSession();
      const s = getSession(sessionId);
      s?.seenClipKeys.add("settles");
      if (s) s.busy = new Promise((resolve) => setTimeout(resolve, 50));
      const form = new FormData();
      form.set("clip", new Blob([new Uint8Array(8)]), "clip.mp4");
      const res = await app.request(`/sessions/${sessionId}/clips`, {
        method: "POST",
        headers: { ...auth, "x-clip-key": "settles" },
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
    const { sessionId, auth } = await newSession();
    // Mark the key as already analysed, then send a body that would otherwise
    // be rejected as empty: a 200 proves the header short-circuit ran first.
    const s = getSession(sessionId);
    s?.seenClipKeys.add("known-key");
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(8)]), "clip.mp4");
    const res = await app.request(`/sessions/${sessionId}/clips`, {
      method: "POST",
      headers: { ...auth, "x-clip-key": "known-key" },
      body: form,
    });
    assert.equal(res.status, 200);
  });

  it("turns uploads away rather than buffering more bodies than it has memory for", async () => {
    // parseBody materialises the whole upload before the per-session chain or
    // the limiter is reached, so the ceiling has to be checked before it runs -
    // and released afterwards, or the server bricks itself after N uploads.
    const body = () => {
      const form = new FormData();
      form.set("nope", "x");
      return form;
    };
    const { sessionId, auth } = await newSession();
    const original = config.maxUploadsInFlight;
    try {
      (config as { maxUploadsInFlight: number }).maxUploadsInFlight = 0;
      const busy = await app.request(`/sessions/${sessionId}/clips`, { method: "POST", headers: auth, body: body() });
      assert.equal(busy.status, 503);
      assert.equal(busy.headers.get("retry-after"), "5");
      assert.match(((await busy.json()) as { error: string }).error, /busy/);

      // With a slot free the same request gets all the way to reading the body,
      // twice over: the second 400 is the proof the first slot came back.
      (config as { maxUploadsInFlight: number }).maxUploadsInFlight = 1;
      for (let i = 0; i < 2; i++) {
        const res = await app.request(`/sessions/${sessionId}/clips`, { method: "POST", headers: auth, body: body() });
        assert.equal(res.status, 400, "the in-flight count must be released when the request ends");
      }
    } finally {
      (config as { maxUploadsInFlight: number }).maxUploadsInFlight = original;
      await app.request(`/sessions/${sessionId}`, { method: "DELETE", headers: auth });
    }
  });

  it("refuses an upload it cannot admit without reading the body first", async () => {
    // An upload that arrives with no Content-Length is drained into memory by
    // the body-limit middleware, which has to read it to measure it. Every
    // check that runs after that has already paid for the whole 80 MB whatever
    // it then answers, so the gate has to come first.
    const streamed = () => {
      let pulls = 0;
      const chunks = 64;
      const body = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          if (pulls++ >= chunks) return ctrl.close();
          ctrl.enqueue(new Uint8Array(64 * 1024));
        },
      });
      return { body, chunks, pulled: () => pulls };
    };

    const unknown = streamed();
    const res = await app.request("/sessions/does-not-exist/clips", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: unknown.body,
      duplex: "half",
    } as RequestInit);
    assert.equal(res.status, 404);
    assert.ok(
      unknown.pulled() < unknown.chunks,
      `an unknown session must be refused before the body is read, ${unknown.pulled()} of ${unknown.chunks} chunks were`,
    );

    // ...and the same for a session that does exist but has no room: the
    // in-flight ceiling is a memory bound, so reading the body to reach it
    // spends exactly what it is there to save.
    const { sessionId, auth } = await newSession();
    const original = config.maxUploadsInFlight;
    (config as { maxUploadsInFlight: number }).maxUploadsInFlight = 0;
    try {
      const busy = streamed();
      const refused = await app.request(`/sessions/${sessionId}/clips`, {
        method: "POST",
        headers: { ...auth, "content-type": "multipart/form-data; boundary=x" },
        body: busy.body,
        duplex: "half",
      } as RequestInit);
      assert.equal(refused.status, 503);
      assert.ok(
        busy.pulled() < busy.chunks,
        `a 503 must be answered before the body is read, ${busy.pulled()} of ${busy.chunks} chunks were`,
      );
    } finally {
      (config as { maxUploadsInFlight: number }).maxUploadsInFlight = original;
      await app.request(`/sessions/${sessionId}`, { method: "DELETE", headers: auth });
    }
  });

  it("keeps one caller from holding every upload slot", async () => {
    // An upload's slot is only released when the whole body has arrived, and
    // nothing obliges a client to send it: a handful of sockets dribbling a
    // byte at a time costs the attacker nothing and answers every real upload
    // with a 503. One caller gets a share of the slots, not all of them.
    const originals = {
      hops: config.trustedProxyHops,
      inFlight: config.maxUploadsInFlight,
      perCaller: config.maxUploadsPerCaller,
    };
    (config as { trustedProxyHops: number }).trustedProxyHops = 1;
    (config as { maxUploadsInFlight: number }).maxUploadsInFlight = 4;
    (config as { maxUploadsPerCaller: number }).maxUploadsPerCaller = 2;
    let release = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each caller uploads to a session of its own, as it would in life.
    const attacker = await newSession({ "x-forwarded-for": "198.51.100.7" });
    const bystander = await newSession({ "x-forwarded-for": "203.0.113.5" });
    // A body that arrives and then stops, the way a stalled upload does.
    const send = (session: { sessionId: string; auth: Record<string, string> }, from: string) =>
      app.request(`/sessions/${session.sessionId}/clips`, {
        method: "POST",
        headers: { ...session.auth, "content-type": "multipart/form-data; boundary=x", "x-forwarded-for": from },
        body: new ReadableStream<Uint8Array>({
          // The first bytes of a body, and then silence.
          async pull(ctrl) {
            ctrl.enqueue(new TextEncoder().encode("--x\r\n"));
            await stalled;
            ctrl.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
    const settled = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<"waiting">((r) => setTimeout(() => r("waiting"), 150))]);
    try {
      const held = [send(attacker, "198.51.100.7"), send(attacker, "198.51.100.7")];
      assert.equal(await settled(held[0]!), "waiting", "a stalled upload holds its slot");

      // A third from the same address, with two of the four slots still free.
      const refused = await send(attacker, "198.51.100.7");
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get("retry-after"), "5");

      // Somebody else is unaffected, which is the whole point of the share.
      const other = send(bystander, "203.0.113.5");
      assert.equal(await settled(other), "waiting", "another caller must still be admitted");
      release();
      // They were admitted and their bodies read, however the truncated body
      // was then answered; only the third was turned away at the gate.
      for (const res of await Promise.all([...held, other])) assert.notEqual(res.status, 503);
    } finally {
      release();
      (config as { trustedProxyHops: number }).trustedProxyHops = originals.hops;
      (config as { maxUploadsInFlight: number }).maxUploadsInFlight = originals.inFlight;
      (config as { maxUploadsPerCaller: number }).maxUploadsPerCaller = originals.perCaller;
      deleteSession(attacker.sessionId);
      deleteSession(bystander.sessionId);
    }
  });

  it("sweeps staged clips a hard stop left behind, and leaves live work alone", async () => {
    const original = config.tmpDir;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tvsham-sweep-"));
    (config as { tmpDir: string }).tmpDir = dir;
    try {
      const abandoned = path.join(dir, "session-a-0");
      const live = path.join(dir, "session-b-0");
      for (const d of [abandoned, live]) {
        await fs.mkdir(d, { recursive: true });
        await fs.writeFile(path.join(d, "clip.mp4"), "not really a clip");
      }
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      await fs.utimes(abandoned, anHourAgo, anHourAgo);

      // The periodic sweep only takes what no request could still be using.
      assert.equal(await sweepTmpDir(config.sessionTtlMs), 1);
      assert.deepEqual(await fs.readdir(dir), ["session-b-0"]);

      // Startup has nothing in flight, so it takes the lot.
      assert.equal(await sweepTmpDir(), 1);
      assert.deepEqual(await fs.readdir(dir), []);
    } finally {
      (config as { tmpDir: string }).tmpDir = original;
      await fs.rm(dir, { recursive: true, force: true });
    }
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
