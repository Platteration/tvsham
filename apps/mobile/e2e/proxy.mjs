// The website's api/ proxy, run for real: deploy/nginx.conf in the nginx installed here, and the
// stand-in host the browser suite loads the site through (serve.mjs), each in front of a recorder
// that answers every request with 200 and keeps what reached it. The same raw requests go through
// both, and both must give the same answers. Run by `npm run test:e2e` before the browser suite.
//
// Why: the recognition server answers more than the account (/health, /sessions), and nginx and the
// server read a request target differently. nginx takes a backslash for an ordinary character, so
// /api/..\..\sessions is under /api/ to it, and passes the target on as written; the server's URL
// parser takes the backslash for a slash and routed /sessions. And the location passed on the
// client's own X-Forwarded-For, whose rightmost entry the server bills under TRUST_PROXY. So the
// location refuses a backslash in the path and appends the address it saw, and this checks that
// nothing with a backslash in its path reaches the server and that the rightmost entry the server
// receives is always the connecting address. (The server refuses such a target too, whatever proxy
// is in front: apps/server/src/request-target.test.ts.)
//
// What is changed in deploy/nginx.conf to run it, and nothing else (each must be found once): the
// listen lines move to loopback ports and lose TLS, the certificate lines go, `http2 on;` goes
// (nginx before 1.25.1, which Ubuntu 24.04 and GitHub's runner ship, refuses the whole file over
// it: a known gap of the file, left for its own change), root is apps/mobile/public, and
// proxy_pass names the recorder. Where nginx is not installed it says so and passes, unless CI is
// set, where it fails.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listen, siteHandler } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, "..");
const publicDir = join(mobile, "public");
const HSTS = "max-age=31536000; includeSubDomains";

// ---------------------------------------------------------------- the recorder

const received = [];
const recorder = createServer((req, res) => {
  received.push({ method: req.method, url: req.url, xff: req.headers["x-forwarded-for"] ?? null });
  req.resume();
  req.on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end('{"recorded":true}'));
});
await new Promise((done) => recorder.listen(0, "127.0.0.1", done));
const recorderPort = recorder.address().port;

// ---------------------------------------------------------------- the requests

/**
 * Each request, as a client writes it on the wire, and what must come of it: the status, and what
 * the server behind the proxy receives (null: nothing reaches it).
 */
const REQUESTS = [
  {
    what: "the account's config: the caller's X-Forwarded-For kept, the address the proxy saw appended",
    method: "GET",
    target: "/api/config",
    headers: { "X-Forwarded-For": "203.0.113.7" },
    status: 200,
    upstream: { url: "/api/config", xff: "203.0.113.7, 127.0.0.1" },
  },
  {
    what: "a chain the caller wrote: still the proxy's own entry on the right",
    method: "GET",
    target: "/api/me",
    headers: { "X-Forwarded-For": "198.51.100.1, 198.51.100.2" },
    status: 200,
    upstream: { url: "/api/me", xff: "198.51.100.1, 198.51.100.2, 127.0.0.1" },
  },
  {
    what: "no X-Forwarded-For: the address the proxy saw",
    method: "GET",
    target: "/api/me",
    headers: {},
    status: 200,
    upstream: { url: "/api/me", xff: "127.0.0.1" },
  },
  {
    what: "a backslash: under /api/ to nginx, /health to the server's URL parser",
    method: "GET",
    target: "/api/..\\..\\health",
    headers: {},
    status: 400,
    upstream: null,
  },
  {
    what: "a backslash on the way to opening a session, with a chosen X-Forwarded-For",
    method: "POST",
    target: "/api/..\\..\\sessions",
    headers: { "X-Forwarded-For": "198.51.100.3", "Content-Type": "application/json" },
    status: 400,
    upstream: null,
  },
  {
    what: "a backslash on the way to a session's clips",
    method: "POST",
    target: "/api/auth/..\\..\\..\\sessions\\abc\\clips",
    headers: {},
    status: 400,
    upstream: null,
  },
  {
    what: "a backslash in the query is the query's, and passed on as written",
    method: "GET",
    target: "/api/auth/google/start?return=..\\..\\x",
    headers: {},
    status: 200,
    upstream: { url: "/api/auth/google/start?return=..\\..\\x", xff: "127.0.0.1" },
  },
  {
    what: "an escaped backslash is passed on escaped (the server reads it as a path under /api/)",
    method: "GET",
    target: "/api/..%5C..%5Chealth",
    headers: {},
    status: 200,
    upstream: { url: "/api/..%5C..%5Chealth", xff: "127.0.0.1" },
  },
  {
    what: "dot segments nginx resolves to /api/ are passed on as written (the server refuses them)",
    method: "GET",
    target: "/x/../api/config",
    headers: {},
    status: 200,
    upstream: { url: "/x/../api/config", xff: "127.0.0.1" },
  },
  {
    what: "a path outside /api/ is the site's, never the server's",
    method: "GET",
    target: "/health",
    headers: {},
    status: 404,
    upstream: null,
  },
  {
    what: "nor one that resolves out of /api/",
    method: "GET",
    target: "/api/../sessions",
    headers: {},
    status: 404,
    upstream: null,
  },
];

