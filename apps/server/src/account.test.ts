import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { SOLD_ACCENTS, accentProduct } from "@tvsham/shared";
import { priceVariable, validateCatalogue } from "../kit/app.js";
import { createMemoryStore } from "../kit/store.js";
import { accountProblem, createAccount, type Account } from "./account.js";
import { catalogue } from "./catalogue.js";
import { config } from "./config.js";
import { setFetchForTests } from "./http.js";
import { API_HEADERS, app, loggedPath, setAccountForTests } from "./index.js";
import { PRICE_CENTS, createFakes, envFor, priceOf, signedDelivery, type Fakes } from "./testing/kit-fakes.js";

/**
 * The website's account and shop as this server carries them: the kit (kit/) mounted in the
 * Hono app below APP_URL's path and `api/`, driven over a real socket through @hono/node-server -
 * the adapter the server runs on - with a fake Google and a fake Stripe handed to the kit
 * through createApp({ fetch }) (createAccount's `fetch`, testing/kit-fakes.ts). The kit's own
 * guards are its self-test's (kit/selftest.mjs, run first by `npm test`); what is pinned here is
 * this server's part: the catalogue, where the mount sits among the gates, the headers, the
 * logs, the store, and the start-up refusals.
 */

const here = path.dirname(new URL(import.meta.url).pathname);
const serverRoot = path.resolve(here, "..");
const exec = promisify(execFile);

