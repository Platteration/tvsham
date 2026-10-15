/**
 * Sign in with Google and the accent packs, on the website: what the page reads from the site's
 * own api/ (the shared kit, which the recognition server carries and the site's reverse proxy puts
 * on the site's origin), checked before anything is drawn from it, and the words the page says.
 * Pure: no React Native, no network and no address, so a plain test loads it.
 *
 * The network lives in `account-client.web.ts`, which Metro bundles into the web build alone. Its
 * native twin, `account-client.ts`, answers "not configured" and opens nothing: the phone apps
 * keep every accent they have and sell nothing (the App Store and Google Play would require their
 * own in-app purchase for it). `account.ts` builds the screens' state from whichever of the two
 * the platform resolves.
 *
 * Everything the server says is untrusted here, the way a stored record is (settings.ts): it is
 * read field by field, and what does not hold up is left out rather than drawn. It is drawn as
 * text, never as markup. And what it unlocks is a cosmetic: a visitor who edits the page can draw
 * any accent without paying, which the README says plainly; the server's record of a purchase is
 * what a sale is.
 */
import { SOLD_ACCENTS, accentProduct, type SoldAccent } from "@tvsham/shared";
import type { AccentName } from "./palette";

/** A price as Stripe states it: in the currency's smallest unit. */
export interface Price {
  unitAmount: number;
  /** ISO 4217, lowercase, as Stripe writes it. */
  currency: string;
}

/** An accent pack the shop sells. */
export interface AccentProduct {
  /** The catalogue's product id, which is also the entitlement a paid one grants. */
  id: string;
  accent: SoldAccent;
  name: string;
  description: string;
  /** Null when the server could not read it from Stripe: the product is still sold. */
  price: Price | null;
}

/** What `GET api/config` says is on. Null, everywhere it is read, means the feature does not exist. */
export interface ApiConfig {
  /** Sign in with Google; true whenever this exists, since the kit sells nothing without it. */
  signIn: true;
  /** The accent packs on sale, in the app's own order; empty when the shop is off. */
  products: AccentProduct[];
}

export interface Account {
  /** Null when Google did not say the address is verified. */
  email: string | null;
}

/** What `GET api/me` says: who is signed in, and what they own. */
export interface Me {
  user: Account | null;
  entitlements: readonly string[];
}

export const SIGNED_OUT: Me = { user: null, entitlements: [] };

/** An id as the kit writes one: a product, an entitlement. */
const ID = /^[a-z][a-z0-9-]{0,31}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Text of at most `max` characters with no control character: what a label may hold. */
function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function readPrice(raw: unknown): Price | null {
  if (!isRecord(raw)) return null;
  const amount = raw.unit_amount;
  const currency = raw.currency;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return null;
  if (typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) return null;
  return { unitAmount: amount, currency };
}

/**
 * `GET api/config`'s body, or null when the feature does not exist: anything that is not the
 * kit's shape, and a body that turns sign-in off (the kit sells nothing without it, and a Buy that
 * can never sign in is a button that does nothing). An accent pack is read from the product list
 * when it is there as this app sells it (its id, once, `payment`), the first such listing of it
 * wins, and the packs come out in the app's own order; any other product is not this build's to
 * draw.
 */
export function readApiConfig(raw: unknown): ApiConfig | null {
  if (!isRecord(raw) || !isRecord(raw.auth) || raw.auth.google !== true) return null;
  const listed = isRecord(raw.shop) && Array.isArray(raw.shop.products) ? raw.shop.products : [];
  const products = SOLD_ACCENTS.flatMap((accent): AccentProduct[] => {
    for (const item of listed) {
      if (!isRecord(item) || item.id !== accentProduct(accent) || item.mode !== "payment") continue;
      const name = text(item.name, 100);
      const description = text(item.description, 500);
      if (!name || description === null) continue;
      return [{ id: accentProduct(accent), accent, name, description, price: readPrice(item.price) }];
    }
    return [];
  });
  return { signIn: true, products };
}