/** One request line exactly as given, over its own connection; the status that came back. */
function send(port, { method, target, headers }) {
  return new Promise((resolveStatus, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      const lines = [`${method} ${target} HTTP/1.1`, "Host: tvsham.example.com", "Connection: close", "Content-Length: 0"];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let text = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => (text += chunk));
    socket.on("error", reject);
    socket.on("end", () => resolveStatus(Number(text.split("\r\n", 1)[0].split(" ")[1])));
  });
}

/** Every request through the host at `port`: its status, and what reached the recorder. */
async function through(port) {
  const out = [];
  for (const request of REQUESTS) {
    received.length = 0;
    const status = await send(port, request);
    const reached = received.map(({ url, xff }) => ({ url, xff }));
    out.push({ what: request.what, status, upstream: reached[0] ?? null, more: reached.length > 1 });
  }
  return out;
}

const expected = REQUESTS.map(({ what, status, upstream }) => ({ what, status, upstream, more: false }));
let failed = false;
function check(host, results) {
  for (const [i, got] of results.entries()) {
    try {
      assert.deepEqual(got, expected[i]);
      console.log(`  ok   ${host}: ${got.what}`);
    } catch {
      failed = true;
      console.error(`  FAIL ${host}: ${got.what}\n       expected ${JSON.stringify(expected[i])}\n       got      ${JSON.stringify(got)}`);
    }
  }
}

// ---------------------------------------------------------------- the stand-in host

console.log("- the stand-in host (e2e/serve.mjs), as the browser suite uses it");
const standIn = await listen(siteHandler({ dir: publicDir, base: "", api: { origin: `http://127.0.0.1:${recorderPort}`, headers: [["Strict-Transport-Security", HSTS]] } }));
check("stand-in", await through(Number(new URL(standIn.origin).port)));
await standIn.close();

// ---------------------------------------------------------------- nginx

const nginx = ["nginx", "/usr/sbin/nginx"].find((bin) => spawnSync(bin, ["-v"]).status === 0);
if (!nginx) {
  console.log("- nginx is not installed here: deploy/nginx.conf's api/ location was not run");
  if (process.env.CI) failed = true;
} else {
  console.log(`- deploy/nginx.conf in ${spawnSync(nginx, ["-v"], { encoding: "utf8" }).stderr.trim()}`);
  const work = mkdtempSync(join(tmpdir(), "tvsham-proxy-"));
  // nginx started by root hands its workers to an unprivileged user, who must reach this folder.
  chmodSync(work, 0o755);
  const free = () =>
    new Promise((done) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = s.address();
        s.close(() => done(port));
      });
    });
  const [plain, secure] = [await free(), await free()];
  let site = readFileSync(join(mobile, "deploy/nginx.conf"), "utf8");
  const swap = (from, to) => {
    const count = site.split(from).length - 1;
    assert.equal(count, 1, `deploy/nginx.conf holds ${JSON.stringify(from)} once (found ${count}): the harness no longer matches the file`);
    site = site.replace(from, to);
  };
  swap("    listen 80;\n", `    listen 127.0.0.1:${plain};\n`);
  swap("    listen [::]:80;\n", "");
  swap("    listen 443 ssl;\n", `    listen 127.0.0.1:${secure};\n`);
  swap("    listen [::]:443 ssl;\n", "");
  swap("    http2 on;\n", "");
  swap("    ssl_certificate     /etc/letsencrypt/live/tvsham.example.com/fullchain.pem;\n", "");
  swap("    ssl_certificate_key /etc/letsencrypt/live/tvsham.example.com/privkey.pem;\n", "");
  swap("    root /var/www/tvsham-web;\n", `    root ${publicDir};\n`);
  swap("        proxy_pass http://127.0.0.1:8787;\n", `        proxy_pass http://127.0.0.1:${recorderPort};\n`);
  writeFileSync(join(work, "site.conf"), site);
  writeFileSync(
    join(work, "nginx.conf"),
    [
      "worker_processes 1;",
      `pid ${join(work, "nginx.pid")};`,
      "events { worker_connections 64; }",
      "http {",
      `  access_log ${join(work, "access.log")};`,
      ...["client_body", "proxy", "fastcgi", "uwsgi", "scgi"].map((name) => `  ${name}_temp_path ${join(work, name)};`),
      `  include ${join(work, "site.conf")};`,
      "}",
      "",
    ].join("\n"),
  );
  const args = ["-p", work, "-e", join(work, "error.log"), "-c", join(work, "nginx.conf")];
  const tested = spawnSync(nginx, [...args, "-t"], { encoding: "utf8" });
  assert.equal(tested.status, 0, `nginx -t refused the configuration:\n${tested.stderr}`);
  const server = spawn(nginx, [...args, "-g", "daemon off;"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (chunk) => (stderr += chunk));
  try {
    for (let i = 0; ; i++) {
      const up = await new Promise((done) => {
        const s = net.connect(secure, "127.0.0.1", () => s.end(() => done(true)));
        s.on("error", () => done(false));
      });
      if (up) break;
      assert.ok(i < 100 && server.exitCode === null, `nginx did not start:\n${stderr}`);
      await new Promise((done) => setTimeout(done, 50));
    }
    check("nginx", await through(secure));
  } finally {
    server.kill("SIGTERM");
    await new Promise((done) => (server.exitCode === null ? server.once("exit", done) : done()));
    rmSync(work, { recursive: true, force: true });
  }
}

recorder.close();
if (failed) {
  console.error("\nThe api/ proxy failed.");
  process.exit(1);
}
console.log("\nThe api/ proxy passed.");
