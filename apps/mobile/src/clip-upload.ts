/**
 * How a clip goes up to the server: the one request that carries a file.
 *
 * On a phone the clip is a file on disk, and React Native's FormData takes it
 * by its address, `{ uri, name, type }`, for the platform's networking to
 * stream from disk (RCTNetworking on iOS, OkHttp on Android). That part only
 * goes up through React Native's own XMLHttpRequest. SDK 57 replaces the
 * global `fetch` with `expo/fetch` (expo/src/winter/runtime.native.ts), which
 * serialises a FormData itself, in JavaScript, and accepts strings and Blobs
 * only: handed the file part it throws "Unsupported FormDataPart
 * implementation" before anything is sent (clip-upload.test.ts runs Expo's own
 * serialiser on the part). That error is not the server's, so every clip would
 * be queued as "the server is out of reach" and fail the same way on every
 * retry: no phone could identify anything. Reading the file into a Blob first
 * would get it through `expo/fetch`, but whole into memory, up to the server's
 * 80 MB, where React Native streams it.
 *
 * In a browser the part is the picked File itself and the browser's fetch
 * sends it (web-clips.ts).
 *
 * Free of React Native, so it can be tested bare.
 */

/** What api.ts reads of an answer: as much of a fetch Response as it uses. */
export interface Answer {
  status: number;
  ok: boolean;
  text(): Promise<string>;
}

/** A file on the device, as React Native's FormData takes one. */
export interface NativeFilePart {
  uri: string;
  name: string;
  type: string;
}

/** The clip's part on a phone: the file by its address, which the platform streams from disk. */
export function nativeClipPart(uri: string, name: string, type: string): NativeFilePart {
  return { uri, name, type };
}

/** The members of an XMLHttpRequest this uses. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: unknown): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
}

function abortError(): Error {
  return new DOMException("Aborted", "AbortError");
}

/**
 * POST `body` through an XMLHttpRequest, settled the way fetch settles: an
 * answer for every HTTP status, a TypeError when no answer came, an AbortError
 * when `signal` stopped it.
 */
export function sendByXhr(
  xhr: XhrLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => xhr.abort();
    const settle = () => signal.removeEventListener("abort", onAbort);
    xhr.onload = () => {
      settle();
      const status = xhr.status;
      const text = xhr.responseText;
      resolve({ status, ok: status >= 200 && status < 300, text: async () => text });
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError("Network request failed"));
    };
    xhr.ontimeout = () => {
      settle();
      reject(new TypeError("Network request timed out"));
    };
    xhr.onabort = () => {
      settle();
      reject(abortError());
    };
    xhr.open("POST", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    signal.addEventListener("abort", onAbort);
    xhr.send(body);
  });
}

/** The two ways out: the global fetch and a new XMLHttpRequest. Injected by the tests. */
export interface UploadIo {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: unknown; signal: AbortSignal }): Promise<Answer>;
  xhr(): XhrLike;
}

const globalIo: UploadIo = {
  fetch: (url, init) => fetch(url, init as RequestInit),
  xhr: () => new XMLHttpRequest() as unknown as XhrLike,
};

/**
 * Send a clip's form: through the browser's fetch on the web, and through
 * React Native's XMLHttpRequest on a phone, where the global fetch cannot carry
 * the file part (see the top of this file).
 */
export function postClipForm(
  onWeb: boolean,
  url: string,
  init: { headers: Record<string, string>; body: unknown; signal: AbortSignal },
  io: UploadIo = globalIo,
): Promise<Answer> {
  if (onWeb) return io.fetch(url, { method: "POST", headers: init.headers, body: init.body, signal: init.signal });
  return sendByXhr(io.xhr(), url, init.headers, init.body, init.signal);
}