/** `GET api/me`'s body, or null when it is not the kit's shape. */
export function readMe(raw: unknown): Me | null {
  if (!isRecord(raw) || !Array.isArray(raw.entitlements)) return null;
  let user: Account | null = null;
  if (raw.user !== null) {
    if (!isRecord(raw.user)) return null;
    user = { email: text(raw.user.email, 320) || null };
  }
  const entitlements = [...new Set(raw.entitlements.filter((e): e is string => typeof e === "string" && ID.test(e)))].slice(0, 50);
  return { user, entitlements };
}

/** Stripe's zero-decimal currencies: an amount of 499 JPY is ¥499. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
/** Stripe's three-decimal currencies: an amount of 1500 KWD is 1.500 KWD. */
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/**
 * A price for people to read, in the visitor's locale (`undefined`, the browser's own). Null when
 * the platform cannot format the currency, in which case the product is shown without one.
 */
export function formatPrice(price: Price, locale?: string): string | null {
  const divisor = ZERO_DECIMAL.has(price.currency) ? 1 : THREE_DECIMAL.has(price.currency) ? 1000 : 100;
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: price.currency.toUpperCase() }).format(price.unitAmount / divisor);
  } catch {
    return null;
  }
}

/**
 * Which accents may be drawn and chosen, and why.
 * - `stored`: no shop (a phone, a site with no api/, a shop that sells no accent): the settings
 *   record's own list, as it always was.
 * - `shop`: the shop sells `sold`, and the server says the visitor owns `owned` of them. An accent
 *   on sale is drawn only when owned; one not on sale stays as the record has it. The record's
 *   list is not read for an accent on sale: a copy in the browser never unlocks one.
 * - `asking`: the website has asked api/ and not heard back. Midnight alone, as before the
 *   settings are read, so a sold accent is never drawn ahead of the server's word.
 */
export type AccentAccess =
  | { kind: "stored" }
  | { kind: "asking" }
  | { kind: "shop"; sold: ReadonlySet<AccentName>; owned: ReadonlySet<AccentName> };

/** The accents a `GET api/me` answer owns, among those the app sells. */
export function ownedAccents(me: Me): Set<AccentName> {
  return new Set(SOLD_ACCENTS.filter((accent) => me.entitlements.includes(accentProduct(accent))));
}

/** Whether `accent` may be drawn and chosen, under `access`, with the settings record's own list. */
export function canUseAccent(access: AccentAccess, unlocked: readonly AccentName[], accent: AccentName): boolean {
  if (access.kind === "asking") return accent === "midnight";
  if (access.kind === "shop" && access.sold.has(accent)) return access.owned.has(accent);
  return unlocked.includes(accent);
}

/**
 * The accent the app draws with. Midnight, which ships with the app, while the website is asking
 * api/ and in place of an accent the shop sells that the visitor does not own; otherwise the
 * chosen one, as it always was (the palette never read the record's list: only the swatches do).
 */
export function drawnAccent(access: AccentAccess, chosen: AccentName): AccentName {
  if (access.kind === "asking") return "midnight";
  if (access.kind === "shop" && access.sold.has(chosen)) return access.owned.has(chosen) ? chosen : "midnight";
  return chosen;
}

/** What the address said on arrival: the kit's `?signin=failed`, and Checkout's return. */
export interface Landing {
  signIn: "failed" | null;
  purchase: "success" | "cancelled" | null;
}

export const NO_LANDING: Landing = { signIn: null, purchase: null };

/**
 * What an address says on arrival, and the same address without it (null when there was nothing
 * of ours to take out). Only the values the kit writes are read and removed; a `?purchase=` of any
 * other value is not ours and stays.
 */
export function landingOf(href: string): { landing: Landing; without: string | null } {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { landing: NO_LANDING, without: null };
  }
  const signin = url.searchParams.get("signin");
  const purchase = url.searchParams.get("purchase");
  const landing: Landing = {
    signIn: signin === "failed" ? "failed" : null,
    purchase: purchase === "success" || purchase === "cancelled" ? purchase : null,
  };
  if (landing.signIn) url.searchParams.delete("signin");
  if (landing.purchase) url.searchParams.delete("purchase");
  if (!landing.signIn && !landing.purchase) return { landing, without: null };
  return { landing, without: `${url.pathname}${url.search}${url.hash}` };
}

/** How often, and how many times, `api/me` is asked after Checkout sends the visitor back: five times over fifteen seconds. */
export const POLL = { tries: 5, everyMs: 3000 } as const;

