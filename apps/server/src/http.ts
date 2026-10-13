/** Tiny fetch wrapper so tests can swap the network out. */
export type FetchLike = typeof fetch;

let impl: FetchLike = (...args) => fetch(...args);

export function setFetchForTests(f: FetchLike | null): void {
  impl = f ?? ((...args) => fetch(...args));
}

const UA = "TVsham/0.1 (https://github.com/Platteration/tvsham)";

/**
 * The way out for the account and the shop (kit/, through account.ts): every call the kit makes
 * to Google and Stripe goes through the same injectable implementation as the rest, so no test
 * reaches either. Handed on as it is: the kit sets its own headers, deadline and redirect mode.
 */
export function outbound(input: string, init?: RequestInit): Promise<Response> {
  return impl(input, init);
}

/**
 * POST a multipart body and hand back the raw response, through the same
 * injectable implementation as getJson so tests never reach the network.
 *
 * Every outbound call needs a deadline, not only the ones that read JSON: this
 * one is awaited inside `limiter.run`, so an endpoint that accepts the
 * connection and then says nothing would hold one of the few analysis slots for
 * as long as it liked, and enough of them wedge the server with nothing to
 * break the deadlock.
 */
export async function postForm(
  url: string,
  body: FormData,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  return impl(url, {
    method: "POST",
    headers: { "User-Agent": UA, ...opts.headers },
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
}

export async function getJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await impl(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
