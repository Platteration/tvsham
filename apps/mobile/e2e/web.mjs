// The TVsham website, end to end, in Chromium. Run with `npm run test:e2e` (node --import tsx, so
// the recognition server's TypeScript loads as it is).
//
// It builds the site with scripts/build-web.mjs for a real recognition server started here (the
// app's Hono server with Claude and the outside world stood in for: no test reaches either), serves
// the build at a sub-path through e2e/serve.mjs, which sends the headers exactly as the published
// _headers writes them, and drives the main flow: open the site, test the connection with the
// access token, choose a video, read the answer with its pictures, save it, find it in the library
// after a reload. It fails on any Content-Security-Policy violation, any console error, any page
// error, and any request that leaves the site other than to the server it was built for and the
// three picture hosts the policy names, which are answered here. Then the website's account and
// shop, on the site's own origin as deploy/nginx.conf puts them (the host here proxies api/ to the
// server, which carries the shared kit, with a fake Google and a fake Stripe handed to it): sign in
// with Google, buy an accent, Stripe's signed webhook unlocks it, sign out, delete the account; and
// on a host where nothing answers api/, none of it is drawn. Then it checks what a chosen video
// comes to with the server out of reach, the not-found page, the hosting files' refusals, the
// safety net and the page without JavaScript.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildWeb } from "../scripts/build-web.mjs";
import { listen, parseHeaders, siteHandler } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = resolve(here, "..");
const serverSrc = resolve(mobile, "../server/src");
const BASE = "/tvsham";
const TOKEN = randomBytes(24).toString("hex");
/** The hosts img-src names. Each is answered here with this picture, and each must be asked for. */
const PICTURE_HOSTS = ["upload.wikimedia.org", "i.ytimg.com", "image.tmdb.org"];
// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const problems = [];
/** Console warnings, printed at the end: worth reading, not a failure. */
const warnings = new Set();
const problem = (what) => {
  problems.push(what);
  console.error(`  ✗ ${what}`);
};
const step = (what) => console.log(`- ${what}`);

const work = mkdtempSync(join(tmpdir(), "tvsham-web-e2e-"));
const out = join(work, "site");

// ---------------------------------------------------------------- the two servers

// The site's port first: the recognition server reads CORS_ORIGIN when it loads.
const site = await listen();
process.env.CORS_ORIGIN = site.origin;
process.env.APP_TOKEN = TOKEN;
process.env.TMDB_API_KEY = "e2e-placeholder";
process.env.TMP_DIR = join(work, "uploads");
process.env.STT_PROVIDER = "none";

const { app, API_HEADERS, setAccountForTests } = await import(pathToFileURL(join(serverSrc, "index.ts")).href);
const { createAccount } = await import(pathToFileURL(join(serverSrc, "account.ts")).href);
const { createFakes, envFor, signedDelivery } = await import(pathToFileURL(join(serverSrc, "testing/kit-fakes.ts")).href);
const { setClientForTests } = await import(pathToFileURL(join(serverSrc, "recognize.ts")).href);
const { setFetchForTests } = await import(pathToFileURL(join(serverSrc, "http.ts")).href);
const { ffmpegBinary } = await import(pathToFileURL(join(serverSrc, "media.ts")).href);
const { serve } = await import("@hono/node-server");

// Claude, answering every clip with one confident film.
setClientForTests({
  beta: { messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "TITLE: Big Buck Bunny" }] }) } },
  messages: {
    parse: async () => ({
      parsed_output: {
        kind: "movie",
        title: "Big Buck Bunny",
        year: 2008,
        season: null,
        episodeNumber: null,
        episodeTitle: null,
        creator: "Blender Foundation",
        creatorHandle: null,
        platform: null,
        wikipediaTitle: "Big Buck Bunny",
        wikipediaEpisodeTitle: null,
        youtubeUrl: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        videoUrl: null,
        confidence: 0.95,
        evidence: "The title card reads Big Buck Bunny.",
        alternatives: [],
      },
    }),
  },
});

