import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SOLD_ACCENTS } from "@tvsham/shared";
import { createAccountStore } from "./account.js";
import { accountClient as nativeTwin } from "./account-client.js";
import * as web from "./account-client.web.js";
import {
  ACCOUNT_NOTES,
  NO_LANDING,
  POLL,
  PRIVACY_WITH_ACCOUNT,
  SIGNED_OUT,
  WORDS,
  canUseAccent,
  drawnAccent,
  formatPrice,
  landingOf,
  ownedAccents,
  pollFor,
  readApiConfig,
  readMe,
  type AccentAccess,
  type AccountClient,
  type ApiConfig,
  type CheckoutResult,
  type Me,
} from "./account-model.js";
import { ACCENT_NAMES, type AccentName } from "./palette.js";
import { KEYS } from "./settings.js";

/**
 * The website's account and accent shop, on the page's side: what it reads from the site's api/
 * (account-model.ts), the web client that asks (account-client.web.ts) and its native twin that
 * does not, and the state the screens draw from (account.ts). The server's side is
 * apps/server/src/account.test.ts; the whole flow in Chromium is e2e/web.mjs.
 */

// .pathname rather than fileURLToPath: the DOM lib's URL type and Node's disagree under this
// tsconfig, and the path has nothing to decode.
const root = new URL("..", import.meta.url).pathname;

const product = (accent: string, extra: Record<string, unknown> = {}) => ({
  id: `accent-${accent}`,
  name: `${accent[0]!.toUpperCase()}${accent.slice(1)} accent`,
  description: `A ${accent} accent.`,
  mode: "payment",
  price: { unit_amount: 199, currency: "eur" },
  ...extra,
});

describe("what the page reads from api/config", () => {
  it("is nothing at all unless sign-in is on, whatever else the body says", () => {
    for (const raw of [null, undefined, 404, "x", [], {}, { auth: {} }, { auth: { google: false }, shop: { products: [product("sunset")] } }, { auth: { google: "true" } }]) {
      assert.equal(readApiConfig(raw), null, JSON.stringify(raw));
    }
    assert.deepEqual(readApiConfig({ auth: { google: true } }), { signIn: true, products: [] });
    assert.deepEqual(readApiConfig({ auth: { google: true }, shop: { products: "all" } }), { signIn: true, products: [] });
  });

  it("lists the accent packs this app sells, in its own order, and nothing else", () => {
    const config = readApiConfig({
      auth: { google: true },
      shop: {
        products: [
          product("mono"),
          product("sunset", { price: undefined }),
          product("midnight"),
          product("forest", { mode: "subscription" }),
          { ...product("forest"), id: "accent-forest", name: "" },
          product("sunset", { name: "A second Sunset" }),
          { id: "toString", name: "x", description: "", mode: "payment" },
          { id: "__proto__", name: "x", description: "", mode: "payment" },
          { ...product("mono"), id: "supporter" },
          product("forest", { description: "x".repeat(501) }),
          product("forest", { name: "Forest\u0000" }),
          "accent-forest",
        ],
      },
    });
    assert.deepEqual(config, {
      signIn: true,
      products: [
        { id: "accent-sunset", accent: "sunset", name: "Sunset accent", description: "A sunset accent.", price: null },
        { id: "accent-mono", accent: "mono", name: "Mono accent", description: "A mono accent.", price: { unitAmount: 199, currency: "eur" } },
      ],
    });
  });

  it("drops a price it cannot read, and keeps the product", () => {
    for (const price of [{ unit_amount: -1, currency: "eur" }, { unit_amount: 1.5, currency: "eur" }, { unit_amount: 199, currency: "EUR" }, { unit_amount: "199", currency: "eur" }, "€1.99"]) {
      assert.equal(readApiConfig({ auth: { google: true }, shop: { products: [product("sunset", { price })] } })?.products[0]?.price, null, JSON.stringify(price));
    }
  });
});

