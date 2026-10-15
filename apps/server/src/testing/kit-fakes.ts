/**
 * Test tooling only, never part of the server (tsconfig.json leaves src/testing/ out of the
 * build, and account.test.ts holds that nothing else imports it): a fake Google and a fake
 * Stripe behind one `fetch`, which the tests hand to the kit through `createApp({ fetch })`, by
 * way of createAccount's `fetch`. Nothing points the kit at another host: it calls the real
 * addresses, and this function answers them. Shared by account.test.ts and the website's browser
 * suite (apps/mobile/e2e/web.mjs).
 *
 * Google: an RSA key made with Web Crypto, its JWKS, an authorization step (`consent`) that turns
 * the authorize URL the kit redirected to into the callback URL Google would send the browser to,
 * and a token endpoint that checks the code, the client and the PKCE verifier before it signs an
 * ID token for the nonce. Stripe: a Price per accent, Checkout Sessions recorded as the kit
 * created them, and webhook events signed as Stripe signs them, with node:crypto rather than the
 * kit's own code.
 */
import { createHash, createHmac, webcrypto } from "node:crypto";
import { SOLD_ACCENTS, accentProduct } from "@tvsham/shared";

export const CLIENT_ID = "fake-client.apps.googleusercontent.com";
export const CLIENT_SECRET = "fake-google-client-secret";
export const STRIPE_KEY = "sk_test_fakeStripeKey000000000000";
export const WEBHOOK_SECRET = "whsec_fakeWebhookSecret0000000000";
/** 32 bytes of base64url. */
export const SESSION_SECRET = "c2Vzc2lvbi1zZWNyZXQtZm9yLXRoZS10ZXN0cy0wMDA";
/** What each accent costs at the fake Stripe: EUR 1.99, in cents as Stripe counts them. */
export const PRICE_CENTS = 199;

/** The fake Price id of a sold accent's product. */
export const priceOf = (product: string): string => `price_fake_${product.replace(/-/g, "_")}`;

/**
 * The variables a deployment sets, for a website whose public address is `appUrl`. KIT_DATA_DIR
 * is the caller's: a test hands its store in directly, the browser suite a directory of its own.
 */
export function envFor(appUrl: string): Record<string, string> {
  const prices = Object.fromEntries(
    SOLD_ACCENTS.map((accent) => [`STRIPE_PRICE_${accentProduct(accent).toUpperCase().replace(/-/g, "_")}`, priceOf(accentProduct(accent))]),
  );
  return {
    APP_URL: appUrl,
    SESSION_SECRET,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    STRIPE_SECRET_KEY: STRIPE_KEY,
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...prices,
  };
}

export interface Person {
  sub: string;
  email: string;
}

const b64 = (data: string | ArrayBuffer): string =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)).toString("base64url");

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });

export interface Fakes {
  /** What the kit is given. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Every call the kit made, as `METHOD url`. */
  calls: string[];
  /** Calls the fakes do not serve: a test fails on any. */
  unexpected: string[];
  /** The Checkout Sessions the kit created, by id, as the form it posted. */
  sessions: Map<string, URLSearchParams>;
  /** Google's half of a sign-in: the callback URL for an authorize URL the kit redirected to. */
  consent(authorizeUrl: string, person?: Person): URL;
  /** The `checkout.session.completed` event for the session a Checkout URL names, paid. */
  paid(checkoutUrl: string): Record<string, unknown>;
}

