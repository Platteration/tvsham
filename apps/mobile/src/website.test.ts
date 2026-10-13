import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

/**
 * The website's hosting layer, read out of the files that carry it. The policy and the other
 * headers are written in three places - _headers (Netlify, Cloudflare Pages), .htaccess (Apache)
 * and deploy/nginx.conf (nginx) - and in the README, and scripts/build-web.mjs copies the policy
 * from _headers into the built index.html as a <meta> tag; nothing but this test makes them say
 * the same thing: a header changed in one and not the others is a site
 * that is safe on one host and not on the next. e2e/web.mjs is the other half: it loads the built
 * site under the _headers policy and fails on any violation, so a value here that blocks something
 * real fails there.
 */

// .pathname rather than fileURLToPath: the DOM lib's URL type and Node's
// disagree under this tsconfig, and the path has nothing to decode.
const root = new URL("..", import.meta.url).pathname;
const read = (file: string) => readFileSync(join(root, file), "utf8");
const require = createRequire(import.meta.url);

interface WebConfig {
  SERVER_ORIGIN_TOKEN: string;
  BASE_URL_TOKEN: string;
  serverUrlFrom(raw: unknown): string;
  siteServerUrlFrom(raw: unknown): string;
  serverOriginOf(url: string): string;
  baseUrlFrom(raw: unknown): string;
}
const web = require("../scripts/web-config.js") as WebConfig;
type ExpoConfig = { extra?: Record<string, unknown>; experiments?: Record<string, unknown>; name?: string };
const appConfig = require("../app.config.js") as (ctx: { config: ExpoConfig }) => ExpoConfig;

interface BuildWeb {
  STAMPED: string[];
  PAGE_FILES: string[];
  headerPolicy(headersText: string): string | null;
  finishPage(html: string, opts: { policy: string; baseUrl: string }): string;
}
/** scripts/build-web.mjs, by a specifier TypeScript does not resolve: it is plain JavaScript. */
const buildScript = () => import("../scripts/build-web" + ".mjs") as Promise<BuildWeb>;

/** The header lines of _headers' rule for `path`, as [name, value] pairs. */
function headersRule(path: string): Array<[string, string]> {
  const lines = read("public/_headers").split("\n");
  const start = lines.findIndex((l) => l === path);
  assert.ok(start >= 0, `_headers has a rule for ${path}`);
  const out: Array<[string, string]> = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    const colon = line.indexOf(":");
    out.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
  }
  return out;
}

/** Every path _headers gives a rule, in order. */
function headersPaths(): string[] {
  return read("public/_headers")
    .split("\n")
    .filter((l) => l.startsWith("/"));
}

/** Header name -> value, as each of the four places writes them. */
function everyPlace(): Record<string, Map<string, string>> {
  const htaccess = new Map<string, string>();
  for (const m of read("public/.htaccess").matchAll(/^ {2}Header always set (\S+) "([^"]*)"$/gm)) {
    // The cache lifetime is set twice in .htaccess, once for everything and once for the
    // hashed paths, and is checked on its own below.
    if (m[1] !== "Cache-Control") htaccess.set(m[1]!, m[2]!);
  }
  const nginx = new Map<string, string>();
  for (const m of read("deploy/nginx.conf").matchAll(/^ {4}add_header (\S+) "([^"]*)" always;$/gm)) nginx.set(m[1]!, m[2]!);
  return { _headers: new Map(headersRule("/*")), ".htaccess": htaccess, "deploy/nginx.conf": nginx };
}

const policy = () => new Map(headersRule("/*")).get("Content-Security-Policy") ?? "";

/** A policy as directive -> sources. */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name, sources);
  }
  return out;
}

/** Every file in a folder, relative to it, dotfiles included. */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

/** The app's routes, from expo-router's own folder: every screen file but the layout. */
function routes(): string[] {
  return readdirSync(join(root, "app"))
    .filter((f) => f.endsWith(".tsx") && !f.startsWith("_"))
    .map((f) => f.replace(/\.tsx$/, ""))
    .filter((f) => f !== "index")
    .sort();
}

