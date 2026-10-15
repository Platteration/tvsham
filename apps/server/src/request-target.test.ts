import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import net, { type AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { API_HEADERS, app } from "./index.js";

/**
 * A request target is routed as it was written (targetAsWritten in index.ts), over a real socket
 * through the adapter main() serves with: `fetch` and app.request() both parse the address before
 * anything is sent, so neither can put a backslash or a dot segment on the wire, and only a raw
 * request line reaches the server the way a reverse proxy passes one on.
 *
 * What it is for: the website's nginx hands this server `/api/` alone and passes the target on as
 * the client wrote it, and nginx reads a backslash as a character where the URL parser here reads
 * a slash. `/api/..\..\health` is under `/api/` to nginx and was `/health` here; `/api/..\..\sessions`
 * opened sessions past the account's mount.
 */
describe("a request target, routed as written", () => {
  let server: ReturnType<typeof serve>;
  let port = 0;

  before(async () => {
    await new Promise<void>((done) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        port = info.port;
        done();
      });
    });
  });
  after(() => new Promise<void>((done) => server.close(() => done())));

  /** One request line exactly as given, and the status, headers and body that came back. */
  function raw(method: string, target: string, headers: Record<string, string> = {}, body = "") {
    return new Promise<{ status: number; headers: Map<string, string>; body: string }>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        const lines = [`${method} ${target} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close", `Content-Length: ${Buffer.byteLength(body)}`];
        for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
        socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
      });
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("end", () => {
        const text = Buffer.concat(chunks).toString("latin1");
        const split = text.indexOf("\r\n\r\n");
        const [statusLine = "", ...headerLines] = text.slice(0, split).split("\r\n");
        const parsed = new Map<string, string>();
        for (const line of headerLines) {
          const colon = line.indexOf(":");
          parsed.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
        let rest = text.slice(split + 4);
        // The adapter streams a JSON answer in chunks: undo the framing so the body reads as sent.
        if (parsed.get("transfer-encoding") === "chunked") {
          let out = "";
          for (;;) {
            const eol = rest.indexOf("\r\n");
            const size = parseInt(rest.slice(0, eol), 16);
            if (!size) break;
            out += rest.slice(eol + 2, eol + 2 + size);
            rest = rest.slice(eol + 2 + size + 2);
          }
          rest = out;
        }
        resolve({ status: Number(statusLine.split(" ")[1]), headers: parsed, body: rest });
      });
    });
  }

  it("refuses a backslash in the path, which the URL parser reads as a slash, before any route sees it", async () => {
    // The control: the route itself answers.
    const health = await raw("GET", "/health");
    assert.equal(health.status, 200);
    assert.match(health.body, /"ok":true/);
    for (const target of ["/api/..\\..\\health", "/api\\..\\health", "/api/x/..\\..\\..\\health"]) {
      const res = await raw("GET", target);
      assert.equal(res.status, 400, target);
      assert.doesNotMatch(res.body, /"ok":true/, `${target} is not the health check`);
      assert.deepEqual(JSON.parse(res.body), { error: "request target not as written" }, target);
      for (const [name, value] of Object.entries(API_HEADERS)) assert.equal(res.headers.get(name.toLowerCase()), value, `${target}: ${name}`);
    }
    // Opening a session needs no token in this suite, so a target that reached the route would be a 201.
    assert.equal((await raw("POST", "/sessions", { "content-type": "application/json" }, "{}")).status, 201, "the control: the route opens one");
    const session = await raw("POST", "/api/..\\..\\sessions", { "content-type": "application/json" }, "{}");
    assert.equal(session.status, 400);
    assert.doesNotMatch(session.body, /sessionKey/);
  });

  it("refuses what else the parser would rewrite: dot segments, encoded or not, and a fragment", async () => {
    for (const target of ["/x/../health", "/api/%2e%2e/health", "/api/.%2E/health", "/api/./config", "/health#/../api/config", "/sessions#x"]) {
      const res = await raw("GET", target);
      assert.equal(res.status, 400, target);
      assert.deepEqual(JSON.parse(res.body), { error: "request target not as written" }, target);
    }
  });

  it("routes a target written as it is read, the query left as it came", async () => {
    // The account's own answer, below /api/: nothing configured here, so its config says so.
    const config = await raw("GET", "/api/config");
    assert.equal(config.status, 200);
    assert.deepEqual(JSON.parse(config.body), { auth: { google: false }, shop: { products: [] } });
    // A backslash after the `?` is the query's own: the parser leaves it there, and so does this.
    const queried = await raw("GET", "/health?x=..\\..\\sessions");
    assert.equal(queried.status, 200);
    assert.match(queried.body, /"ok":true/);
    // An escaped backslash stays escaped in the path the server routes, so it is the kit's to answer.
    const escaped = await raw("GET", "/api/..%5C..%5Chealth");
    assert.equal(escaped.status, 404);
    assert.deepEqual(JSON.parse(escaped.body), { error: "not_found" });
    assert.equal((await raw("GET", "/no-such-route")).status, 404);
  });
});
