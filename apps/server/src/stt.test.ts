import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { config } from "./config.js";
import { setFetchForTests } from "./http.js";
import { sttProvider, sttWarning } from "./stt.js";

type SttConfig = { provider: string; url?: string; timeoutMs: number };
const stt = config.stt as unknown as SttConfig;

describe("speech to text", () => {
  const original = { provider: stt.provider, url: stt.url, timeoutMs: stt.timeoutMs };
  let wav = "";

  before(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tvsham-stt-"));
    wav = path.join(dir, "audio.wav");
    await fs.writeFile(wav, Buffer.alloc(2048));
  });

  after(async () => {
    Object.assign(stt, original);
    setFetchForTests(null);
    await fs.rm(path.dirname(wav), { recursive: true, force: true });
  });

  it("stays off when transcription is asked for without an address to send to", () => {
    // The default used to be a hosted third party, so turning dialogue on
    // quietly uploaded a minute of the room to a company nobody chose.
    Object.assign(stt, { provider: "whisper-http", url: undefined });
    assert.equal(sttProvider().name, "none");
    assert.match(String(sttWarning()), /STT_URL/);

    Object.assign(stt, { provider: "whisper-http", url: "http://127.0.0.1:9/v1/audio/transcriptions" });
    assert.equal(sttProvider().name, "whisper-http");
    assert.equal(sttWarning(), null);
  });

  it("sends audio only through the injectable client, with a deadline on it", async () => {
    Object.assign(stt, { provider: "whisper-http", url: "http://127.0.0.1:9/v1/audio/transcriptions" });
    const seen: Array<{ url: string; hasSignal: boolean; method?: string }> = [];
    setFetchForTests((async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), hasSignal: Boolean(init?.signal), method: init?.method });
      return Response.json({ text: "  they were the best of times  " });
    }) as unknown as typeof fetch);

    assert.equal(await sttProvider().transcribe(wav), "they were the best of times");
    assert.deepEqual(seen.map((s) => s.url), ["http://127.0.0.1:9/v1/audio/transcriptions"]);
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.hasSignal, true, "an outbound call without a deadline holds an analysis slot for ever");
  });

  it("gives up on an endpoint that never answers instead of holding the slot", async () => {
    Object.assign(stt, { provider: "whisper-http", url: "http://127.0.0.1:9/v1/audio/transcriptions", timeoutMs: 60 });
    // Answers only when the caller aborts, which is what a hung server looks like.
    setFetchForTests((async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
      });
    }) as unknown as typeof fetch);

    const started = Date.now();
    // AbortSignal.timeout does not hold the event loop open by itself; the real
    // server is held open by its listener, and this test needs its own.
    const keepAlive = setInterval(() => {}, 10);
    try {
      // A missing transcript is a supported outcome; failing the clip is not.
      assert.equal(await sttProvider().transcribe(wav), null);
    } finally {
      clearInterval(keepAlive);
    }
    assert.ok(Date.now() - started < 5_000, "the deadline, not the endpoint, decided when to stop waiting");
  });

  it("treats a refused endpoint as a missing transcript, not a failed clip", async () => {
    Object.assign(stt, { provider: "whisper-http", url: "http://127.0.0.1:9/v1/audio/transcriptions" });
    setFetchForTests((async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch);
    assert.equal(await sttProvider().transcribe(wav), null);
  });
});
