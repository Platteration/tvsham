/**
 * The website's account and shop: the one module of the app that talks to the site's own api/,
 * which the recognition server answers through the site's reverse proxy (deploy/nginx.conf,
 * `location ^~ /api/`), so the sign-in is a cookie of the site's origin. Metro bundles it into the
 * web build alone; the phone apps get account-client.ts, which opens nothing. The site's policy
 * allows exactly this beside the recognition server (`connect-src 'self'`): Google and Stripe are
 * reached by top-level navigations, never by a request from the page.
 *
 * Where nothing answers api/ (Netlify, Cloudflare Pages, Apache or nginx with no proxy to the
 * server) `api/config` is a 404, and the page asks for nothing more: no sign-in and no shop are
 * drawn, nothing is stored, and nothing is asked again.
 */
import { KEYS } from "./settings";
import { landingOf, readApiConfig, readMe, type AccountClient, type ApiConfig, type CheckoutResult, type Landing, type Me } from "./account-model";

/** The one address the page leaves for to pay: Stripe's hosted Checkout. */
export const CHECKOUT_ORIGIN = "https://checkout.stripe.com";

/** How long the page waits for api/ before it treats the site as one without it. */
export const API_WAIT_MS = 5000;

/**
 * Whether `value` is an address on Stripe's Checkout, the only place Buy may send the page. The
 * slash after the host is what decides it: whatever follows it is a path on that host, while
 * without it `https://checkout.stripe.com.evil.example/` and `https://checkout.stripe.com@evil.example/`
 * would name another one.
 */
export function isCheckoutUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${CHECKOUT_ORIGIN}/`);
}

/**
 * An address under the site's api/, from the site's own root: the page's origin and the path the
 * site is served under (WEB_BASE_URL, which the export writes into the bundle as EXPO_BASE_URL),
 * never the page's own path, which is a route of the app (/tvsham/settings, or /tvsham with no
 * slash for the first screen).
 */
export function apiUrl(route: string, base: string = process.env.EXPO_BASE_URL ?? "", origin: string = window.location.origin): string {
  return `${origin}${base.replace(/\/+$/, "")}/api/${route}`;
}

/** The body of a successful answer as JSON, or undefined for anything else. */
async function json(response: Response): Promise<unknown> {
  if (!response.ok) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function get(route: string, init: RequestInit = {}): Promise<unknown> {
  try {
    const response = await fetch(apiUrl(route), {
      ...init,
      headers: { accept: "application/json" },
      credentials: "same-origin",
      signal: AbortSignal.timeout(API_WAIT_MS),
    });
    return await json(response);
  } catch {
    return undefined;
  }
}

/** A request that changes something: same-origin, so the browser sends the Origin the kit checks. */
async function send(method: "POST" | "DELETE", route: string, body?: unknown): Promise<Response | null> {
  try {
    return await fetch(apiUrl(route), {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(API_WAIT_MS * 2),
    });
  } catch {
    return null;
  }
}

/** sessionStorage, which a browser keeping no site data refuses outright: then there is no thank-you name, and nothing else is lost. */
function remember(value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(KEYS.checkout);
    else window.sessionStorage.setItem(KEYS.checkout, value);
  } catch {
    // Not kept: the thank-you will not name the pack.
  }
}

export const accountClient: AccountClient = {
  web: true,

  async config(): Promise<ApiConfig | null> {
    return readApiConfig(await get("config"));
  },

  async me(): Promise<Me | null> {
    return readMe(await get("me", { cache: "no-store" }));
  },

  signIn(): void {
    const here = `${window.location.pathname}${window.location.search}`;
    window.location.assign(apiUrl(`auth/google/start?return=${encodeURIComponent(here)}`));
  },

  async signOut(): Promise<boolean> {
    return (await send("POST", "auth/logout"))?.status === 204;
  },

  async deleteAccount(): Promise<boolean> {
    return (await send("DELETE", "me"))?.status === 204;
  },

  async checkout(product: string): Promise<CheckoutResult> {
    const response = await send("POST", "checkout", { product });
    if (!response) return "failed";
    if (response.status === 401) return "signin";
    if (response.status === 409) return "owned";
    if (response.status === 404) return "unavailable";
    if (response.status === 429) return "busy";
    const body = await json(response);
    const url = typeof body === "object" && body !== null && "url" in body ? body.url : undefined;
    if (!isCheckoutUrl(url)) return "failed";
    remember(product);
    window.location.assign(url);
    return "redirecting";
  },

  takeLanding(): Landing {
    const { landing, without } = landingOf(window.location.href);
    if (without !== null && typeof window.history?.replaceState === "function") window.history.replaceState(window.history.state, "", without);
    return landing;
  },

  takePending(): string | null {
    let pending: string | null = null;
    try {
      pending = window.sessionStorage.getItem(KEYS.checkout);
    } catch {
      return null;
    }
    remember(null);
    return pending;
  },
};