describe("what the page reads from api/me", () => {
  it("is who is signed in and what they own, field by field", () => {
    assert.deepEqual(readMe({ user: null, entitlements: [] }), SIGNED_OUT);
    assert.deepEqual(readMe({ user: { email: "ada@example.com" }, entitlements: ["accent-sunset", "accent-sunset", "Bad", 7, "accent-mono"] }), {
      user: { email: "ada@example.com" },
      entitlements: ["accent-sunset", "accent-mono"],
    });
    assert.deepEqual(readMe({ user: {}, entitlements: [] }), { user: { email: null }, entitlements: [] }, "signed in, no verified address");
    assert.deepEqual(readMe({ user: { email: "a\nb@example.com" }, entitlements: [] }), { user: { email: null }, entitlements: [] });
    for (const raw of [null, {}, { user: null }, { user: "ada", entitlements: [] }, { user: null, entitlements: "accent-sunset" }]) {
      assert.equal(readMe(raw), null, JSON.stringify(raw));
    }
  });

  it("names the accents it owns, among those the app sells", () => {
    assert.deepEqual([...ownedAccents({ user: null, entitlements: ["accent-forest", "accent-midnight", "supporter"] })], ["forest"]);
  });
});

describe("which accent is drawn, and which may be chosen", () => {
  const all: AccentName[] = [...ACCENT_NAMES];
  const shop = (sold: AccentName[], owned: AccentName[]): AccentAccess => ({ kind: "shop", sold: new Set(sold), owned: new Set(owned) });

  it("is what the settings record says where there is no shop: a phone, or a site with no api/", () => {
    const stored: AccentAccess = { kind: "stored" };
    for (const name of ACCENT_NAMES) {
      assert.equal(canUseAccent(stored, all, name), true);
      assert.equal(drawnAccent(stored, name), name, "the palette draws the chosen accent, as it always did");
    }
    assert.equal(canUseAccent(stored, ["midnight"], "sunset"), false);
  });

  it("is Midnight alone while the website is asking api/", () => {
    const asking: AccentAccess = { kind: "asking" };
    assert.equal(drawnAccent(asking, "sunset"), "midnight");
    assert.deepEqual(ACCENT_NAMES.filter((n) => canUseAccent(asking, all, n)), ["midnight"]);
  });

  it("is the server's word for an accent the shop sells, never the browser's copy", () => {
    const access = shop(["sunset", "forest"], ["forest"]);
    assert.equal(canUseAccent(access, all, "sunset"), false, "sold, not owned: the record's list does not unlock it");
    assert.equal(canUseAccent(access, all, "forest"), true);
    assert.equal(canUseAccent(access, all, "mono"), true, "not on sale: as the record has it");
    assert.equal(canUseAccent(access, ["midnight"], "mono"), false);
    assert.equal(canUseAccent(access, all, "midnight"), true);
    assert.equal(drawnAccent(access, "sunset"), "midnight", "a chosen accent the visitor does not own is not drawn");
    assert.equal(drawnAccent(access, "forest"), "forest");
    assert.equal(drawnAccent(access, "mono"), "mono");
  });
});

