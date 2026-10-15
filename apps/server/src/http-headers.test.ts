import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { API_HEADERS, app } from "./index.js";

/**
 * The API's headers over a real socket, through the adapter main() serves with. A file of its
 * own because `serve` replaces the global Response with @hono/node-server's lighter one, as it
 * does in production, and the other suites run against the native one: under the adapter a
 * HEAD is answered with a Response built from the GET one's original headers, and headers set
 * on the finished response were lost there while every app.request() test passed.
 */
describe("the API's headers on the wire", () => {
  let server: ReturnType<typeof serve>;
  let base = "";

  before(async () => {
    await new Promise<void>((done) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        base = `http://127.0.0.1:${info.port}`;
        done();
      });
    });
  });
  after(() => new Promise<void>((done) => server.close(() => done())));

  for (const [method, path, status] of [
    ["GET", "/health", 200],
    ["HEAD", "/health", 200],
    ["GET", "/no-such-route", 404],
    ["HEAD", "/no-such-route", 404],
    ["GET", "/sessions/nope", 404],
  ] as const) {
    it(`${method} ${path}`, async () => {
      const res = await fetch(`${base}${path}`, { method });
      await res.arrayBuffer();
      assert.equal(res.status, status);
      for (const [name, value] of Object.entries(API_HEADERS)) assert.equal(res.headers.get(name), value, name);
    });
  }

  it("a request from another origin, refused", async () => {
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    await res.arrayBuffer();
    assert.equal(res.status, 403);
    for (const [name, value] of Object.entries(API_HEADERS)) assert.equal(res.headers.get(name), value, name);
  });
});
