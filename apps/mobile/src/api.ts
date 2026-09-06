import type {
  CaptureSource,
  CreateSessionResponse,
  HealthResponse,
  RecognitionResult,
} from "@tvsham/shared";
import { getSettings } from "./store";

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

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const token = getSettings().token.trim();
  if (token) h.Authorization = `Bearer ${token}`;
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
  const res = await fetch(`${baseUrl()}/health`, {
    headers: headers(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parse<HealthResponse>(res);
}

export async function createSession(source: CaptureSource): Promise<string> {
  const res = await fetch(`${baseUrl()}/sessions`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ source }),
  });
  return (await parse<CreateSessionResponse>(res)).sessionId;
}

/**
 * Upload one recorded clip. React Native's fetch accepts `{ uri, name, type }`
 * objects in FormData and streams the file from disk.
 */
export async function uploadClip(
  sessionId: string,
  fileUri: string,
  opts: { mimeType?: string; signal?: AbortSignal; clipKey?: string } = {},
): Promise<RecognitionResult> {
  const name = fileUri.split("/").pop() || "clip.mp4";
  const type = opts.mimeType ?? (name.toLowerCase().endsWith(".mov") ? "video/quicktime" : "video/mp4");
  const send = async () => {
    const form = new FormData();
    // @ts-expect-error React Native FormData accepts file descriptors, the DOM types do not.
    form.append("clip", { uri: fileUri, name, type });
    // Lets the server ignore a duplicate if the retry below re-sends a clip it already got.
    form.append("clipKey", opts.clipKey ?? fileUri);
    const res = await fetch(`${baseUrl()}/sessions/${sessionId}/clips`, {
      method: "POST",
      headers: headers(),
      body: form,
      signal: opts.signal ?? null,
    });
    return parse<RecognitionResult>(res);
  };
  try {
    return await send();
  } catch (err) {
    // One retry for transient network drops; server-side errors are not retried.
    if (err instanceof ApiError || opts.signal?.aborted) throw err;
    await new Promise((r) => setTimeout(r, 800));
    return send();
  }
}

export async function endSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${baseUrl()}/sessions/${sessionId}`, { method: "DELETE", headers: headers() });
  } catch {
    /* best effort */
  }
}