describe("the page's words", () => {
  it("are the ones every app that carries the kit says", () => {
    assert.equal(WORDS.signIn, "Sign in with Google");
    assert.equal(WORDS.signedInAs("ada@example.com"), "Signed in as ada@example.com");
    assert.equal(WORDS.signedIn, "Signed in with Google");
    assert.equal(WORDS.signOut, "Sign out");
    assert.equal(WORDS.deleteAccount, "Delete account");
    assert.equal(WORDS.signInFailed, "Sign-in didn't complete.");
    assert.equal(WORDS.buy, "Buy");
    assert.equal(WORDS.signInToBuy, "Sign in to buy");
    assert.equal(WORDS.owned, "Owned");
    assert.equal(WORDS.thanks("Sunset accent"), "Thank you — Sunset accent is unlocked.");
    assert.equal(WORDS.paymentPending, "Payment received. It can take a minute to appear — reload to check.");
    assert.match(ACCOUNT_NOTES.deleteBody, /accent packs you bought with it/);
  });

  it("say exactly what leaves the browser once there is an account to use", () => {
    assert.equal(
      PRIVACY_WITH_ACCOUNT,
      "If you sign in or buy an accent pack, Google tells this site an account id and your email address, and Stripe handles the payment on its own page. The site keeps the account id, what was bought and Stripe's customer id, and your email address only while you are signed in.",
    );
    // Drawn in "How it works" only when api/ offers sign-in, after the sentence every build says.
    const settings = readFileSync(join(root, "app/settings.tsx"), "utf8");
    assert.match(settings, /\{phase === "on" \? <Muted style=\{\{ marginTop: space\.sm \}\}>\{PRIVACY_WITH_ACCOUNT\}<\/Muted> : null\}/);
    assert.match(settings, /goes only to the server address you set above, and the server deletes a clip as soon as it has been analysed\./);
  });

  it("format a price in the currency's own unit", () => {
    assert.equal(formatPrice({ unitAmount: 199, currency: "eur" }, "en-US"), "€1.99");
    assert.equal(formatPrice({ unitAmount: 499, currency: "jpy" }, "en-US"), "¥499");
    // Intl puts a no-break space between a currency code and the amount.
    assert.match(formatPrice({ unitAmount: 1500, currency: "kwd" }, "en-US") ?? "", /^KWD\s1\.500$/);
    assert.match(formatPrice({ unitAmount: 1, currency: "zzz" }, "en-US") ?? "", /^ZZZ\s0\.01$/);
  });
});

describe("the address on the way back", () => {
  it("is read for the kit's two answers and Checkout's two, which are then taken out", () => {
    assert.deepEqual(landingOf("https://s.example/tvsham/?signin=failed"), { landing: { signIn: "failed", purchase: null }, without: "/tvsham/" });
    assert.deepEqual(landingOf("https://s.example/?purchase=success&x=1#h"), { landing: { signIn: null, purchase: "success" }, without: "/?x=1#h" });
    assert.deepEqual(landingOf("https://s.example/?purchase=cancelled"), { landing: { signIn: null, purchase: "cancelled" }, without: "/" });
    assert.deepEqual(landingOf("https://s.example/?purchase=refund&signin=ok"), { landing: NO_LANDING, without: null });
    assert.deepEqual(landingOf("not a url"), { landing: NO_LANDING, without: null });
  });

  it("asks api/me five times over fifteen seconds for the grant, and no more", async () => {
    assert.deepEqual(POLL, { tries: 5, everyMs: 3000 });
    const waited: number[] = [];
    let asked = 0;
    const never = await pollFor(
      (me) => me.entitlements.includes("accent-sunset"),
      async () => {
        asked += 1;
        return SIGNED_OUT;
      },
      async (ms) => void waited.push(ms),
    );
    assert.deepEqual(never, { held: false, me: SIGNED_OUT });
    assert.equal(asked, 5);
    assert.deepEqual(waited, [3000, 3000, 3000, 3000, 3000]);
    let third = 0;
    const found = await pollFor(
      (me) => me.entitlements.includes("accent-sunset"),
      async () => (++third === 3 ? { user: { email: null }, entitlements: ["accent-sunset"] } : null),
      async () => {},
    );
    assert.equal(found.held, true);
    assert.equal(third, 3);
  });
});

/** A client that answers as told, and records what the store asked of it. */
function fakeClient(answers: { config?: ApiConfig | null; me?: Array<Me | null>; landing?: typeof NO_LANDING; pending?: string | null; signOut?: boolean; delete?: boolean; checkout?: CheckoutResult } = {}) {
  const asked: string[] = [];
  const mes = [...(answers.me ?? [SIGNED_OUT])];
  const client: AccountClient = {
    web: true,
    config: async () => (asked.push("config"), answers.config === undefined ? null : answers.config),
    me: async () => (asked.push("me"), mes.length > 1 ? (mes.shift() ?? null) : (mes[0] ?? null)),
    signIn: () => void asked.push("signIn"),
    signOut: async () => (asked.push("signOut"), answers.signOut ?? true),
    deleteAccount: async () => (asked.push("delete"), answers.delete ?? true),
    checkout: async (id) => (asked.push(`checkout ${id}`), answers.checkout ?? "redirecting"),
    takeLanding: () => (asked.push("landing"), answers.landing ?? NO_LANDING),
    takePending: () => (asked.push("pending"), answers.pending ?? null),
  };
  return { client, asked };
}

