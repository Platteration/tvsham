#!/usr/bin/env node
// Builds the TVsham website: the app's web export plus the hosting files in public/, made for one
// recognition server.
//
//   TVSHAM_SERVER_URL=https://tvsham.example.com node scripts/build-web.mjs [--out dist]
//   (optional) WEB_BASE_URL=/tvsham  when the site is served under a path rather than at the root
//
// The server's origin is the site's only connect-src: the build writes it into the policy in
// _headers and .htaccess (deploy/nginx.conf is copied by hand and says where it goes), and then
// into the built index.html as a <meta>, from _headers; app.config.js makes the same URL the app's
// built-in server address. The server, for its part, must name this site's origin in CORS_ORIGIN.
// public/index.html carries neither the policy nor the base path because `expo start --web` serves
// it as it is (see the comment at its top).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { SERVER_ORIGIN_TOKEN, BASE_URL_TOKEN, siteServerUrlFrom, serverOriginOf, baseUrlFrom } = require("./web-config.js");

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

/** The files the build fills in: the policy's connect-src, and the base path in 404.html and .htaccess. */
export const STAMPED = ["404.html", "_headers", ".htaccess"];

/** The Content-Security-Policy a _headers file gives every path (its `/*` rule), or null. */
export function headerPolicy(headersText) {
  let everyPath = false;
  for (const line of headersText.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      everyPath = line.trim() === "/*";
      continue;
    }
    const header = /^\s+Content-Security-Policy:\s*(\S.*)$/.exec(line);
    if (everyPath && header) return header[1].trim();
  }
  return null;
}

/** A policy as a <meta> can carry it: a browser ignores frame-ancestors there. */
export function metaPolicy(policy) {
  return policy
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors\b/.test(d))
    .join("; ");
}

const CHARSET = '<meta charset="utf-8">';

/** The template's own two files, named from the root: the build moves them under the base path. */
export const PAGE_FILES = ['href="/site.css"', 'src="/guard.js"'];

/**
 * The exported index.html finished for its host: the policy as its first <meta> after the charset,
 * ahead of every script, and the stylesheet and the safety net under `baseUrl`. Throws when the
 * page is not the one public/index.html describes, which is a later SDK that stopped reading the
 * template: a page with no safety net, which the policy would then be written into regardless.
 */
export function finishPage(html, { policy, baseUrl }) {
  if (html.split(CHARSET).length !== 2) throw new Error(`index.html has no single ${CHARSET} to put the policy after`);
  if (policy.includes('"')) throw new Error("a policy with a double quote cannot go in an attribute as it is");
  let out = html.replace(CHARSET, `${CHARSET}\n<meta http-equiv="Content-Security-Policy" content="${metaPolicy(policy)}">`);
  for (const attribute of PAGE_FILES) {
    if (out.split(attribute).length !== 2) {
      throw new Error(`index.html does not name ${attribute} once: is it still the page public/index.html describes?`);
    }
    out = out.replace(attribute, attribute.replace('="/', `="${baseUrl}/`));
  }
  return out;
}

export function buildWeb({ serverUrl: rawServer, baseUrl: rawBase, out: rawOut, quiet = false } = {}) {
  const serverUrl = siteServerUrlFrom(rawServer);
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
  const policy = headerPolicy(readFileSync(join(out, "_headers"), "utf8"));
  if (!policy) throw new Error("_headers gives no Content-Security-Policy to every path (/*)");
  writeFileSync(join(out, "index.html"), finishPage(readFileSync(join(out, "index.html"), "utf8"), { policy, baseUrl }));
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
