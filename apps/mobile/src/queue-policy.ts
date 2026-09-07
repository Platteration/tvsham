/**
 * Whether a queued clip is worth keeping after the server rejected it.
 *
 * The distinction that matters: a clip the server can never accept (too big,
 * not a video it can read) is dead weight, but a rejection about the *caller*
 * — the daily cap, a token that is not set up yet, a server fault — says
 * nothing about the clip, and throwing it away would destroy a recording the
 * user cannot make again.
 */
const HOPELESS_STATUSES = new Set([400, 413, 415, 422]);

export function isHopeless(status: number | undefined): boolean {
  return status !== undefined && HOPELESS_STATUSES.has(status);
}