const CONFIG: ApiConfig = readApiConfig({ auth: { google: true }, shop: { products: SOLD_ACCENTS.map((a) => product(a)) } })!;
const ADA: Me = { user: { email: "ada@example.com" }, entitlements: [] };
const noWait = async () => {};

describe("the account the screens draw", () => {
  it("is off at once in a phone app, which asks nothing", async () => {
    const store = createAccountStore(nativeTwin, noWait);
    assert.equal(store.get().phase, "off", "off from the first frame, before anything is asked");
    assert.deepEqual(store.access(), { kind: "stored" });
    await store.start();
    assert.equal(store.get().phase, "off");
  });

  it("asks api/config once, and is off when it does not answer as the kit does", async () => {
    const { client, asked } = fakeClient({ config: null });
    const store = createAccountStore(client, noWait);
    assert.equal(store.get().phase, "asking");
    assert.deepEqual(store.access(), { kind: "asking" });
    await Promise.all([store.start(), store.start()]);
    assert.equal(store.get().phase, "off");
    assert.deepEqual(store.access(), { kind: "stored" });
    assert.deepEqual(asked, ["landing", "config"], "no api/me, nothing asked again");
    await store.start();
    assert.deepEqual(asked, ["landing", "config"]);
  });

  it("is on, with the shop's accents and what the server says is owned", async () => {
    const { client } = fakeClient({ config: CONFIG, me: [{ ...ADA, entitlements: ["accent-mono"] }] });
    const store = createAccountStore(client, noWait);
    await store.start();
    assert.equal(store.get().phase, "on");
    assert.deepEqual(store.access(), { kind: "shop", sold: new Set(["sunset", "forest", "mono"]), owned: new Set(["mono"]) });
    // Sign-in on and no shop: every accent stays as the record has it.
    const signInOnly = createAccountStore(fakeClient({ config: { signIn: true, products: [] } }).client, noWait);
    await signInOnly.start();
    assert.deepEqual(signInOnly.access(), { kind: "stored" });
  });

  it("says a sign-in did not complete, once, until it is dismissed", async () => {
    const store = createAccountStore(fakeClient({ config: CONFIG, landing: { signIn: "failed", purchase: null } }).client, noWait);
    await store.start();
    assert.deepEqual(store.get().notice, { kind: "signInFailed" });
    store.dismiss();
    assert.equal(store.get().notice, null);
  });

  it("thanks for the pack this tab bought, once the webhook's grant shows", async () => {
    const { client, asked } = fakeClient({
      config: CONFIG,
      landing: { signIn: null, purchase: "success" },
      pending: "accent-forest",
      me: [ADA, ADA, { ...ADA, entitlements: ["accent-forest"] }],
    });
    const store = createAccountStore(client, noWait);
    await store.start();
    assert.deepEqual(store.get().notice, { kind: "thanks", name: "Forest accent" });
    assert.deepEqual(store.get().me.entitlements, ["accent-forest"], "and what the server said is what is drawn");
    assert.equal(asked.filter((a) => a === "me").length, 3, "asked until it showed, and no more");
  });

  it("thanks for whatever pack arrived when the tab kept no record of which", async () => {
    // Sunset comes first in the app's order and was owned before; Mono is the one that arrived.
    const store = createAccountStore(
      fakeClient({ config: CONFIG, landing: { signIn: null, purchase: "success" }, pending: null, me: [{ ...ADA, entitlements: ["accent-sunset"] }, { ...ADA, entitlements: ["accent-sunset", "accent-mono"] }] }).client,
      noWait,
    );
    await store.start();
    assert.deepEqual(store.get().notice, { kind: "thanks", name: "Mono accent" }, "not Sunset, which was owned before");
  });

  it("says the payment is in when the grant has not shown after five tries", async () => {
    const { client, asked } = fakeClient({ config: CONFIG, landing: { signIn: null, purchase: "success" }, pending: "accent-sunset", me: [ADA] });
    const store = createAccountStore(client, noWait);
    await store.start();
    assert.deepEqual(store.get().notice, { kind: "pending" });
    assert.equal(asked.filter((a) => a === "me").length, 1 + POLL.tries);
  });

  it("forgets the pack after a cancelled Checkout, and says nothing", async () => {
    const { client, asked } = fakeClient({ config: CONFIG, landing: { signIn: null, purchase: "cancelled" }, pending: "accent-sunset" });
    const store = createAccountStore(client, noWait);
    await store.start();
    assert.ok(asked.includes("pending"));
    assert.equal(store.get().notice, null);
  });

  it("buys through Checkout when signed in, and signs in first when not", async () => {
    const out = fakeClient({ config: CONFIG });
    const signedOut = createAccountStore(out.client, noWait);
    await signedOut.start();
    await signedOut.buy(CONFIG.products[0]!);
    assert.deepEqual(out.asked.slice(-1), ["signIn"], "Sign in to buy is a sign-in");

    const outcomes: Array<[CheckoutResult, unknown]> = [
      ["redirecting", null],
      ["unavailable", { kind: "error", text: ACCOUNT_NOTES.unavailable }],
      ["busy", { kind: "error", text: ACCOUNT_NOTES.busy }],
      ["failed", { kind: "error", text: ACCOUNT_NOTES.failed }],
    ];
    for (const [result, notice] of outcomes) {
      const { client, asked } = fakeClient({ config: CONFIG, me: [ADA], checkout: result });
      const store = createAccountStore(client, noWait);
      await store.start();
      await store.buy(CONFIG.products[1]!);
      assert.ok(asked.includes("checkout accent-forest"), result);
      assert.deepEqual(store.get().notice, notice, result);
      assert.equal(store.get().busy, result === "redirecting", `${result}: busy only while the page leaves`);
    }
    const expired = createAccountStore(fakeClient({ config: CONFIG, me: [ADA], checkout: "signin" }).client, noWait);
    await expired.start();
    await expired.buy(CONFIG.products[0]!);
    assert.deepEqual(expired.get().me, SIGNED_OUT, "a session the server ended shows as signed out");
    const owned = createAccountStore(fakeClient({ config: CONFIG, me: [ADA, { ...ADA, entitlements: ["accent-sunset"] }], checkout: "owned" }).client, noWait);
    await owned.start();
    await owned.buy(CONFIG.products[0]!);
    assert.deepEqual(owned.get().me.entitlements, ["accent-sunset"], "an accent already owned is read back");
  });

  it("signs out and deletes the account, and says so when the server would not", async () => {
    for (const [action, ok] of [["signOut", true], ["signOut", false], ["deleteAccount", true], ["deleteAccount", false]] as const) {
      const { client } = fakeClient({ config: CONFIG, me: [ADA], signOut: ok, delete: ok });
      const store = createAccountStore(client, noWait);
      await store.start();
      await store[action]();
      if (ok) assert.deepEqual(store.get().me, SIGNED_OUT, action);
      else {
        assert.deepEqual(store.get().me, ADA, action);
        assert.deepEqual(store.get().notice, { kind: "error", text: action === "signOut" ? ACCOUNT_NOTES.signOutFailed : ACCOUNT_NOTES.deleteFailed });
      }
      assert.equal(store.get().busy, false);
    }
  });
});

