// A static host for the built website that behaves the way the hosts it is written for do: it reads
// _headers and _redirects (Netlify and Cloudflare Pages syntax) out of the published folder and
// applies them as written, serves the site under a sub-path, and answers anything it does not hold
// with 404.html and a 404. The browser suite (web.mjs) loads the site through it, so the headers
// the browser enforces are the ones the repository ships, not a copy of them.
//
// What it emulates and what it does not:
//  - _headers: every rule whose path matches adds its headers; a header two rules both set is
//    joined with ", ", which is what Netlify and Cloudflare Pages do (and why each file must get
//    Cache-Control from exactly one rule).
//  - _redirects: the first rule whose path matches wins, and a 200 serves the target in place.
//    As on Netlify, a rule without "!" does not shadow a file that exists, except a 404 rule,
//    which this server applies whatever exists so that the site's own refusals are tested.
//  - Paths in both files are relative to the site's root, wherever the site is mounted: the
//    folder is served under `base` the way a host serves a publish folder at a path.
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** _headers as rules: [{ path, headers: [[name, value], ...] }], in file order. */
export function parseHeaders(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      rules.push({ path: line.trim(), headers: [] });
      continue;
    }
    const rule = rules[rules.length - 1];
    if (!rule) throw new Error(`_headers: a header before any path: ${line}`);
    const colon = line.indexOf(":");
    if (colon < 0) throw new Error(`_headers: not a header line: ${line}`);
    rule.headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return rules;
}

/** _redirects as rules: [{ from, to, status, force }], in file order. */
export function parseRedirects(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [from, to, code = "301"] = line.split(/\s+/);
    if (!from || !to) throw new Error(`_redirects: not a rule: ${line}`);
    const force = code.endsWith("!");
    rules.push({ from, to, status: Number(force ? code.slice(0, -1) : code), force });
  }
  return rules;
}

/** Netlify path matching: an exact path, or a prefix ending in "*" that matches the rest. */
export function pathMatches(pattern, path) {
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return pattern === path;
}

/** The headers every rule matching `path` adds, joined as the hosts join them. */
export function headersFor(rules, path) {
  const out = new Map();
  for (const rule of rules) {
    if (!pathMatches(rule.path, path)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      const prior = out.get(key);
      out.set(key, prior ? { name: prior.name, value: `${prior.value}, ${value}` } : { name, value });
    }
  }
  return [...out.values()].map(({ name, value }) => [name, value]);
}

/** A file inside `dir` for a site path, or null. Never outside it. */
function fileFor(dir, sitePath) {
  const rel = normalize(sitePath).replace(/^([/\\])+/, "");
  const full = join(dir, rel);
  if (full !== dir && !full.startsWith(dir + sep)) return null;
  if (!existsSync(full)) return null;
  if (statSync(full).isDirectory()) {
    const index = join(full, "index.html");
    return existsSync(index) ? index : null;
  }
  return full;
}

/**
 * The request handler for `dir` served at `base`. `log` records every request as
 * { method, path, status }.
 */
export function siteHandler({ dir, base = "", log = [] }) {
  const rules = parseHeaders(readFileSync(join(dir, "_headers"), "utf8"));
  const redirects = parseRedirects(readFileSync(join(dir, "_redirects"), "utf8"));
  return (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://site").pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const send = (status, sitePath, file) => {
      for (const [name, value] of headersFor(rules, sitePath)) res.setHeader(name, value);
      const body = file ? readFileSync(file) : Buffer.alloc(0);
      res.setHeader("Content-Type", (file && TYPES[extname(file)]) || "application/octet-stream");
      res.setHeader("Content-Length", body.length);
      res.writeHead(status);
      res.end(req.method === "HEAD" ? undefined : body);
      log.push({ method: req.method, path: pathname, status });
    };
    if (pathname !== base && !pathname.startsWith(`${base}/`)) {
      // Outside the mount: what the host's root holds, which is not this site.
      res.writeHead(404, { "Content-Type": "text/plain" }).end("outside the site");
      log.push({ method: req.method, path: pathname, status: 404 });
      return;
    }
    const sitePath = pathname.slice(base.length) || "/";
    const notFound = () => send(404, sitePath, fileFor(dir, "/404.html"));
    const existing = fileFor(dir, sitePath);
    for (const rule of redirects) {
      if (!pathMatches(rule.from, sitePath)) continue;
      if (existing && !rule.force && rule.status !== 404) break;
      if (rule.status === 200 || rule.status === 404) {
        const target = fileFor(dir, rule.to);
        if (!target) return notFound();
        return send(rule.status, sitePath, target);
      }
      res.writeHead(rule.status, { Location: `${base}${rule.to}` }).end();
      log.push({ method: req.method, path: pathname, status: rule.status });
      return;
    }
    if (!existing) return notFound();
    return send(200, sitePath, existing);
  };
}

/** Listen on a free loopback port; `handle` may be swapped later through the returned setter. */
export function listen(handle = (req, res) => res.writeHead(503).end()) {
  let current = handle;
  const server = createServer((req, res) => current(req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      resolve({
        origin,
        use: (next) => {
          current = next;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Serve `dir` at http://127.0.0.1:<port><base>/. */
export async function serveSite({ dir, base = "" }) {
  const log = [];
  const server = await listen(siteHandler({ dir, base, log }));
  return { origin: server.origin, url: `${server.origin}${base}/`, log, close: server.close };
}