// Wikipedia, YouTube and TMDB, answering with a picture on each host the policy allows.
const outside = [];
setFetchForTests(async (input) => {
  const url = new URL(String(input));
  outside.push(url.host);
  const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  if (url.host === "en.wikipedia.org" && url.pathname.startsWith("/api/rest_v1/page/summary/Big_Buck_Bunny")) {
    return json({
      title: "Big Buck Bunny",
      extract: "Big Buck Bunny is a 2008 short computer-animated comedy film.",
      thumbnail: { source: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Big_buck_bunny_poster_big.jpg/320px-Big_buck_bunny_poster_big.jpg" },
      content_urls: { mobile: { page: "https://en.m.wikipedia.org/wiki/Big_Buck_Bunny" } },
      type: "standard",
    });
  }
  if (url.host === "www.youtube.com" && url.pathname === "/oembed") {
    return json({ title: "Big Buck Bunny 60fps 4K", author_name: "Blender", thumbnail_url: "https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg" });
  }
  if (url.host === "api.themoviedb.org") {
    if (url.pathname === "/3/search/movie") return json({ results: [{ id: 10378, title: "Big Buck Bunny" }] });
    if (url.pathname === "/3/movie/10378/watch/providers") {
      return json({ results: { US: { link: "https://www.themoviedb.org/movie/10378/watch?locale=US", flatrate: [{ provider_name: "Example Stream", logo_path: "/stream.jpg" }] } } });
    }
    if (url.pathname === "/3/movie/10378/credits") return json({ cast: [{ id: 1, name: "Big Buck", character: "Himself", profile_path: "/buck.jpg" }] });
  }
  return new Response("not found", { status: 404 });
});

const apiServer = await new Promise((done) => {
  const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => done({ s, port: info.port }));
});
const api = { origin: `http://127.0.0.1:${apiServer.port}` };

// The website's account and shop: the kit in that server, for a site at ${site.origin}${BASE}/,
// with a fake Google and a fake Stripe as the only way out (createApp's fetch), and its records in
// a directory of files as a deployment keeps them. Every line it logs is kept and checked at the end.
const fakes = await createFakes();
const APP_URL = `${site.origin}${BASE}/`;
const accountLog = [];
const account = createAccount({
  env: { ...envFor(APP_URL), KIT_DATA_DIR: join(work, "account") },
  fetch: fakes.fetch,
  log: (level, message) => void accountLog.push(`${level}: ${message}`),
});
assert.deepEqual(account.features, { signIn: true, shop: true });
setAccountForTests(account);

// ---------------------------------------------------------------- the build

step(`building the site for ${api.origin}, served at ${site.origin}${BASE}/`);
buildWeb({ serverUrl: api.origin, baseUrl: BASE, out, quiet: true });
const log = [];
const shipped = parseHeaders(readFileSync(join(out, "_headers"), "utf8"));
const policy = shipped.find((r) => r.path === "/*").headers.find(([n]) => n === "Content-Security-Policy")[1];
const HSTS = shipped.find((r) => r.path === "/*").headers.find(([n]) => n === "Strict-Transport-Security")[1];
/** The site as deploy/nginx.conf serves it, api/ proxied to the server; or as a static host does, with nothing at api/. */
let apiOn = true;
const serveSite = (withApi) => {
  apiOn = withApi;
  site.use(siteHandler({ dir: out, base: BASE, log, api: withApi ? { origin: api.origin, headers: [["Strict-Transport-Security", HSTS]] } : null }));
};
serveSite(true);
assert.ok(policy.includes(`connect-src 'self' ${api.origin};`), "the build wrote the site itself and the server's origin into the policy");
const metaPolicy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(readFileSync(join(out, "index.html"), "utf8"))?.[1];
assert.equal(metaPolicy, policy.replace(" frame-ancestors 'none';", ""), "index.html carries the same policy, less what a meta tag cannot");

