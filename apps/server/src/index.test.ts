import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { app } from "./index.js";

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

  it("404s for unknown sessions", async () => {
    const form = new FormData();
    form.set("clip", new Blob([new Uint8Array(4)]), "clip.mp4");
    const res = await app.request("/sessions/nope/clips", { method: "POST", body: form });
    assert.equal(res.status, 404);
  });
});