describe("the website's headers", () => {
  it("are the same in _headers, .htaccess and nginx.conf", () => {
    const places = everyPlace();
    const reference = places._headers!;
    assert.deepEqual(
      [...reference.keys()],
      [
        "Content-Security-Policy",
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Referrer-Policy",
        "Permissions-Policy",
        "Cross-Origin-Opener-Policy",
        "Cross-Origin-Resource-Policy",
        "Strict-Transport-Security",
      ],
    );
    for (const [where, headers] of Object.entries(places)) {
      assert.deepEqual(Object.fromEntries(headers), Object.fromEntries(reference), `${where} sends what _headers sends`);
    }
  });

  it("carry the same policy in the built index.html, less the one directive a meta tag cannot hold", async () => {
    // The build writes the policy into the page from _headers, ahead of every script and
    // stylesheet; the template itself carries none (see the next test).
    const { headerPolicy, finishPage } = await buildScript();
    assert.equal(headerPolicy(read("public/_headers")), policy());
    const page = finishPage(read("public/index.html"), { policy: policy(), baseUrl: "/tvsham" });
    const metas = [...page.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g)].map((m) => m[1]);
    assert.deepEqual(metas, [policy().replace(" frame-ancestors 'none';", "")]);
    const at = page.indexOf('<meta http-equiv="Content-Security-Policy"');
    assert.ok(at > page.indexOf('<meta charset="utf-8">'), "after the charset, which must come first");
    for (const tag of ["<script", "<link"]) assert.ok(at < page.indexOf(tag), `before the first ${tag}`);
    const referrer = /<meta name="referrer" content="([^"]*)">/.exec(read("public/index.html"))?.[1];
    assert.equal(referrer, new Map(headersRule("/*")).get("Referrer-Policy"));
  });

  it("leave the page template as the development server can serve it", async () => {
    // `expo start --web` serves public/index.html as it is, filling in only Expo's own two
    // tokens. A policy there refused the development server's reload socket, its error overlay
    // and its own address, and a %BASE_URL% left the stylesheet and the safety net unloadable:
    // the page never started. The build adds both (finishPage); the template has neither.
    const html = read("public/index.html");
    assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/i);
    assert.ok(!html.includes(web.BASE_URL_TOKEN) && !html.includes(web.SERVER_ORIGIN_TOKEN), "no build token");
    const { PAGE_FILES, finishPage } = await buildScript();
    assert.deepEqual(PAGE_FILES, ['href="/site.css"', 'src="/guard.js"']);
    for (const attribute of PAGE_FILES) assert.equal(html.split(attribute).length, 2, `the template names ${attribute} once, from the root`);
    // And the build moves both under the base path, and refuses a page that is not this template.
    const page = finishPage(html, { policy: policy(), baseUrl: "/tvsham" });
    assert.ok(page.includes('href="/tvsham/site.css"') && page.includes('src="/tvsham/guard.js"'));
    assert.ok(finishPage(html, { policy: policy(), baseUrl: "" }).includes('src="/guard.js"'), "at the root, where they are");
    assert.throws(() => finishPage(html.replace('src="/guard.js"', 'src="/other.js"'), { policy: policy(), baseUrl: "" }), /guard\.js/);
    assert.throws(() => finishPage(html.replace('<meta charset="utf-8">', ""), { policy: policy(), baseUrl: "" }), /charset/);
  });

  it("are the ones the README quotes", () => {
    const readme = readFileSync(join(root, "../../README.md"), "utf8");
    for (const [name, value] of headersRule("/*")) {
      assert.ok(readme.includes(value), `README.md quotes ${name}: ${value}`);
    }
  });

  it("allow only what the site loads, and nothing that runs a string", () => {
    const csp = directives(policy());
    assert.deepEqual([...csp.keys()], [
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "media-src",
      "connect-src",
      "base-uri",
      "form-action",
      "object-src",
      "frame-ancestors",
      "upgrade-insecure-requests",
      "require-trusted-types-for",
      "trusted-types",
    ]);
    assert.deepEqual(csp.get("default-src"), ["'none'"]);
    assert.deepEqual(csp.get("script-src"), ["'self'"]);
    assert.deepEqual(csp.get("connect-src"), [web.SERVER_ORIGIN_TOKEN], "connect-src is the server the build names, alone");
    for (const name of ["base-uri", "form-action", "object-src", "frame-ancestors"]) assert.deepEqual(csp.get(name), ["'none'"], name);
    assert.deepEqual(csp.get("require-trusted-types-for"), ["'script'"]);
    assert.deepEqual(csp.get("trusted-types"), ["'none'"]);
    for (const [name, sources] of csp) {
      for (const source of sources) {
        assert.ok(!["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'", "*", "https:", "http:", "data:"].includes(source), `${name} ${source}`);
        if (/^https?:\/\//.test(source)) assert.doesNotMatch(source, /\*/, `${name} names hosts, never a wildcard`);
      }
    }
  });

  it("admit react-native-web's empty <style> element and no inline style with anything in it", () => {
    // react-native-web inserts an empty <style> and fills it through insertRule, which CSP
    // does not govern; the empty element is admitted by the hash of the empty string. Any
    // other hash here would admit some particular stylesheet, which is not what it is for.
    const empty = `'sha256-${createHash("sha256").update("").digest("base64")}'`;
    assert.deepEqual(directives(policy()).get("style-src"), ["'self'", empty]);
  });

  it("let the pictures in from the hosts the server's results point to, and no other", () => {
    // resolve.ts takes Wikipedia's thumbnail and YouTube's oEmbed thumbnail; tmdb.ts builds
    // every poster, logo and cast photo on image.tmdb.org. A host added there needs adding here.
    assert.deepEqual(directives(policy()).get("img-src"), ["'self'", "https://upload.wikimedia.org", "https://i.ytimg.com", "https://image.tmdb.org"]);
    const tmdb = readFileSync(join(root, "../server/src/tmdb.ts"), "utf8");
    assert.match(tmdb, /const IMAGE_BASE = "https:\/\/image\.tmdb\.org\/t\/p";/);
  });

  it("turn off every browser feature, none of which the site uses", () => {
    const features = (new Map(headersRule("/*")).get("Permissions-Policy") ?? "").split(", ");
    assert.ok(features.length >= 20);
    for (const f of features) assert.match(f, /^[a-z-]+=\(\)$/, f);
    for (const f of ["camera", "microphone", "geolocation", "display-capture", "screen-wake-lock"]) {
      assert.ok(features.includes(`${f}=()`), `${f} is off`);
    }
  });

  it("give every file and route exactly one cache lifetime", () => {
    // Both hosts join a header that two matching rules set, so each path has one rule.
    const paths = headersPaths();
    assert.equal(new Set(paths).size, paths.length, "no path twice");
    const lifetimes = paths.filter((p) => p !== "/*");
    for (const p of lifetimes) {
      const rule = headersRule(p);
      assert.deepEqual(rule.map(([n]) => n), ["Cache-Control"], `${p} sets Cache-Control and nothing else`);
      const hashed = p === "/_expo/static/*" || p === "/assets/*";
      assert.equal(rule[0]![1], hashed ? "public, max-age=31536000, immutable" : "no-cache", p);
    }
    // Every file public/ adds to the site, the favicon and the page itself, and every route.
    const site = filesIn(join(root, "public"))
      .filter((f) => !["_headers", "_redirects", ".htaccess"].includes(f))
      .map((f) => `/${f}`);
    const expected = ["/", ...site, "/favicon.ico", ...routes().map((r) => `/${r}`)].sort();
    assert.deepEqual(lifetimes.filter((p) => !p.endsWith("*")).sort(), expected);
    // The other two places say the same: no-cache, except the hashed folders.
    assert.match(read("public/.htaccess"), /^ {2}Header always set Cache-Control "no-cache"\n {2}<If "%\{REQUEST_URI\} =~ m#\/\(_expo\/static\|assets\)\/#">\n {4}Header always set Cache-Control "public, max-age=31536000, immutable"\n {2}<\/If>$/m);
    assert.match(read("deploy/nginx.conf"), /default +"no-cache";\n +~\^\/_expo\/static\/ +"public, max-age=31536000, immutable";\n +~\^\/assets\/ +"public, max-age=31536000, immutable";/);
    // A name under those folders that the site does not hold is answered with 404.html, and it is
    // the not-found page's address the lifetime is chosen by: nginx maps $uri, which error_page
    // sets to /404.html ($request_uri keeps the address asked for), and Apache's ErrorDocument
    // answers through /404.html, whose REQUEST_URI the <If> then reads. Measured on nginx 1.24 and
    // Apache 2.4.58: with $request_uri, or without the ErrorDocument, such a 404 went out marked
    // immutable, and a browser that asked before the file arrived kept it across reloads.
    assert.match(read("deploy/nginx.conf"), /^map \$uri \$tvsham_cache_control \{$/m);
    assert.match(read("deploy/nginx.conf"), /^ {4}error_page 404 \/404\.html;$/m);
    assert.match(read("public/.htaccess"), /^ErrorDocument 404 %BASE_URL%\/404\.html$/m);
  });
});

