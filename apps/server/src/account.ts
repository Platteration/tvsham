import path from "node:path";
import { createApp, readConfig, validateCatalogue, type Log } from "../kit/app.js";
import { createFileStore } from "../kit/node.js";
import type { Store } from "../kit/store.js";
import { catalogue } from "./catalogue.js";
import { outbound } from "./http.js";

/**
 * The website's account and shop: sign in with Google, the accent packs through Stripe Checkout,
 * and Stripe's signed webhook, which is the only thing that grants one. It is the shared kit
 * (kit/, copied byte for byte from the canonical copy and never edited here) mounted inside this
 * server, below `APP_URL` + `api/`: index.ts hands it every request under that path, ahead of the
 * bearer-token gate and behind the Origin gate.
 *
 * Off until the operator sets its variables (kit/README.md, "Configuration"): with none of them,
 * `GET /api/config` says nothing is on and every other path below `/api/` is a JSON 404, which is
 * all the website then asks. The phone apps never call it.
 *
 * The session is a first-party cookie of the website's own origin, so the browser must reach this
 * path on the site's origin: the site's reverse proxy sends `/api/` here (deploy/nginx.conf,
 * `location ^~ /api/`), and the site calls the recognition routes at TVSHAM_SERVER_URL as before.
 */

/** The variables that ask for sign-in, as the kit reads them. */
const SIGN_IN_VARIABLES = ["APP_URL", "SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

export interface Account {
  /** The path the kit answers below: APP_URL's path and `api/`, or `/api/` while APP_URL is unset. */
  prefix: string;
  /** APP_URL's origin, which is the website's: the only Origin the kit's writes accept. */
  origin: string | null;
  features: { signIn: boolean; shop: boolean };
  /** Whether a request for `path` is the kit's to answer, whatever it then answers. */
  owns(path: string): boolean;
  /** The kit's answer. Never throws. */
  handle(request: Request): Promise<Response>;
  /** Removes the file store's expired records; 0 when there is no file store. */
  sweep(): Promise<number>;
}

export interface AccountOptions {
  /** The variables: process.env in the server, a literal in the tests. */
  env: Record<string, string | undefined>;
  /** How the kit reaches Google and Stripe; http.ts's `outbound` unless a test hands it fakes. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Where the kit keeps its records; by default a directory of files at KIT_DATA_DIR, or none. */
  store?: Store | null;
  now?: () => number;
  log?: Log;
}

const consoleLog: Log = (level, message) => (level === "error" ? console.error(`[account] ${message}`) : console.warn(`[account] ${message}`));

/**
 * The kit for this server's catalogue and environment. The store is a directory of files
 * (kit/node.js, createFileStore) at KIT_DATA_DIR: one process per directory, outside anything a
 * web server publishes. With no store the kit turns sign-in and the shop off, and says so.
 */
export function createAccount(options: AccountOptions): Account {
  const { env } = options;
  const log = options.log ?? consoleLog;
  const now = options.now ?? (() => Date.now());
  const dataDir = env.KIT_DATA_DIR?.trim() || undefined;
  const files = options.store === undefined && dataDir ? createFileStore(path.resolve(dataDir), { now }) : null;
  const store = options.store === undefined ? files : options.store;
  if (store === null && SIGN_IN_VARIABLES.some((name) => env[name])) {
    log("warn", "sign-in is configured but KIT_DATA_DIR is not: name a directory outside the web root that this server alone writes, or sign-in and the shop stay off");
  }
  const kit = createApp({ catalogue, env, store, fetch: options.fetch ?? outbound, now, log });
  const appUrl = readConfig(env, validateCatalogue(catalogue), { store: store !== null }).appUrl;
  const prefix = appUrl ? `${appUrl.pathname}api/` : "/api/";
  return {
    prefix,
    origin: appUrl?.origin ?? null,
    features: kit.features,
    owns: (requestPath) => requestPath.startsWith(prefix),
    handle: (request) => kit.handle(request),
    sweep: () => (files ? files.sweep() : Promise.resolve(0)),
  };
}

/**
 * What is wrong with the account's setting beside CORS_ORIGIN, in words, or null.
 *
 * The page signs out, buys and deletes its account with requests that carry the site's Origin,
 * which is APP_URL's, and this server refuses every Origin but CORS_ORIGIN before the kit sees
 * one (index.ts). So with sign-in on, the two must name the same origin, or every one of those
 * requests is a 403: the server says so and stops rather than run a sign-in that can never sign
 * out. The README's website set-up already names the site's origin in CORS_ORIGIN.
 */
export function accountProblem(account: Pick<Account, "features" | "origin">, corsOrigin: string | undefined): string | null {
  if (!account.features.signIn || account.origin === null || corsOrigin === account.origin) return null;
  return (
    `APP_URL's origin is ${account.origin} but CORS_ORIGIN is ${corsOrigin ? corsOrigin : "unset"}: the website's sign-in and shop ` +
    `send the site's Origin, which this server refuses unless CORS_ORIGIN names it. Set CORS_ORIGIN=${account.origin}.`
  );
}