// A three-second clip with a picture and a sound, which the server really decodes.
const ffmpeg = await ffmpegBinary();
assert.ok(ffmpeg, "ffmpeg (ffmpeg-static) is installed");
const clip = join(work, "big-buck-bunny.mp4");
execFileSync(ffmpeg, [
  "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", clip,
]);

// ---------------------------------------------------------------- the browser

const { chromium } = await import("playwright");
const browser = await chromium.launch();

/**
 * The console errors a page may log, in the steps that ask for a missing address on purpose:
 * Chromium reports a 404 as "Failed to load resource", and refuses to run 404.html as a script
 * (nosniff) with a line of its own.
 */
let expect404 = false;
/** The console error Chromium logs for a request to a server that is not there, in the step that stages one. */
let expectUnreachable = false;
/** On a host with nothing at api/, the page's one question is a 404, which Chromium logs: counted, by its address. */
let noApi404s = 0;
/** The one violation a step provokes on purpose: a request to another origin, which connect-src refuses. */
let expectRefusedConnect = null;
const refusedConnects = [];

/** Fail on every violation, console error and page error a page reports. */
async function watched(contextOptions = {}) {
  const context = await browser.newContext({ locale: "en-US", ...contextOptions });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(`securitypolicyviolation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"} at ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  const pictures = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === site.origin && (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`))) return route.continue();
    if (url.origin === api.origin) return route.continue();
    if (url.protocol === "https:" && PICTURE_HOSTS.includes(url.host)) {
      pictures.push(url.host);
      return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    }
    problem(`a request outside the site: ${route.request().method()} ${url.href}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    const text = m.text();
    // Chromium reports the one refusal several ways (the event, once per policy - the header's
    // and the <meta>'s - and two console lines), some of them after the fetch has settled.
    if (
      expectRefusedConnect &&
      (text.startsWith(`securitypolicyviolation: connect-src blocked ${expectRefusedConnect}`) ||
        (text.startsWith(`Refused to connect to '${expectRefusedConnect}'`) && text.includes('Content Security Policy directive: "connect-src')) ||
        (text.startsWith(`Fetch API cannot load ${expectRefusedConnect}.`) && text.includes("Content Security Policy")))
    ) {
      refusedConnects.push(text.split(" ")[0]);
      return;
    }
    if (!apiOn && m.type() === "error" && /status of 404/.test(text) && m.location().url === `${APP_URL}api/config`) {
      noApi404s++;
      return;
    }
    if (text.startsWith("securitypolicyviolation")) problem(text);
    else if (m.type() === "warning") warnings.add(text.split("\n")[0].slice(0, 200));
    else if (
      m.type() === "error" &&
      !(expect404 && /status of 404|MIME type \('text\/html'\) is not executable/.test(text)) &&
      !(expectUnreachable && /^Failed to load resource: net::ERR_CONNECTION_REFUSED$/.test(text))
    ) {
      problem(`console error: ${text}`);
    }
  });
  page.on("pageerror", (e) => problem(`page error: ${e.message}`));
  page.on("response", (res) => checkHeaders(res));
  return { context, page, pictures };
}

const HASHED = /^\/(_expo\/static|assets)\//;
let siteResponses = 0;
let apiResponses = 0;
let accountResponses = 0;
/** Every response from the site carries the shipped headers; every one from the server, the API's. */
function checkHeaders(res) {
  const url = new URL(res.url());
  const h = res.headers();
  if (apiOn && url.origin === site.origin && url.pathname.startsWith(`${BASE}/api/`)) {
    // The account's answers, through the proxy: the server's API headers, and the one header the
    // proxy's location adds, never the site's policy or cache rule.
    accountResponses++;
    for (const [name, value] of Object.entries(API_HEADERS)) {
      if (h[name.toLowerCase()] !== value) problem(`${url.pathname}: ${name} is ${JSON.stringify(h[name.toLowerCase()])}`);
    }
    if (h["strict-transport-security"] !== HSTS) problem(`${url.pathname}: Strict-Transport-Security is ${h["strict-transport-security"]}`);
  } else if (url.origin === site.origin) {
    siteResponses++;
    const sitePath = url.pathname.slice(BASE.length) || "/";
    for (const [name, value] of shipped.find((r) => r.path === "/*").headers) {
      if (h[name.toLowerCase()] !== value) problem(`${url.pathname}: ${name} is ${JSON.stringify(h[name.toLowerCase()])}`);
    }
    if (res.status() === 200) {
      const want = HASHED.test(sitePath) ? "public, max-age=31536000, immutable" : "no-cache";
      if (h["cache-control"] !== want) problem(`${url.pathname}: Cache-Control is ${JSON.stringify(h["cache-control"])}, not ${want}`);
    }
  } else if (url.origin === api.origin) {
    apiResponses++;
    for (const [name, value] of Object.entries(API_HEADERS)) {
      if (h[name.toLowerCase()] !== value) problem(`server ${url.pathname}: ${name} is ${JSON.stringify(h[name.toLowerCase()])}`);
    }
    if (h["access-control-allow-origin"] !== site.origin) problem(`server ${url.pathname}: Access-Control-Allow-Origin is ${h["access-control-allow-origin"]}`);
  }
}

/** The page in use, so a failure can leave a picture of it behind (E2E_ARTIFACTS=<dir>). */
let current = null;
try {
  // -------------------------------------------------------------- the main flow
  const { context, page, pictures } = await watched();
  current = page;
  // What an earlier build of the site (or anything else on the origin) left in storage: another
  // server and a token. Neither may be used: the policy allows the built server alone, and on the
  // web the token is never kept.
  await context.addInitScript(() => {
    if (sessionStorage.getItem("e2e-seeded")) return;
    sessionStorage.setItem("e2e-seeded", "1");
    localStorage.setItem("tvsham.settings.v1", JSON.stringify({ serverUrl: "https://elsewhere.example", token: "stale-token-from-storage" }));
  });

  step("the site opens on the video picker, and the camera tab says what to do instead");
  const opened = await page.goto(`${site.origin}${BASE}/`);
  assert.equal(opened.status(), 200);
  await page.getByRole("button", { name: "Choose a video" }).waitFor();
  await page.getByRole("tab", { name: "Point at a TV" }).click();
  await page.getByText("Recording is in the phone app").waitFor();
  await page.getByRole("button", { name: "Choose a video" }).click();
  await page.getByText("Pick a video saved on this device").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.className), "", "the safety net stands aside once the app draws");

  step("Settings shows the server the site was built for, and the token reaches it");
  await page.getByText("Settings", { exact: true }).click();
  await page.getByText(api.origin, { exact: true }).waitFor();
  assert.equal(await page.getByText("https://elsewhere.example").count(), 0, "a stored server address is not used");
  await page.getByText("In a browser the token is kept only while this tab is open").waitFor();
  // The site's api/ answers here, so the account and the accent packs are drawn: signed out, each
  // pack at the price Stripe holds for it, to sign in for.
  await page.getByRole("button", { name: "Sign in with Google" }).waitFor();
  await page.getByText("Accent packs", { exact: true }).waitFor();
  assert.equal(await page.getByText("€1.99", { exact: true }).count(), 3, "three packs, priced");
  assert.equal(await page.getByRole("button", { name: "Sign in to buy: Sunset accent" }).count(), 1);
  await page.getByPlaceholder("Matches APP_TOKEN on the server").fill(TOKEN);
  await page.getByRole("button", { name: "Test connection" }).click();
  await page.getByText(/^Connected · v0\.1\.0/).waitFor();
  await page.goBack();

  step("a chosen video is identified, with its pictures, its links, where to watch it and who is in it");
  await page.getByPlaceholder("Optional hint: “90s sitcom”, “on Netflix”…").fill("an animated short");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose a video" }).click()]);
  await chooser.setFiles(clip);
  await page.waitForURL(`${site.origin}${BASE}/result`, { timeout: 60_000 });
  await page.getByText("Big Buck Bunny", { exact: true }).first().waitFor();
  await page.getByText("Confident match").waitFor();
  await page.getByText("Example Stream").waitFor();
  await page.getByText("Himself").waitFor();
  await page.waitForFunction(() => [...document.images].length > 0 && [...document.images].every((i) => i.complete));
  for (const host of PICTURE_HOSTS) assert.ok(pictures.includes(host), `the result asked ${host} for its picture`);

  step("it is saved for later, and is still in the library after a reload");
  await page.getByRole("button", { name: "Save for later" }).click();
  await page.getByText("Saved for later ✓").waitFor();
  await page.goto(`${site.origin}${BASE}/library`);
  await page.getByText("Big Buck Bunny", { exact: true }).first().waitFor();
  await page.reload();
  await page.getByText("Big Buck Bunny", { exact: true }).first().waitFor();

  step("the token was never written down, and the stale server address is gone");
  const stored = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));
  assert.ok(!JSON.stringify(stored).includes(TOKEN), "the access token is not in localStorage");
  assert.equal(JSON.parse(stored["tvsham.settings.v1"]).token, "");
  assert.equal(JSON.parse(stored["tvsham.settings.v1"]).serverUrl, api.origin);
  await page.goto(`${site.origin}${BASE}/settings`);
  await page.getByText(api.origin, { exact: true }).waitFor();
  assert.equal(await page.getByPlaceholder("Matches APP_TOKEN on the server").inputValue(), "", "a reload forgets the token");

  step("a missing page is the site's own 404, under the same policy");
  expect404 = true;
  const missing = await page.goto(`${site.origin}${BASE}/no-such-page`);
  assert.equal(missing.status(), 404);
  await page.getByText("That page isn’t here").waitFor();
  expect404 = false;
  await page.getByRole("link", { name: "Open TVsham" }).click();
  await page.getByRole("button", { name: "Choose a video" }).waitFor();
  await context.close();

  // -------------------------------------------------------------- the account and the shop
  step("the account: sign in with Google, buy an accent, Stripe's webhook unlocks it, sign out, delete");
  {
    const { context: c, page: p } = await watched();
    current = p;
    const outside = [];
    // The kit answers the sign-in's start with a 302 to Google, and Playwright routes no request a
    // redirect makes (measured: the browser went to the real accounts.google.com). So the browser
    // is handed the kit's own answer, its sign-in cookie included, as a Refresh to that same
    // address, which it then asks for as a navigation of its own; that one is answered here as
    // Google answers it, with a 302 back to the callback, which the browser follows to the site.
    await p.route(`${site.origin}${BASE}/api/auth/google/start*`, async (route) => {
      const res = await route.fetch({ maxRedirects: 0 });
      const location = res.headers()["location"] ?? "";
      if (res.status() !== 302 || !location.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")) {
        problem(`the sign-in start answered ${res.status()} ${location}`);
      }
      const headers = { ...res.headers(), refresh: `0; url=${location}` };
      delete headers.location;
      await route.fulfill({ status: 200, headers, body: "" });
    });
    await p.route("https://accounts.google.com/**", async (route) => {
      outside.push("google");
      await route.fulfill({ status: 302, headers: { location: fakes.consent(route.request().url()).href } });
    });
    // Stripe's Checkout: the page is sent to it only with the address the kit had Stripe make, and
    // it sends the page back to the success address, as Stripe does once the card is taken.
    const checkouts = [];
    await p.route("https://checkout.stripe.com/**", async (route) => {
      outside.push("stripe");
      checkouts.push(route.request().url());
      await route.fulfill({ status: 302, headers: { location: `${APP_URL}?purchase=success` } });
    });
    const accentOf = async () =>
      p.getByRole("button", { name: "Test connection" }).evaluate((el) => getComputedStyle(el).backgroundColor);
    const MIDNIGHT = "rgb(111, 77, 255)";
    const SUNSET = "rgb(255, 107, 61)";
    const signIn = async () => {
      await p.getByRole("button", { name: "Sign in with Google" }).click();
      await p.waitForURL(`${site.origin}${BASE}/settings`);
      await p.getByText("Signed in as ada@example.com").waitFor();
    };

    await p.goto(`${site.origin}${BASE}/settings`);
    await p.getByRole("button", { name: "Sign in with Google" }).waitFor();
    assert.equal(await p.getByRole("button", { name: "Sunset", exact: true }).isDisabled(), true, "a pack on sale is not chosen for free");
    await signIn();
    assert.equal(await p.context().cookies().then((all) => all.filter((k) => k.name === "__Host-tvsham-session").length), 1, "a session cookie of the site's own");

    // Buy: Checkout, and back to the site before the webhook has said anything.
    await p.getByRole("button", { name: "Buy: Sunset accent" }).click();
    await p.waitForURL(new RegExp(`^${site.origin}${BASE}/?(\\?purchase=success)?$`));
    assert.equal(checkouts.length, 1);
    assert.ok(checkouts[0].startsWith("https://checkout.stripe.com/c/pay/cs_test_fake"), checkouts[0]);
    // Stripe's signed webhook, through the site's own address as Stripe would post it.
    const delivery = signedDelivery(fakes.paid(checkouts[0]));
    const hook = await fetch(`${APP_URL}api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": delivery.signature }, body: delivery.body });
    assert.equal(hook.status, 200);
    await p.getByText("Thank you — Sunset accent is unlocked.").waitFor({ timeout: 20_000 });
    // Through the router, which is ready a moment after the first frame (account-ui.tsx), so the
    // address is waited for: when the webhook has landed before the page asks, the thank-you can
    // come first (seen in CI).
    await p.waitForFunction(() => location.search === "", null, { timeout: 5_000 });
    await p.getByRole("button", { name: "Dismiss" }).click();

    // ...and stays out of it when the router writes the address again, coming back to this screen.
    await p.getByText("Settings", { exact: true }).click();
    await p.getByText("Owned", { exact: true }).waitFor();
    await p.goBack();
    await p.getByRole("button", { name: "Choose a video" }).waitFor();
    assert.equal(await p.evaluate(() => location.search), "", "the router does not put the purchase back");

    // The accent is the visitor's now: chosen, drawn, and still drawn after a reload.
    await p.getByText("Settings", { exact: true }).click();
    await p.getByText("Owned", { exact: true }).waitFor();
    assert.equal(await accentOf(), MIDNIGHT);
    await p.getByRole("button", { name: "Sunset", exact: true }).click();
    await p.waitForFunction((want) => getComputedStyle([...document.querySelectorAll("[role=button]")].find((b) => b.textContent === "Test connection")).backgroundColor === want, SUNSET);
    await p.reload();
    await p.getByText("Signed in as ada@example.com").waitFor();
    assert.equal(await accentOf(), SUNSET);

    // Signed out, the account is not there to say so: Midnight is drawn, and Sunset is for sale again.
    await p.getByRole("button", { name: "Sign out" }).click();
    await p.getByRole("button", { name: "Sign in with Google" }).waitFor();
    assert.equal(await accentOf(), MIDNIGHT);
    assert.equal(await p.getByRole("button", { name: "Sign in to buy: Sunset accent" }).count(), 1);

    // Signed in again, it is back; deleted, the account and the purchase are gone together.
    await signIn();
    assert.equal(await accentOf(), SUNSET);
    p.once("dialog", (dialog) => void dialog.accept());
    await p.getByRole("button", { name: "Delete account" }).click();
    await p.getByRole("button", { name: "Sign in with Google" }).waitFor();
    assert.equal(await accentOf(), MIDNIGHT);
    await signIn();
    assert.equal(await p.getByRole("button", { name: "Buy: Sunset accent" }).count(), 1, "a new account owns nothing");
    assert.equal(await accentOf(), MIDNIGHT);
    assert.deepEqual(outside, ["google", "stripe", "google", "google"], "Google and Stripe were reached by navigation alone");

    // A sign-in that does not complete says so on the site, once.
    await p.goto(`${APP_URL}api/auth/google/callback?code=forged&state=forged`);
    await p.getByText("Sign-in didn't complete.").waitFor();
    await p.waitForFunction(() => location.search === "", null, { timeout: 5_000 });

    // The policy lets the page reach its own site and the server, and nothing else.
    expectRefusedConnect = "https://example.com/";
    assert.equal(await p.evaluate(() => fetch("https://example.com/").then(() => "loaded", () => "refused")), "refused");
    for (let i = 0; i < 50 && !refusedConnects.includes("securitypolicyviolation:"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(refusedConnects.includes("securitypolicyviolation:"), "refused by connect-src, and reported");
    assert.deepEqual(fakes.unexpected, []);
    await c.close();
    expectRefusedConnect = null;
  }

  step("where nothing answers api/, the page asks once and draws no account and no shop");
  {
    serveSite(false);
    try {
      const { context: c, page: p } = await watched();
      current = p;
      const asked = log.length;
      await p.goto(`${site.origin}${BASE}/settings`);
      await p.getByText("Recognition server", { exact: true }).waitFor();
      await p.getByText("Feedback and motion", { exact: true }).waitFor();
      await p.waitForFunction(() => document.readyState === "complete");
      await p.waitForTimeout(500);
      assert.equal(await p.getByRole("button", { name: "Sign in with Google" }).count(), 0);
      assert.equal(await p.getByText("Accent packs").count(), 0);
      for (const name of ["Midnight", "Sunset", "Forest", "Mono"]) {
        assert.equal(await p.getByRole("button", { name, exact: true }).isDisabled(), false, `${name} is chosen as before`);
      }
      const apiAsks = log.slice(asked).filter((r) => r.path.startsWith(`${BASE}/api/`));
      assert.deepEqual(apiAsks, [{ method: "GET", path: `${BASE}/api/config`, status: 404 }], "one question, a 404, and nothing more");
      assert.equal(noApi404s, 1, "and the one console line Chromium logs for it");
      await c.close();
    } finally {
      serveSite(true);
    }
  }

  step("with the server out of reach, a chosen video is said to be not kept, and what to do");
  {
    // A browser has nowhere to keep a clip for later, so the message is the whole of what the
    // visitor learns: it must say the server was not reached and the video has to be chosen again,
    // not the network's own "Failed to fetch".
    const { context: c, page: p } = await watched();
    await c.route(`${api.origin}/**`, (route) => route.abort("connectionrefused"));
    expectUnreachable = true;
    await p.goto(`${site.origin}${BASE}/`);
    const [chosen] = await Promise.all([p.waitForEvent("filechooser"), p.getByRole("button", { name: "Choose a video" }).click()]);
    await chosen.setFiles(clip);
    await p.getByText("Couldn’t identify").waitFor({ timeout: 30_000 });
    await p.getByText("Couldn’t reach the server. The video was not kept: choose it again once the server answers.").waitFor();
    assert.equal(await p.getByText("Failed to fetch").count(), 0, "not the network's own words");
    expectUnreachable = false;
    await c.close();
  }

  step("the hosting files, the repository's own files, a folder and a missing script are 404s");
  for (const path of [
    "/_headers",
    "/_redirects",
    "/.htaccess",
    "/README.md",
    "/.git/config",
    "/deploy/nginx.conf",
    "/package.json",
    "/_expo/",
    "/assets/",
    "/_expo/static/js/web/missing.js",
  ]) {
    const res = await fetch(`${site.origin}${BASE}${path}`);
    assert.equal(res.status, 404, `${path} answers 404`);
  }

  step("the server answers the site's preflight, for the site's origin alone");
  const preflight = await fetch(`${api.origin}/sessions`, {
    method: "OPTIONS",
    headers: { Origin: site.origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), site.origin);
  for (const [name, value] of Object.entries(API_HEADERS)) assert.equal(preflight.headers.get(name), value, `the preflight carries ${name}`);

  // -------------------------------------------------------------- the safety net
  step("a bundle that does not load leaves a note, not an empty page");
  {
    // As a deploy that mixes one build's page with another's scripts leaves it: the page names a
    // bundle the host does not have, and gets 404.html back, which nosniff keeps from running.
    const scripts = join(out, "_expo/static/js/web");
    const entry = readdirSync(scripts).find((f) => f.startsWith("entry-"));
    renameSync(join(scripts, entry), join(work, entry));
    try {
      const { context: c, page: p } = await watched();
      expect404 = true;
      await p.goto(`${site.origin}${BASE}/`);
      await p.getByText("TVsham could not start").waitFor();
      expect404 = false;
      await c.close();
    } finally {
      renameSync(join(work, entry), join(scripts, entry));
    }
  }
  step("a browser without what the app needs is told so");
  {
    const { context: c, page: p } = await watched();
    await c.addInitScript(() => {
      delete AbortSignal.timeout;
    });
    await p.goto(`${site.origin}${BASE}/`);
    await p.getByText("TVsham could not start").waitFor();
    await c.close();
  }
  step("without JavaScript the page says so");
  {
    const { context: c, page: p } = await watched({ javaScriptEnabled: false });
    await p.goto(`${site.origin}${BASE}/`);
    // Through CSS rather than by text: Playwright's text engine does not read <noscript>.
    const note = p.locator("noscript .site-note");
    assert.ok(await note.isVisible(), "the no-JavaScript note is shown");
    assert.match(await note.innerText(), /^TVsham needs JavaScript\./);
    assert.equal(await p.locator(".site-note.startup-failed").isVisible(), false);
    await c.close();
  }
} catch (err) {
  problem(err instanceof Error ? err.stack ?? err.message : String(err));
  if (process.env.E2E_ARTIFACTS && current && !current.isClosed()) {
    await current.screenshot({ path: join(process.env.E2E_ARTIFACTS, "web-failure.png"), fullPage: true }).catch(() => {});
  }
} finally {
  await browser.close();
  apiServer.s.close();
  await site.close();
  setClientForTests(null);
  setFetchForTests(null);
  setAccountForTests(null);
  rmSync(work, { recursive: true, force: true });
}

const left = log.filter((r) => !r.path.startsWith(`${BASE}/`) && r.path !== BASE);
if (left.length) problem(`requests outside ${BASE}: ${left.map((r) => r.path).join(", ")}`);
if (siteResponses === 0 || apiResponses === 0 || accountResponses === 0) {
  problem(`headers were checked on ${siteResponses} site, ${apiResponses} server and ${accountResponses} account responses`);
}
// The kit logs one line for the sign-in staged to fail above, and nothing else.
assert.deepEqual(accountLog, ["warn: kit (tvsham): sign-in failed (no valid sign-in cookie)"]);
if (warnings.size) console.log(`\nConsole warnings (not failures):\n${[...warnings].map((w) => `  ${w}`).join("\n")}`);
console.log(`\n${siteResponses} site, ${accountResponses} account and ${apiResponses} server responses checked; outside calls the server made: ${[...new Set(outside)].join(", ")}`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("The website passed.");
process.exit(0);