/**
 * Asks `readMe` up to POLL.tries times, POLL.everyMs apart, until an answer satisfies `found`: a
 * purchase is granted by Stripe's webhook, which may land after the visitor is back. `seen` hears
 * every answer that could be read. Returns the last answer and whether it was found.
 */
export async function pollFor(
  found: (me: Me) => boolean,
  readMe: () => Promise<Me | null>,
  wait: (ms: number) => Promise<void>,
  seen: (me: Me) => void = () => {},
): Promise<{ held: boolean; me: Me | null }> {
  let me: Me | null = null;
  for (let i = 0; i < POLL.tries; i += 1) {
    await wait(POLL.everyMs);
    me = await readMe();
    if (!me) continue;
    seen(me);
    if (found(me)) return { held: true, me };
  }
  return { held: false, me };
}

/** How `POST api/checkout` ended, as the page reads it. */
export type CheckoutResult = "redirecting" | "signin" | "owned" | "unavailable" | "busy" | "failed";

/**
 * The website's account and shop, as a platform provides them. The web build's talks to the
 * site's api/; the native twin answers "not configured" to everything and opens nothing.
 */
export interface AccountClient {
  /** Whether this build can ask for api/ at all: false in the native twin. */
  readonly web: boolean;
  /** `GET api/config`; null for a 404, a network error, a body that is not JSON or nothing on. */
  config(): Promise<ApiConfig | null>;
  /** `GET api/me`; null when it cannot be read. */
  me(): Promise<Me | null>;
  /** A top-level navigation to `api/auth/google/start`, returning to this page. */
  signIn(): void;
  /** `POST api/auth/logout`: whether the server ended the session. */
  signOut(): Promise<boolean>;
  /** `DELETE api/me`: whether the server deleted the account. */
  deleteAccount(): Promise<boolean>;
  /** `POST api/checkout`, and on success a navigation to Stripe's Checkout. */
  checkout(product: string): Promise<CheckoutResult>;
  /** What the address said on arrival, read once and taken out of it. */
  takeLanding(): Landing;
  /** The product the last Checkout was for, read once (the thank-you names it), or null. */
  takePending(): string | null;
}

/** The words the account and the shop say, the same in every app that carries the kit. */
export const WORDS = {
  section: "Account",
  signIn: "Sign in with Google",
  signedInAs: (email: string) => `Signed in as ${email}`,
  signedIn: "Signed in with Google",
  signOut: "Sign out",
  deleteAccount: "Delete account",
  signInFailed: "Sign-in didn't complete.",
  buy: "Buy",
  signInToBuy: "Sign in to buy",
  owned: "Owned",
  thanks: (name: string) => `Thank you — ${name} is unlocked.`,
  paymentPending: "Payment received. It can take a minute to appear — reload to check.",
  dismiss: "Dismiss",
} as const;

/** What this app's shop and account say around those words. */
export const ACCOUNT_NOTES = {
  shopTitle: "Accent packs",
  shopIntro: "Midnight comes with TVsham. The others are a one-off purchase each, kept with your Google account on this site.",
  deleteTitle: "Delete account?",
  deleteBody:
    "This deletes your account on this site, and the accent packs you bought with it: they stop being unlocked here. The payment itself stays with Stripe. This cannot be undone.",
  deleteConfirm: "Delete account",
  deleteCancel: "Keep my account",
  deleteFailed: "The account could not be deleted. Try again.",
  signOutFailed: "Could not sign out. Try again.",
  unavailable: "That accent pack is not on sale right now.",
  busy: "Too many tries for now. Try again in a while.",
  failed: "The shop could not be reached. Try again.",
} as const;

/**
 * What the "How it works" card adds on a website whose api/ offers sign-in, after the sentence
 * every build says about what goes to the recognition server. Elsewhere (the phone apps, a site
 * with no api/) nothing is added, because nothing else is sent.
 */
export const PRIVACY_WITH_ACCOUNT =
  "If you sign in or buy an accent pack, Google tells this site an account id and your email address, and Stripe handles the payment on its own page. The site keeps the account id, what was bought and Stripe's customer id, and your email address only while you are signed in.";
