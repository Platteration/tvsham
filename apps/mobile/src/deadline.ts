/**
 * Deadlines for network calls.
 *
 * The server is usually an address the user typed on their own network, so the
 * common failure is not a refusal but a silence: a mistyped LAN IP, or a phone
 * that has left the house while the address is still configured. Without a
 * deadline the request sits there until the platform's own TCP timeout — around
 * a minute on iOS, sometimes much longer — and the app shows "Identifying…" the
 * whole time, with the clip neither sent nor queued, because the offline queue
 * is only reached once the request actually rejects.
 *
 * Free of React and of fetch so it can be tested directly.
 */

/** A call that ran out of time, as distinct from one the user cancelled. */
export class TimeoutError extends Error {
  constructor(readonly ms: number, what: string) {
    super(`${what} took longer than ${Math.round(ms / 1000)}s. Check the server address in Settings.`);
    this.name = "TimeoutError";
  }
}

/**
 * Run `call` with a signal that aborts when `outer` does or after `ms`,
 * whichever comes first, and always clean up after it.
 *
 * `AbortSignal.any` would say this in one line but is not available on every
 * runtime the app ships to, and an abort of our own would otherwise surface as
 * a bare AbortError that reads like the user cancelled — so a deadline that
 * expires is reported as what it is.
 */
export async function withDeadline<T>(
  ms: number,
  what: string,
  outer: AbortSignal | undefined,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let expired = false;
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", onOuterAbort);
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);
  try {
    return await call(controller.signal);
  } catch (err) {
    // The user cancelling wins: they know why the call stopped.
    if (expired && !outer?.aborted) throw new TimeoutError(ms, what);
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