export async function createFakes(): Promise<Fakes> {
  const keys = (await webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as webcrypto.CryptoKeyPair;
  const jwk = { ...(await webcrypto.subtle.exportKey("jwk", keys.publicKey)), kid: "fake-key", alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; redirectUri: string; nonce: string; person: Person }>();
  const sessions = new Map<string, URLSearchParams>();
  const unexpected: string[] = [];
  const calls: string[] = [];
  let seq = 0;

  const signIdToken = async (claims: Record<string, unknown>): Promise<string> => {
    const head = b64(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" }));
    const body = b64(JSON.stringify(claims));
    const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64(signature)}`;
  };

  const token = async (body: string): Promise<Response> => {
    const form = new URLSearchParams(body);
    const code = form.get("code") ?? "";
    const grant = codes.get(code);
    codes.delete(code);
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (
      !grant ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("client_id") !== CLIENT_ID ||
      form.get("client_secret") !== CLIENT_SECRET ||
      form.get("redirect_uri") !== grant.redirectUri ||
      challenge !== grant.challenge
    ) {
      return json({ error: "invalid_grant" }, { status: 400 });
    }
    const at = Math.floor(Date.now() / 1000);
    const idToken = await signIdToken({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      sub: grant.person.sub,
      email: grant.person.email,
      email_verified: true,
      iat: at,
      exp: at + 3600,
      nonce: grant.nonce,
    });
    return json({ id_token: idToken, access_token: "unused", token_type: "Bearer", expires_in: 3599 });
  };

  const prices = new Map(SOLD_ACCENTS.map((accent) => [priceOf(accentProduct(accent)), accentProduct(accent)]));
  const stripe = (path: string, method: string, headers: Headers, body: string): Response => {
    if (headers.get("authorization") !== `Bearer ${STRIPE_KEY}`) return json({ error: { message: "bad key" } }, { status: 401 });
    const price = method === "GET" && path.startsWith("/prices/") ? path.slice("/prices/".length) : null;
    if (price !== null && prices.has(price)) {
      return json({ id: price, object: "price", active: true, currency: "eur", unit_amount: PRICE_CENTS, recurring: null, type: "one_time" });
    }
    if (method === "POST" && path === "/checkout/sessions") {
      seq += 1;
      const id = `cs_test_fake${seq}`;
      sessions.set(id, new URLSearchParams(body));
      return json({ id, object: "checkout.session", url: `https://checkout.stripe.com/c/pay/${id}` });
    }
    unexpected.push(`${method} stripe ${path}`);
    return json({ error: { message: "unknown endpoint" } }, { status: 404 });
  };

  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    calls.push(`${method} ${url}`);
    if (url === "https://www.googleapis.com/oauth2/v3/certs" && method === "GET") {
      return json({ keys: [jwk] }, { headers: { "cache-control": "public, max-age=3600" } });
    }
    if (url === "https://oauth2.googleapis.com/token" && method === "POST") return token(body);
    if (url.startsWith("https://api.stripe.com/v1/")) return stripe(url.slice("https://api.stripe.com/v1".length), method, headers, body);
    unexpected.push(`${method} ${url}`);
    throw new TypeError(`fetch to an address the fakes do not serve: ${url}`);
  };

  return {
    fetch,
    calls,
    unexpected,
    sessions,
    consent(authorizeUrl, person = { sub: "1001", email: "ada@example.com" }) {
      const url = new URL(authorizeUrl);
      const params = url.searchParams;
      if (`${url.origin}${url.pathname}` !== "https://accounts.google.com/o/oauth2/v2/auth") throw new Error(`not Google's authorize URL: ${authorizeUrl}`);
      if (params.get("client_id") !== CLIENT_ID || params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256") {
        throw new Error(`an authorize URL Google would refuse: ${authorizeUrl}`);
      }
      seq += 1;
      const code = `code${seq}`;
      codes.set(code, {
        challenge: params.get("code_challenge") ?? "",
        redirectUri: params.get("redirect_uri") ?? "",
        nonce: params.get("nonce") ?? "",
        person,
      });
      const back = new URL(params.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", params.get("state") ?? "");
      return back;
    },
    paid(checkoutUrl) {
      const id = new URL(checkoutUrl).pathname.split("/").pop() ?? "";
      const asked = sessions.get(id);
      if (!asked) throw new Error(`no Checkout Session ${id}`);
      return {
        id: `evt_fake${id.replace(/[^0-9A-Za-z]/g, "")}`,
        object: "event",
        type: "checkout.session.completed",
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id,
            object: "checkout.session",
            mode: asked.get("mode"),
            payment_status: "paid",
            client_reference_id: asked.get("client_reference_id"),
            metadata: { app: asked.get("metadata[app]"), user: asked.get("metadata[user]"), product: asked.get("metadata[product]") },
            payment_intent: `pi_fake${id.replace(/[^0-9A-Za-z]/g, "")}`,
            customer: "cus_fake1",
          },
        },
      };
    },
  };
}

/**
 * A webhook delivery as Stripe signs it: the body, and its Stripe-Signature header, an HMAC made
 * here with node:crypto rather than with the kit's own code.
 */
export function signedDelivery(
  event: Record<string, unknown>,
  { secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000) }: { secret?: string; at?: number } = {},
): { body: string; signature: string } {
  const body = JSON.stringify(event);
  const v1 = createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return { body, signature: `t=${at},v1=${v1}` };
}