describe("the website's files", () => {
  it("serve each of the app's routes as the one page, on every host", () => {
    const list = routes();
    assert.deepEqual(list, ["library", "result", "settings"]);
    const rewrites = read("public/_redirects")
      .split("\n")
      .filter((l) => / 200$/.test(l.trim()))
      .map((l) => l.trim().split(/\s+/));
    assert.deepEqual(rewrites.map(([from, to]) => [from, to]).sort(), list.map((r) => [`/${r}`, "/index.html"]));
    const alternation = `(${["settings", "library", "result"].join("|")})`;
    assert.ok(read("public/.htaccess").includes(`RewriteRule ^${alternation}$ index.html [L]`));
    assert.ok(read("deploy/nginx.conf").includes(`location ~ ^/${alternation}$ { try_files /index.html =404; }`));
    assert.deepEqual(alternation.slice(1, -1).split("|").sort(), list);
  });

  it("refuse dotfiles and the hosting files, on every host", () => {
    // The refusal each host config writes, run against the paths it must and must not refuse.
    // Apache: the unconditional 404 rules (the folder rule below its RewriteCond is not one).
    const htaccess = read("public/.htaccess").split("\n");
    const apacheRules = htaccess.flatMap((line, i) => {
      const rule = /^ {2}RewriteRule (\S+) - \[R=404,L\]$/.exec(line)?.[1];
      return rule && !/^\s*RewriteCond /.test(htaccess[i - 1] ?? "") ? [new RegExp(rule)] : [];
    });
    assert.equal(apacheRules.length, 2, "the dotfile rule and the hosting-file rule");
    const nginxRules = [...read("deploy/nginx.conf").matchAll(/^ {4}location ~ (\S+) \{ return 404; \}$/gm)].map((m) => new RegExp(m[1]!));
    // Netlify applies a rule without "!" only where no file exists, and these files exist: a
    // refusal of one is forced (`404!`), or it refuses nothing there.
    const redirects = read("public/_redirects")
      .split("\n")
      .filter((l) => / 404!$/.test(l.trim()))
      .map((l) => l.trim().split(/\s+/)[0]);
    assert.deepEqual(read("public/_redirects").split("\n").filter((l) => / 404$/.test(l.trim())), [], "no 404 rule that a file shadows");
    const refused = [".htaccess", ".git/config", ".env", "_headers", "_redirects", "assets/.hidden"];
    for (const path of refused) {
      assert.ok(apacheRules.some((r) => r.test(path)), `.htaccess refuses ${path}`);
      assert.ok(nginxRules.some((r) => r.test(`/${path}`)), `nginx.conf refuses /${path}`);
    }
    for (const path of ["_headers", "_redirects", ".htaccess"]) assert.ok(redirects.includes(`/${path}`), `_redirects refuses /${path}`);
    for (const path of ["index.html", ".well-known/security.txt", "_expo/static/js/web/entry-0.js", "settings"]) {
      assert.ok(!apacheRules.some((r) => r.test(path)), `.htaccess serves ${path}`);
      assert.ok(!nginxRules.some((r) => r.test(`/${path}`)), `nginx.conf serves /${path}`);
    }
    // nginx and Apache show 404.html with a 404 for a missing address, for a folder with no page
    // and for what they refuse, and redirect plain http to https, as the README says each does.
    const nginx = read("deploy/nginx.conf");
    for (const line of [
      "    error_page 404 /404.html;",
      "    error_page 403 =404 /404.html;",
      "    location = /404.html { internal; }",
      "    autoindex off;",
      "    server_tokens off;",
    ]) {
      assert.ok(nginx.split("\n").includes(line), `nginx.conf: ${line.trim()}`);
    }
    assert.match(nginx, /listen 80;[\s\S]*return 301 https:\/\/\$host\$request_uri;/);
    const apache = read("public/.htaccess");
    for (const line of ["Options -Indexes", "ErrorDocument 404 %BASE_URL%/404.html", "ErrorDocument 403 %BASE_URL%/404.html"]) {
      assert.ok(apache.split("\n").includes(line), `.htaccess: ${line}`);
    }
    // Over https, unless a proxy in front says the visitor already used it.
    assert.match(
      apache,
      /^ {2}RewriteEngine On\n(?: {2}#.*\n)* {2}RewriteCond %\{HTTPS\} !=on\n {2}RewriteCond %\{HTTP:X-Forwarded-Proto\} !=https\n {2}RewriteRule \^ https:\/\/%\{HTTP_HOST\}%\{REQUEST_URI\} \[R=301,L\]$/m,
    );
    // A folder with no page of its own is a 404, not a listing.
    assert.match(apache, /^ {2}RewriteCond %\{REQUEST_FILENAME\} -d\n {2}RewriteRule \^\.\+\$ - \[R=404,L\]$/m);
  });

  it("publish the site and nothing of the repository's", () => {
    // public/ is copied into the site whole, so it holds what the site serves, the hosting
    // files and nothing else: no notes, no deploy configuration, no source.
    assert.deepEqual(filesIn(join(root, "public")), [
      ".htaccess",
      ".well-known/security.txt",
      "404.html",
      "_headers",
      "_redirects",
      "guard.js",
      "index.html",
      "robots.txt",
      "site.css",
    ]);
  });

  it("load the safety net first, and nothing inline", () => {
    const html = read("public/index.html");
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, [' src="/guard.js"'], "one script, a file, not deferred: it must run before the bundle");
    assert.ok(html.indexOf("guard.js") < html.indexOf('<div id="root">'));
    assert.doesNotMatch(html, /<style\b|\sstyle="|\son[a-z]+="/i, "no inline style and no inline handler");
    assert.match(html, /<noscript>[\s\S]*TVsham needs JavaScript\.[\s\S]*<\/noscript>/);
    const notFound = read("public/404.html");
    assert.doesNotMatch(notFound, /<script\b|<style\b|\sstyle="/i, "404.html needs no script and nothing inline");
    assert.match(notFound, /href="%BASE_URL%\/"/);
  });

  it("carry a security contact that has not expired", () => {
    const txt = read("public/.well-known/security.txt");
    // Both addresses answer today. Private vulnerability reporting is switched off on the
    // repository, so its "new advisory" page is a dead end; the issues page is where SECURITY.md
    // says to ask for a private channel. The policy is read on main, which carries SECURITY.md:
    // the default branch does not yet, so blob/HEAD answered 404.
    assert.match(txt, /^Contact: https:\/\/github\.com\/Platteration\/tvsham\/issues$/m);
    assert.match(txt, /^Policy: https:\/\/github\.com\/Platteration\/tvsham\/blob\/main\/SECURITY\.md$/m);
    assert.match(read("../../SECURITY.md"), /open an issue that says you have a\s+report, with no details in it/);
    assert.match(txt, /^Preferred-Languages: en$/m);
    const expires = /^Expires: (\S+)$/m.exec(txt)?.[1];
    assert.ok(expires && Date.parse(expires) > Date.now(), "security.txt's Expires is in the future: renew it, a year at most ahead (RFC 9116)");
    assert.ok(Date.parse(expires) - Date.now() < 366 * 24 * 3600 * 1000, "and no more than a year ahead");
  });

  it("are all filled in by the build, and only those", async () => {
    const { STAMPED } = await buildScript();
    const carrying = filesIn(join(root, "public")).filter((f) => {
      const text = read(`public/${f}`);
      return text.includes(web.SERVER_ORIGIN_TOKEN) || text.includes(web.BASE_URL_TOKEN);
    });
    // index.html carries only Expo's own %LANG_ISO_CODE% and %WEB_TITLE%, which the export fills
    // (and the development server too); the build finishes it with finishPage instead.
    assert.deepEqual(carrying.sort(), [...STAMPED].sort());
    assert.ok(!STAMPED.includes("index.html"));
  });
});

describe("the website's build configuration", () => {
  it("leaves app.json as it is unless a website build asks", () => {
    const config: ExpoConfig = { name: "TVsham", extra: { serverUrl: "" } };
    const saved = { server: process.env.TVSHAM_SERVER_URL, base: process.env.WEB_BASE_URL };
    try {
      delete process.env.TVSHAM_SERVER_URL;
      delete process.env.WEB_BASE_URL;
      assert.equal(appConfig({ config }), config);
      process.env.TVSHAM_SERVER_URL = "https://tvsham.example.com/";
      process.env.WEB_BASE_URL = "/tvsham";
      assert.deepEqual(appConfig({ config }), {
        name: "TVsham",
        extra: { serverUrl: "https://tvsham.example.com" },
        experiments: { baseUrl: "/tvsham" },
      });
      process.env.TVSHAM_SERVER_URL = "javascript:alert(1)";
      assert.throws(() => appConfig({ config }), /http\(s\)/);
    } finally {
      if (saved.server === undefined) delete process.env.TVSHAM_SERVER_URL;
      else process.env.TVSHAM_SERVER_URL = saved.server;
      if (saved.base === undefined) delete process.env.WEB_BASE_URL;
      else process.env.WEB_BASE_URL = saved.base;
    }
  });

  it("takes a server address that can be a policy source, and nothing else", () => {
    assert.equal(web.serverUrlFrom(undefined), "");
    assert.equal(web.serverUrlFrom("https://tvsham.example.com/"), "https://tvsham.example.com");
    assert.equal(web.serverUrlFrom("https://example.com/tvsham-api"), "https://example.com/tvsham-api");
    assert.equal(web.serverOriginOf("https://example.com:8443/api"), "https://example.com:8443");
    for (const bad of ["tvsham.example.com", "ftp://example.com", "https://user:pw@example.com", "https://example.com/?a=1", "https://example.com/#x", "data:,x"]) {
      assert.throws(() => web.serverUrlFrom(bad), Error, bad);
    }
  });

  it("builds a website only for a server its browser can reach", () => {
    // The policy carries upgrade-insecure-requests, so an http page's own requests go out as https,
    // and an https page may not call an http server at all. Chromium exempts loopback from both
    // (measured: 127.0.0.1, 127.0.0.2, localhost, [::1] and foo.localhost were left on http, and
    // 192.0.2.1 was upgraded), so a plain-http server works there and nowhere else: built for a LAN
    // address, the page asked for its stylesheet, safety net and bundle over https and never started.
    for (const ok of ["https://tvsham.example.com", "https://192.168.1.20:8787", "http://127.0.0.1:8787", "http://127.0.0.2:8787", "http://localhost:8787", "http://[::1]:8787", "http://tvsham.localhost:8787"]) {
      assert.equal(web.siteServerUrlFrom(ok), ok, ok);
    }
    for (const bad of ["http://192.168.1.20:8787", "http://tvsham.example.com", "http://10.0.0.2", "http://127.0.0.1.nip.io:8787", "http://localhost.example.com"]) {
      assert.throws(() => web.siteServerUrlFrom(bad), /must be https:\/\/ for a server on another machine/, bad);
    }
    assert.equal(web.siteServerUrlFrom(undefined), "");
    assert.throws(() => web.siteServerUrlFrom("ftp://example.com"), /http\(s\)/, "and everything serverUrlFrom refuses");
  });

  it("takes a base path that is a path, and nothing else", () => {
    assert.equal(web.baseUrlFrom(undefined), "");
    assert.equal(web.baseUrlFrom("/"), "");
    assert.equal(web.baseUrlFrom("/tvsham"), "/tvsham");
    assert.equal(web.baseUrlFrom("/a/b-c"), "/a/b-c");
    for (const bad of ["tvsham", "/tvsham/", "/../x", "/a/./b", "//evil.example", "/a b", '/a"b']) {
      assert.throws(() => web.baseUrlFrom(bad), Error, bad);
    }
  });
});