describe("the account's client on each platform", () => {
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  before(() => {
    globalThis.fetch = async (input) => {
      fetched.push(String(input));
      throw new Error("no request in this test");
    };
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  it("is the inert twin under the name a phone build resolves, which asks and opens nothing", async () => {
    // Metro picks account-client.web.ts for the website alone; Node, tsc and a phone build all
    // resolve the bare name to this file.
    assert.equal(nativeTwin.web, false);
    assert.equal(await nativeTwin.config(), null);
    assert.equal(await nativeTwin.me(), null);
    assert.equal(await nativeTwin.signOut(), false);
    assert.equal(await nativeTwin.deleteAccount(), false);
    assert.equal(await nativeTwin.checkout("accent-sunset"), "unavailable");
    nativeTwin.signIn();
    assert.deepEqual(nativeTwin.takeLanding(), NO_LANDING);
    assert.equal(nativeTwin.takePending(), null);
    assert.deepEqual(fetched, [], "no request");
    const twin = readFileSync(join(root, "src/account-client.ts"), "utf8");
    assert.doesNotMatch(twin, /fetch|XMLHttpRequest|location|window|https?:\/\//, "no network, no navigation, no address");
    const account = readFileSync(join(root, "src/account.ts"), "utf8");
    assert.match(account, /^import \{ accountClient \} from "\.\/account-client";$/m, "the store takes the platform's client by the bare name");
  });

  it("keeps the website's addresses in the web client alone", () => {
    // The sign-in start and Stripe's Checkout are named in one module, the one Metro bundles for
    // the website only; the phone apps' bundle cannot carry them.
    for (const dir of ["app", "src"]) {
      for (const name of readdirSync(join(root, dir))) {
        if (!/\.tsx?$/.test(name) || name.endsWith(".test.ts") || name === "account-client.web.ts") continue;
        // The code, not the comments that say what the web client does.
        const code = readFileSync(join(root, dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
        assert.doesNotMatch(code, /checkout\.stripe\.com|auth\/google\/start|auth\/logout|api\//, `${dir}/${name}`);
      }
    }
  });
});

describe("the website's client", () => {
  type Win = { location: { origin: string; pathname: string; search: string; href: string; assign(url: string): void }; history: { state: unknown; replaceState(s: unknown, t: string, url: string): void }; sessionStorage: Storage };
  const g = globalThis as unknown as { window?: Win; fetch: typeof fetch };
  const realFetch = globalThis.fetch;
  let assigned: string[] = [];
  let replaced: string[] = [];
  let calls: Array<{ url: string; init: RequestInit }> = [];
  let answer: () => Response = () => new Response(null, { status: 404 });
  const stored = new Map<string, string>();

  before(() => {
    g.window = {
      location: {
        origin: "https://tvsham.example",
        pathname: "/tvsham/settings",
        search: "?purchase=success",
        href: "https://tvsham.example/tvsham/settings?purchase=success",
        assign: (url) => void assigned.push(url),
      },
      history: { state: { router: 1 }, replaceState: (_s, _t, url) => void replaced.push(url) },
      sessionStorage: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => void stored.set(k, v),
        removeItem: (k: string) => void stored.delete(k),
      } as Storage,
    };
    g.fetch = async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return answer();
    };
  });
  after(() => {
    delete g.window;
    g.fetch = realFetch;
  });
  const reset = (next: () => Response) => {
    assigned = [];
    replaced = [];
    calls = [];
    answer = next;
  };

  it("asks the site's own api/, from the site's root, whatever route the page is on", () => {
    assert.equal(web.apiUrl("config", "/tvsham", "https://tvsham.example"), "https://tvsham.example/tvsham/api/config");
    assert.equal(web.apiUrl("me", "", "https://tvsham.example"), "https://tvsham.example/api/me");
    assert.equal(web.apiUrl("me", "/tvsham/", "https://tvsham.example"), "https://tvsham.example/tvsham/api/me");
    assert.equal(web.apiUrl("me"), "https://tvsham.example/api/me", "EXPO_BASE_URL unset: the root");
  });

  it("goes to Stripe's Checkout and nowhere else", () => {
    assert.equal(web.isCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_1"), true);
    for (const bad of ["https://checkout.stripe.com.evil.example/x", "https://checkout.stripe.com@evil.example/", "http://checkout.stripe.com/x", "https://checkout.stripe.com", "javascript:alert(1)", 7, null]) {
      assert.equal(web.isCheckoutUrl(bad), false, String(bad));
    }
  });

  it("reads api/config and api/me as the kit writes them, and anything else as nothing", async () => {
    reset(() => Response.json({ auth: { google: true }, shop: { products: [product("sunset")] } }));
    assert.equal((await web.accountClient.config())?.products[0]?.id, "accent-sunset");
    assert.equal(calls[0]?.url, "https://tvsham.example/api/config");
    assert.equal(calls[0]?.init.credentials, "same-origin");
    assert.ok(calls[0]?.init.signal, "with a deadline");
    for (const response of [new Response("<!doctype html>", { status: 404 }), new Response("not json"), Response.json({ auth: { google: false } })]) {
      reset(() => response);
      assert.equal(await web.accountClient.config(), null);
    }
    reset(() => {
      throw new TypeError("Failed to fetch");
    });
    assert.equal(await web.accountClient.config(), null, "a network error is no account");
    reset(() => Response.json({ user: { email: "ada@example.com" }, entitlements: ["accent-mono"] }));
    assert.deepEqual(await web.accountClient.me(), { user: { email: "ada@example.com" }, entitlements: ["accent-mono"] });
    assert.equal(calls[0]?.init.cache, "no-store");
  });

  it("signs in by a navigation that comes back to this page", () => {
    reset(() => new Response(null));
    web.accountClient.signIn();
    assert.deepEqual(assigned, ["https://tvsham.example/api/auth/google/start?return=%2Ftvsham%2Fsettings%3Fpurchase%3Dsuccess"]);
    assert.deepEqual(calls, [], "a navigation, not a request");
  });

  it("buys by POSTing the pack, then leaves only for Checkout, remembering the pack for the way back", async () => {
    reset(() => Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
    stored.clear();
    assert.equal(await web.accountClient.checkout("accent-sunset"), "redirecting");
    assert.equal(calls[0]?.url, "https://tvsham.example/api/checkout");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal(calls[0]?.init.body, '{"product":"accent-sunset"}');
    assert.deepEqual(calls[0]?.init.headers, { accept: "application/json", "content-type": "application/json" });
    assert.deepEqual(assigned, ["https://checkout.stripe.com/c/pay/cs_test_1"]);
    assert.equal(stored.get(KEYS.checkout), "accent-sunset");
    assert.equal(web.accountClient.takePending(), "accent-sunset");
    assert.equal(stored.has(KEYS.checkout), false, "read once");

    reset(() => Response.json({ url: "https://evil.example/pay" }));
    assert.equal(await web.accountClient.checkout("accent-sunset"), "failed");
    assert.deepEqual(assigned, [], "an address that is not Checkout's is not followed");
    for (const [status, result] of [[401, "signin"], [409, "owned"], [404, "unavailable"], [429, "busy"], [502, "failed"]] as const) {
      reset(() => Response.json({ error: "x" }, { status }));
      assert.equal(await web.accountClient.checkout("accent-sunset"), result, String(status));
      assert.deepEqual(assigned, []);
    }
  });

  it("signs out and deletes with the requests the kit's gate takes", async () => {
    reset(() => new Response(null, { status: 204 }));
    assert.equal(await web.accountClient.signOut(), true);
    assert.equal(await web.accountClient.deleteAccount(), true);
    assert.deepEqual(calls.map((c) => [c.init.method, c.url, c.init.body]), [
      ["POST", "https://tvsham.example/api/auth/logout", undefined],
      ["DELETE", "https://tvsham.example/api/me", undefined],
    ]);
    reset(() => new Response(null, { status: 403 }));
    assert.equal(await web.accountClient.signOut(), false);
    assert.equal(await web.accountClient.deleteAccount(), false);
  });

  it("takes the kit's answer out of the address and keeps the rest", () => {
    reset(() => new Response(null));
    assert.deepEqual(web.accountClient.takeLanding(), { signIn: null, purchase: "success" });
    assert.deepEqual(replaced, ["/tvsham/settings"]);
  });
});