/** No test here may reach the network: the kit is handed its fakes, and the rest is loopback. */
const realFetch = globalThis.fetch;
const escaped: string[] = [];
before(() => {
  globalThis.fetch = async (input) => {
    escaped.push(String(input));
    throw new Error(`a test reached for the network: ${String(input)}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  setAccountForTests(null);
  assert.deepEqual(escaped, []);
});

/** The server on a loopback port, and a client for it that sends exactly what it is given. */
async function listening() {
  const server = await new Promise<ReturnType<typeof serve>>((done) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => done(s));
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const call = (route: string, init: RequestInit = {}) => {
    const url = new URL(route, origin);
    assert.equal(url.origin, origin, "the client only ever calls this server");
    return realFetch(url, { redirect: "manual", ...init });
  };
  return { origin, call, close: () => new Promise<void>((done) => server.close(() => done())) };
}

/** `name=value` of a Set-Cookie line. */
const pair = (line: string) => line.split(";", 1)[0] ?? "";

describe("the catalogue", () => {
  it("sells each accent the app has but Midnight, once, granting the accent's own id", () => {
    const checked = validateCatalogue(catalogue);
    assert.equal(checked.app, "tvsham");
    assert.deepEqual(
      checked.products.map((p) => [p.id, p.mode, p.grants]),
      [
        ["accent-sunset", "payment", "accent-sunset"],
        ["accent-forest", "payment", "accent-forest"],
        ["accent-mono", "payment", "accent-mono"],
      ],
    );
    assert.deepEqual([...SOLD_ACCENTS], ["sunset", "forest", "mono"]);
    assert.deepEqual(
      checked.products.map((p) => priceVariable(p.id)),
      ["STRIPE_PRICE_ACCENT_SUNSET", "STRIPE_PRICE_ACCENT_FOREST", "STRIPE_PRICE_ACCENT_MONO"],
    );
    assert.deepEqual(
      checked.products.map((p) => p.name),
      ["Sunset accent", "Forest accent", "Mono accent"],
    );
  });

  it("is what the server is built from, and the test tooling is not", () => {
    // src/testing/ is left out of the build, so a module of the server that imported it
    // would fail in the image rather than here: nothing but the tests may.
    const build = JSON.parse(readFileSync(path.join(serverRoot, "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, "")) as { exclude: string[] };
    assert.ok(build.exclude.includes("src/testing/**"), "the build leaves the test tooling out");
    const sources = readdirSync(path.join(serverRoot, "src"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("testing"));
    assert.ok(sources.includes("account.ts") && sources.includes("index.ts"));
    for (const file of sources) {
      assert.doesNotMatch(readFileSync(path.join(serverRoot, "src", file), "utf8"), /["']\.{1,2}\/(?:\.\.\/)*testing\//, `${file} imports test tooling`);
    }
    // The kit is reached from src/ and from dist/ by the same relative path, which is what the
    // image relies on (Dockerfile: apps/server/kit beside apps/server/dist).
    const imports = [...readFileSync(path.join(serverRoot, "src/account.ts"), "utf8").matchAll(/from "(\.\.\/kit\/[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["../kit/app.js", "../kit/node.js", "../kit/store.js"]);
  });
});

describe("the account, mounted in the server", () => {
  let fakes: Fakes;
  let server: Awaited<ReturnType<typeof listening>>;
  const originalCors = config.corsOrigin;
  const originalToken = config.appToken;
  const store = createMemoryStore();
  let account: Account;

  before(async () => {
    fakes = await createFakes();
    server = await listening();
    // The site and the server share one origin here, as they do behind the site's proxy.
    account = createAccount({ env: envFor(`${server.origin}/`), store, fetch: fakes.fetch, log: () => {} });
    setAccountForTests(account);
    (config as { corsOrigin: string | undefined }).corsOrigin = server.origin;
  });
  after(async () => {
    (config as { corsOrigin: string | undefined }).corsOrigin = originalCors;
    (config as { appToken?: string }).appToken = originalToken;
    setAccountForTests(null);
    await server.close();
    assert.deepEqual(fakes.unexpected, []);
  });

  /** A whole sign-in as the browser makes it: start, Google's consent, the callback. */
  async function signIn(person = { sub: "1001", email: "ada@example.com" }, back = "/settings") {
    const started = await server.call(`/api/auth/google/start?return=${encodeURIComponent(back)}`);
    assert.equal(started.status, 302);
    const oauth = started.headers.getSetCookie().map(pair);
    assert.equal(oauth.length, 1);
    const callback = fakes.consent(started.headers.get("location") ?? "", person);
    assert.equal(callback.origin, server.origin, "Google sends the browser back to APP_URL's callback");
    const landed = await server.call(callback.pathname + callback.search, { headers: { cookie: oauth[0]! } });
    assert.equal(landed.status, 302);
    assert.equal(landed.headers.get("location"), `${server.origin}${back}`);
    // Two cookies over the socket: the session, and the sign-in cookie cleared.
    const cookies = landed.headers.getSetCookie();
    assert.equal(cookies.length, 2, "both of the callback's cookies survive the adapter");
    const session = cookies.map(pair).find((c) => c.startsWith("__Host-tvsham-session="));
    assert.ok(session && session.length > "__Host-tvsham-session=".length, "a session cookie");
    assert.ok(cookies.some((c) => c.startsWith("__Host-tvsham-oauth=;")), "and the sign-in cookie cleared");
    return session;
  }

  it("reports sign-in and the three accents, priced from Stripe, ahead of the bearer gate", async () => {
    (config as { appToken?: string }).appToken = "a-real-token-of-sufficient-length";
    try {
      const res = await server.call("/api/config");
      assert.equal(res.status, 200, "the page asks this without the token, which it does not keep");
      assert.deepEqual(await res.json(), {
        auth: { google: true },
        shop: {
          products: SOLD_ACCENTS.map((accent) => ({
            id: accentProduct(accent),
            name: catalogue.products.find((p) => p.id === accentProduct(accent))?.name,
            description: catalogue.products.find((p) => p.id === accentProduct(accent))?.description,
            mode: "payment",
            price: { unit_amount: PRICE_CENTS, currency: "eur" },
          })),
        },
      });
      // Every other route is still behind the token.
      assert.equal((await server.call("/sessions", { method: "POST" })).status, 401);
      assert.equal((await server.call("/health")).status, 200);
      for (const accent of SOLD_ACCENTS) assert.ok(fakes.calls.includes(`GET https://api.stripe.com/v1/prices/${priceOf(accentProduct(accent))}`));
    } finally {
      (config as { appToken?: string }).appToken = originalToken;
    }
  });

  it("sends the server's API headers on the kit's answers, which win over the kit's own", async () => {
    const answers = [
      await server.call("/api/config"),
      await server.call("/api/me"),
      await server.call("/api/nothing-here"),
      await server.call("/api/auth/google/start"),
      await server.call("/api/checkout", { method: "POST", headers: { origin: server.origin, "content-type": "application/json" }, body: "{}" }),
    ];
    assert.deepEqual(answers.map((r) => r.status), [200, 200, 404, 302, 401]);
    for (const res of answers) {
      for (const [name, value] of Object.entries(API_HEADERS)) assert.equal(res.headers.get(name), value, `${res.url}: ${name}`);
    }
  });

  it("signs in, sells an accent once Stripe's signed webhook says it is paid, signs out and deletes", async () => {
    const session = await signIn();
    const me = async (cookie = session) => (await (await server.call("/api/me", { headers: { cookie } })).json()) as { user: { email?: string } | null; entitlements: string[] };
    assert.deepEqual(await me(), { user: { email: "ada@example.com" }, entitlements: [] });

    const buy = (product: string, headers: Record<string, string> = {}) =>
      server.call("/api/checkout", {
        method: "POST",
        headers: { cookie: session, origin: server.origin, "content-type": "application/json", ...headers },
        body: JSON.stringify({ product }),
      });
    // The kit's own gate refuses a write with no Origin; this server's refuses another site's
    // before the kit sees it, in this server's words.
    assert.equal((await buy("accent-sunset", { origin: "" })).status, 403);
    const foreign = await buy("accent-sunset", { origin: "https://evil.example" });
    assert.equal(foreign.status, 403);
    assert.deepEqual(await foreign.json(), { error: "cross-origin request refused" });
    assert.equal((await buy("accent-midnight")).status, 404, "Midnight is not sold");

    const bought = await buy("accent-sunset");
    assert.equal(bought.status, 200);
    const { url } = (await bought.json()) as { url: string };
    assert.ok(url.startsWith("https://checkout.stripe.com/"), url);
    const asked = fakes.sessions.get(new URL(url).pathname.split("/").pop() ?? "");
    assert.equal(asked?.get("line_items[0][price]"), priceOf("accent-sunset"));
    assert.equal(asked?.get("success_url"), `${server.origin}/?purchase=success`);
    assert.deepEqual(await me(), { user: { email: "ada@example.com" }, entitlements: [] }, "nothing is granted at checkout");

    // A webhook that is not Stripe's grants nothing; Stripe's does.
    const event = fakes.paid(url);
    const forged = signedDelivery(event, { secret: "whsec_notTheEndpointsSecret000" });
    const refused = await server.call("/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": forged.signature }, body: forged.body });
    assert.equal(refused.status, 400);
    assert.deepEqual((await me()).entitlements, []);
    const delivery = signedDelivery(event);
    const hook = await server.call("/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": delivery.signature }, body: delivery.body });
    assert.equal(hook.status, 200);
    assert.deepEqual((await me()).entitlements, ["accent-sunset"]);
    assert.equal((await buy("accent-sunset")).status, 409, "an accent already owned is not sold twice");

    // Sign out: the session ends, and with it what the page is told.
    const out = await server.call("/api/auth/logout", { method: "POST", headers: { cookie: session, origin: server.origin } });
    assert.equal(out.status, 204);
    assert.deepEqual(await me(), { user: null, entitlements: [] });

    // The purchase is the account's: it is there at the next sign-in, and gone with the account.
    const again = await signIn();
    assert.deepEqual((await me(again)).entitlements, ["accent-sunset"]);
    const deleted = await server.call("/api/me", { method: "DELETE", headers: { cookie: again, origin: server.origin } });
    assert.equal(deleted.status, 204);
    assert.deepEqual(await me(again), { user: null, entitlements: [] });
    assert.deepEqual((await me(await signIn())).entitlements, [], "a new account owns nothing");
  });

  it("keeps Google's code and the sign-in's state out of the log", async () => {
    const printed: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => void printed.push(args.join(" "));
    try {
      await signIn({ sub: "2002", email: "grace@example.com" }, "/library?from=settings");
    } finally {
      console.log = realLog;
    }
    const lines = printed.filter((l) => l.includes("/api/auth/google/"));
    assert.ok(lines.length >= 4, "the sign-in's requests are still logged");
    for (const line of lines) assert.doesNotMatch(line, /code=|state=|return=|code\d/, line);
    assert.ok(lines.some((l) => l.includes("/api/auth/google/callback?<query>")));
    assert.equal(loggedPath("<-- GET /sessions/abc123?x=1"), "<-- GET /sessions/<id>?<query>");
  });
});

