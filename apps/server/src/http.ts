/** Tiny fetch wrapper so tests can swap the network out. */
export type FetchLike = typeof fetch;

let impl: FetchLike = (...args) => fetch(...args);

export function setFetchForTests(f: FetchLike | null): void {
  impl = f ?? ((...args) => fetch(...args));
}

const UA = "TVsham/0.1 (https://github.com/Platteration/tvsham)";

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
