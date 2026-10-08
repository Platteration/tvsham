#!/usr/bin/env node
// Builds the TVsham website: the app's web export plus the hosting files in public/, made for one
// recognition server.
//
//   TVSHAM_SERVER_URL=https://tvsham.example.com node scripts/build-web.mjs [--out dist]
//   (optional) WEB_BASE_URL=/tvsham  when the site is served under a path rather than at the root
//
// The server's origin is the site's only connect-src: the build writes it into the policy in
// index.html, _headers and .htaccess (deploy/nginx.conf is copied by hand and says where it goes),
// and app.config.js makes the same URL the app's built-in server address. The server, for its
// part, must name this site's origin in CORS_ORIGIN.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { SERVER_ORIGIN_TOKEN, BASE_URL_TOKEN, serverUrlFrom, serverOriginOf, baseUrlFrom } = require("./web-config.js");

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file in a folder, as paths relative to it, dotfiles included. */
export function listFiles(dir) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** The files the build fills in: the policy's connect-src, and the base path in the two pages. */
export const STAMPED = ["index.html", "404.html", "_headers", ".htaccess"];

export function buildWeb({ serverUrl: rawServer, baseUrl: rawBase, out: rawOut, quiet = false } = {}) {
  const serverUrl = serverUrlFrom(rawServer);
  if (!serverUrl) {
    throw new Error(
      "Set TVSHAM_SERVER_URL to the recognition server this site talks to (for example https://tvsham.example.com). " +
        "It becomes the site's only connect-src; without it the site could reach nothing.",
    );
  }
  const baseUrl = baseUrlFrom(rawBase);
  const out = resolve(app, rawOut ?? "dist");
  rmSync(out, { recursive: true, force: true });
  // --clear: Metro's transform cache does not key on the app config, so a bundle built for one
  // server would otherwise carry that server's address into the next build, under a policy that
  // names another (measured: the second of two builds kept the first one's address).
  execFileSync(process.execPath, [require.resolve("expo/bin/cli"), "export", "--platform", "web", "--clear", "--output-dir", out], {
    cwd: app,
    stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1", TVSHAM_SERVER_URL: serverUrl, WEB_BASE_URL: baseUrl },
  });

  const origin = serverOriginOf(serverUrl);
  for (const name of STAMPED) {
    const file = join(out, name);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.split(SERVER_ORIGIN_TOKEN).join(origin).split(BASE_URL_TOKEN).join(baseUrl));
  }
  // The EAS Update manifest: nothing on the site loads it.
  rmSync(join(out, "metadata.json"), { force: true });

  // Nothing unstamped goes out: a token left in a published file is a policy that names no server,
  // or a page whose stylesheet and safety net are at an address that does not exist.
  for (const name of listFiles(out)) {
    if (!/\.(html|js|css|txt)$|^_headers$|^_redirects$|^\.htaccess$/.test(name.split("/").pop())) continue;
    const text = readFileSync(join(out, name), "utf8");
    for (const token of [SERVER_ORIGIN_TOKEN, BASE_URL_TOKEN]) {
      if (text.includes(token)) throw new Error(`${name} still carries ${token} after the build`);
    }
  }
  if (!existsSync(join(out, "guard.js"))) throw new Error("the export did not copy public/ into the site");
  return { out, serverUrl, origin, baseUrl };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--out");
  const { out, origin, baseUrl } = buildWeb({
    serverUrl: process.env.TVSHAM_SERVER_URL,
    baseUrl: process.env.WEB_BASE_URL,
    out: at > 0 ? process.argv[at + 1] : undefined,
  });
  console.log(`\nThe site is in ${relative(process.cwd(), out) || "."}: connect-src ${origin}, served at ${baseUrl || "/"}.`);
  console.log(`Set CORS_ORIGIN on the server to the origin this site is served from.`);
}