describe("the account's place below the site's path", () => {
  it("answers below APP_URL's path and nothing else, and /api/ alone while APP_URL is unset", () => {
    const fetch = async (): Promise<Response> => {
      throw new Error("no call expected");
    };
    const under = createAccount({ env: { APP_URL: "https://example.com/tvsham/" }, store: null, fetch, log: () => {} });
    assert.equal(under.prefix, "/tvsham/api/");
    assert.ok(under.owns("/tvsham/api/config") && !under.owns("/api/config") && !under.owns("/sessions"));
    const unset = createAccount({ env: {}, store: null, fetch, log: () => {} });
    assert.equal(unset.prefix, "/api/");
    assert.deepEqual(unset.features, { signIn: false, shop: false });
    assert.equal(unset.origin, null);
  });

  it("is off with no variables: config says so, and every other route is a JSON 404", async () => {
    setAccountForTests(createAccount({ env: {}, store: null, fetch: async () => new Response(null, { status: 599 }), log: () => {} }));
    try {
      const res = await app.request("/api/config");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { auth: { google: false }, shop: { products: [] } });
      for (const route of ["me", "auth/google/start", "checkout", "webhooks/stripe", "nothing"]) {
        const missing = await app.request(`/api/${route}`);
        assert.equal(missing.status, 404, route);
        assert.deepEqual(await missing.json(), { error: "not_found" });
      }
    } finally {
      setAccountForTests(null);
    }
  });

  it("stays off, and says which variable, when sign-in has no store to keep sessions in", () => {
    const said: string[] = [];
    const account = createAccount({ env: envFor("https://example.com/"), fetch: async () => new Response(null), log: (_l, m) => void said.push(m) });
    assert.deepEqual(account.features, { signIn: false, shop: false });
    assert.ok(said.some((m) => m.includes("KIT_DATA_DIR")), said.join("\n"));
  });
});

