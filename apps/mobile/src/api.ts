import type {
  CaptureSource,
  HealthResponse,
  RecognitionResult,
  SessionHandle,
} from "@tvsham/shared";
import { getLocales } from "expo-localization";
import { TimeoutError, withDeadline } from "./deadline";
import { canSendTokenTo } from "./settings";
import { cleanRecognitionResult, cleanSessionHandle } from "./shapes";
import { getDeviceId, getSettings } from "./store";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function baseUrl(): string {
  const url = getSettings().serverUrl.trim().replace(/\/+$/, "");
  if (!url) throw new ApiError("No server configured. Open Settings and enter your TVsham server URL.");
  return url;
}

function headers(base: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const token = getSettings().token.trim();
  if (token) {
    // A bearer token on a cleartext hop to a public host is readable by
    // everyone on the path, and it spends the operator's money. Say why rather
    // than sending it and letting the server answer an unexplained 401.
    if (!canSendTokenTo(base)) {
      throw new ApiError(
        "Refusing to send your access token over plain HTTP to an address outside your network. Use an https:// server URL.",
      );
    }
    h.Authorization = `Bearer ${token}`;
  }
  const device = getDeviceId();
  if (device) h["X-Device-Id"] = device;
  return h;
}

function errorText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const o = body as { error?: unknown; message?: unknown };
  if (typeof o.error === "string") return o.error;
  if (typeof o.message === "string") return o.message;
  return null;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    throw new ApiError(errorText(body) ?? `Server error ${res.status}`, res.status);
  }
  return body as T;
}

export async function health(timeoutMs = 6000): Promise<HealthResponse> {
  const base = baseUrl();
  const res = await fetch(`${base}/health`, {
    headers: headers(base),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parse<HealthResponse>(res);
}

/** The device's country, so "where to watch" lists services the user can actually use. */
function region(): string | undefined {
  try {
    return getLocales()[0]?.regionCode ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * How long each call may take. A server that is there answers the small JSON
 * ones at once; an upload carries the clip and then waits for the analysis
 * behind it, which is queued behind every other clip the server is working on.
 */
const TIMEOUTS = { control: 15_000, upload: 180_000 };

export async function createSession(source: CaptureSource, hints?: string): Promise<SessionHandle> {
  const base = baseUrl();
  const res = await withDeadline(TIMEOUTS.control, "Reaching the server", undefined, (signal) =>
    fetch(`${base}/sessions`, {
      method: "POST",
      headers: headers(base, { "Content-Type": "application/json" }),
      body: JSON.stringify({ source, ...(hints ? { hints } : {}), ...(region() ? { region: region() } : {}) }),
      signal,
    }),
  );
  // Coerced like everything else off the wire: without a usable key every later
  // call to this session is a 404, and saying so here beats four of them.
  const handle = cleanSessionHandle(await parse<unknown>(res));
  if (!handle) throw new ApiError("The server did not return a usable session.");
  return handle;
}

/**
 * Headers for a call about a session that already exists. The key is what
 * authorises it; unlike the access token it is not withheld over plain HTTP,
 * because it grants only this one session — anyone close enough to read the
 * header is already reading the clip it belongs to.
 */
function sessionHeaders(
  base: string,
  session: SessionHandle,
  extra: Record<string, string> = {},
): Record<string, string> {
  return headers(base, { "X-Session-Key": session.sessionKey, ...extra });
}

/**
 * Upload one recorded clip. React Native's fetch accepts `{ uri, name, type }`
 * objects in FormData and streams the file from disk.
 */
export async function uploadClip(
  session: SessionHandle,
  fileUri: string,
  opts: { mimeType?: string; signal?: AbortSignal; clipKey?: string } = {},
): Promise<RecognitionResult> {
  const name = fileUri.split("/").pop() || "clip.mp4";
  const type = opts.mimeType ?? (name.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4");
  // Sent as a header as well as a field so the server can recognise a retry of a
  // clip it already analysed before it buffers the body again.
  const clipKey = (opts.clipKey ?? fileUri).replace(/[^A-Za-z0-9:_-]/g, "").slice(-128) || "clip";
  const base = baseUrl();
  const send = async () => {
    const form = new FormData();
    // @ts-expect-error React Native FormData accepts file descriptors, the DOM types do not.
    form.append("clip", { uri: fileUri, name, type });
    form.append("clipKey", clipKey);
    const res = await withDeadline(TIMEOUTS.upload, "Sending the clip", opts.signal, (signal) =>
      fetch(`${base}/sessions/${session.sessionId}/clips`, {
        method: "POST",
        headers: sessionHeaders(base, session, { "X-Clip-Key": clipKey }),
        body: form,
        signal,
      }),
    );
    // 202 means this clip was already accepted and is still being analysed —
    // the body is the session mid-flight, not an answer.
    const stillAnalysing = res.status === 202;
    // Coerced rather than cast: this is a cleartext hop by default, and what
    // comes back is rendered and then written to the device library.
    return { result: cleanRecognitionResult(await parse<unknown>(res), session.sessionId), stillAnalysing };
  };

  let sent: { result: RecognitionResult; stillAnalysing: boolean };
  try {
    sent = await send();
  } catch (err) {
    // One retry for transient network drops; server-side errors are not
    // retried, and neither is a deadline: waiting the same three minutes again
    // is not a transient drop, it is the same silence twice.
    if (err instanceof ApiError || err instanceof TimeoutError || opts.signal?.aborted) throw err;
    await new Promise((r) => setTimeout(r, 800));
    sent = await send();
  }
  // Outside the retry above on purpose: a failed poll must not re-upload the clip.
  return sent.stillAnalysing ? pollUntilSettled(session, opts.signal) : sent.result;
}

/** The session's current state, used to follow up a clip the server is still analysing. */
export async function fetchSession(session: SessionHandle, signal?: AbortSignal): Promise<RecognitionResult> {
  const base = baseUrl();
  const res = await withDeadline(TIMEOUTS.control, "Asking the server for the result", signal, (inner) =>
    fetch(`${base}/sessions/${session.sessionId}`, { headers: sessionHeaders(base, session), signal: inner }),
  );
  return cleanRecognitionResult(await parse<unknown>(res), session.sessionId);
}

/** How long to keep asking after a 202, and how often. */
const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 3000;

/**
 * Follow up a clip the server is still analysing. The signal to wait on is the
 * server's own `analysing` flag: whether an identification exists is
 * session-wide, so a previous clip's answer would end the wait immediately and
 * be returned as this clip's result.
 */
async function pollUntilSettled(session: SessionHandle, signal?: AbortSignal): Promise<RecognitionResult> {
  let latest = await fetchSession(session, signal);
  for (let i = 0; i < POLL_ATTEMPTS && latest.analysing; i++) {
    if (signal?.aborted) throw new ApiError("Cancelled while waiting for the server.");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    latest = await fetchSession(session, signal);
  }
  return latest;
}

export async function endSession(session: SessionHandle): Promise<void> {
  try {
    const base = baseUrl();
    await withDeadline(TIMEOUTS.control, "Closing the session", undefined, (signal) =>
      fetch(`${base}/sessions/${session.sessionId}`, {
        method: "DELETE",
        headers: sessionHeaders(base, session),
        signal,
      }),
    );
  } catch {
    /* best effort */
  }
}