describe("the account's way out", () => {
  it("reaches Google and Stripe through http.ts, which the tests stand in for", async () => {
    const fakes = await createFakes();
    setFetchForTests((input, init) => fakes.fetch(String(input), init));
    try {
      const account = createAccount({ env: envFor("https://tvsham.example/"), store: createMemoryStore(), log: () => {} });
      const res = await account.handle(new Request("https://tvsham.example/api/config"));
      const body = (await res.json()) as { shop: { products: Array<{ price?: unknown }> } };
      assert.deepEqual(body.shop.products.map((p) => p.price), SOLD_ACCENTS.map(() => ({ unit_amount: PRICE_CENTS, currency: "eur" })));
      assert.ok(fakes.calls.length >= SOLD_ACCENTS.length, "the prices were asked of the stand-in");
    } finally {
      setFetchForTests(null);
    }
  });
});

describe("the account's records", () => {
  it("are kept in KIT_DATA_DIR, and outlive the process that wrote them", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tvsham-account-"));
    const fakes = await createFakes();
    const appUrl = "http://127.0.0.1:1/";
    const env = { ...envFor(appUrl), KIT_DATA_DIR: path.join(dir, "account") };
    try {
      const first = createAccount({ env, fetch: fakes.fetch, log: () => {} });
      assert.deepEqual(first.features, { signIn: true, shop: true });
      const go = (account: Account, route: string, init: RequestInit = {}) => account.handle(new Request(new URL(route, appUrl), { redirect: "manual", ...init }));
      const started = await go(first, "/api/auth/google/start");
      const callback = fakes.consent(started.headers.get("location") ?? "");
      const landed = await go(first, callback.pathname + callback.search, { headers: { cookie: pair(started.headers.getSetCookie()[0] ?? "") } });
      const session = landed.headers.getSetCookie().map(pair).find((c) => c.startsWith("__Host-tvsham-session=")) ?? "";
      const bought = await go(first, "/api/checkout", {
        method: "POST",
        headers: { cookie: session, origin: "http://127.0.0.1:1", "content-type": "application/json" },
        body: JSON.stringify({ product: "accent-mono" }),
      });
      const delivery = signedDelivery(fakes.paid(((await bought.json()) as { url: string }).url));
      assert.equal((await go(first, "/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": delivery.signature }, body: delivery.body })).status, 200);

      // A restart: a new account over the same directory still knows the session and the purchase.
      const second = createAccount({ env, fetch: fakes.fetch, log: () => {} });
      const me = await (await go(second, "/api/me", { headers: { cookie: session } })).json();
      assert.deepEqual(me, { user: { email: "ada@example.com" }, entitlements: ["accent-mono"] });
      assert.ok(readdirSync(path.join(dir, "account")).length > 0, "the records are files in KIT_DATA_DIR");
      assert.equal(await second.sweep(), 0, "and the sweep keeps what has not expired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("starting the server", () => {
  it("knows when sign-in and CORS_ORIGIN name different origins", () => {
    const on = { features: { signIn: true, shop: false }, origin: "https://tvsham.example.com" };
    assert.equal(accountProblem(on, "https://tvsham.example.com"), null);
    assert.match(accountProblem(on, undefined) ?? "", /CORS_ORIGIN is unset.*Set CORS_ORIGIN=https:\/\/tvsham\.example\.com/);
    assert.match(accountProblem(on, "https://other.example") ?? "", /CORS_ORIGIN is https:\/\/other\.example/);
    assert.equal(accountProblem({ features: { signIn: false, shop: false }, origin: "https://tvsham.example.com" }, undefined), null);
    assert.equal(accountProblem({ features: { signIn: false, shop: false }, origin: null }, "https://x.example"), null);
  });

  it("makes KIT_DATA_DIR at start, and stops when it cannot", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tvsham-account-dir-"));
    const base = { ...process.env, TMP_DIR: path.join(dir, "tmp"), PORT: "0", APP_URL: "", CORS_ORIGIN: "" };
    try {
      // A directory that cannot be made (a file is in the way): the server stops, saying why.
      writeFileSync(path.join(dir, "taken"), "");
      const blocked = exec(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: serverRoot, env: { ...base, KIT_DATA_DIR: path.join(dir, "taken", "account") }, timeout: 30_000 });
      await assert.rejects(blocked, (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr ?? "", /ENOTDIR/);
        return true;
      });
      // One that can: it exists, the server's own, before the server says it is listening.
      const records = path.join(dir, "account");
      const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: serverRoot, env: { ...base, KIT_DATA_DIR: records } });
      try {
        const said = await new Promise<string>((done, fail) => {
          let out = "";
          const timer = setTimeout(() => fail(new Error(`no start in 30 s: ${out}`)), 30_000);
          child.stdout.on("data", (chunk: Buffer) => {
            out += chunk.toString();
            if (out.includes("listening on")) {
              clearTimeout(timer);
              done(out);
            }
          });
        });
        assert.match(said, /website account \(\/api\/\): sign-in off, shop off/);
        assert.ok(statSync(records).isDirectory(), "KIT_DATA_DIR was made at start");
        assert.equal(statSync(records).mode & 0o777, 0o700, "readable by this server alone");
      } finally {
        child.kill();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start a sign-in whose every write its Origin gate would refuse", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tvsham-account-start-"));
    try {
      const env = {
        ...process.env,
        ...envFor("https://tvsham.example.com/"),
        KIT_DATA_DIR: path.join(dir, "account"),
        CORS_ORIGIN: "https://elsewhere.example",
        TMP_DIR: path.join(dir, "tmp"),
        PORT: "0",
      };
      const run = exec(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: serverRoot, env, timeout: 30_000 });
      await assert.rejects(run, (err: { code?: number; stderr?: string }) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr ?? "", /APP_URL's origin is https:\/\/tvsham\.example\.com but CORS_ORIGIN is https:\/\/elsewhere\.example/);
        return true;
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
