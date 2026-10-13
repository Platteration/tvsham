import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { nativeClipPart, postClipForm, sendByXhr, type UploadIo, type XhrLike } from "./clip-upload";

const require = createRequire(import.meta.url);
/** The installed expo package's own sources, loaded as they are (not resolved by TypeScript). */
const expoSource = (file: string) => pathToFileURL(join(dirname(require.resolve("expo/package.json")), "src", file)).href;

/**
 * React Native's FormData as SDK 57 leaves it: a list of [name, value] parts, with Expo's own
 * patch (expo/src/winter/FormData.ts, installed on the real one at startup) supplying append()
 * and entries(). What api.ts builds on a phone is built here through that same patch.
 */
async function phoneForm(): Promise<FormData> {
  const { installFormDataPatch } = (await import(expoSource("winter/FormData.ts"))) as {
    installFormDataPatch(ctor: unknown): void;
  };
  class ReactNativeFormData {
    _parts: Array<[string, unknown]> = [];
  }
  installFormDataPatch(ReactNativeFormData);
  const form = new ReactNativeFormData() as unknown as FormData;
  // As uploadClip appends them.
  (form.append as (name: string, value: unknown) => void)("clip", nativeClipPart("file:///data/clip.mp4", "clip.mp4", "video/mp4"));
  form.append("clipKey", "session:1");
  return form;
}

/** An XMLHttpRequest that records what it was asked to do and answers when told. */
class FakeXhr implements XhrLike {
  status = 0;
  responseText = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  opened: [string, string] | null = null;
  headers: Array<[string, string]> = [];
  sent: unknown = undefined;
  sends = 0;
  aborts = 0;
  open(method: string, url: string) {
    this.opened = [method, url];
  }
  setRequestHeader(name: string, value: string) {
    this.headers.push([name, value]);
  }
  send(body: unknown) {
    this.sent = body;
    this.sends++;
  }
  abort() {
    this.aborts++;
    this.onabort?.();
  }
  answer(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}

function io(xhr: FakeXhr): UploadIo & { fetched: unknown[] } {
  const fetched: unknown[] = [];
  return {
    fetched,
    fetch: async (url, init) => {
      fetched.push([url, init]);
      return { status: 200, ok: true, text: async () => "{}" };
    },
    xhr: () => xhr,
  };
}

describe("a clip upload from a phone", () => {
  it("cannot go through SDK 57's global fetch, whose FormData serialiser refuses the file part", async () => {
    // The finding this module answers: expo/fetch (the global fetch on a phone since SDK 57)
    // serialises a FormData in JavaScript and takes strings and Blobs only. Run on the very
    // part uploadClip appends, it throws before anything is sent. Should a later Expo learn to
    // stream a { uri } part, this fails, and the XMLHttpRequest below can be reconsidered.
    const { convertFormDataAsync } = (await import(expoSource("winter/fetch/convertFormData.ts"))) as {
      convertFormDataAsync(form: FormData): Promise<unknown>;
    };
    await assert.rejects(convertFormDataAsync(await phoneForm()), /Unsupported FormDataPart implementation/);
  });

  it("goes through XMLHttpRequest with every header, carrying the form untouched", async () => {
    const xhr = new FakeXhr();
    const out = io(xhr);
    const form = await phoneForm();
    const answer = postClipForm(
      false,
      "https://tvsham.example/sessions/s1/clips",
      { headers: { "X-Session-Key": "k", "X-Clip-Key": "session:1" }, body: form, signal: new AbortController().signal },
      out,
    );
    assert.deepEqual(out.fetched, [], "the global fetch is never asked");
    assert.deepEqual(xhr.opened, ["POST", "https://tvsham.example/sessions/s1/clips"]);
    assert.deepEqual(xhr.headers, [["X-Session-Key", "k"], ["X-Clip-Key", "session:1"]]);
    assert.equal(xhr.sent, form, "React Native's networking reads the { uri } part and streams the file");
    xhr.answer(200, '{"status":"identified"}');
    const res = await answer;
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(await res.text(), '{"status":"identified"}');
  });

  it("reads every HTTP status as an answer, as fetch does, for api.ts to turn into its error", async () => {
    for (const [status, ok] of [[202, true], [413, false], [503, false]] as const) {
      const xhr = new FakeXhr();
      const res = sendByXhr(xhr, "https://s/c", {}, "body", new AbortController().signal);
      xhr.answer(status, '{"error":"x"}');
      const got = await res;
      assert.deepEqual([got.status, got.ok, await got.text()], [status, ok, '{"error":"x"}']);
    }
  });

  it("fails as a network failure when no answer comes, so the run keeps the clip for later", async () => {
    for (const fire of ["onerror", "ontimeout"] as const) {
      const xhr = new FakeXhr();
      const res = sendByXhr(xhr, "https://s/c", {}, "body", new AbortController().signal);
      xhr[fire]?.();
      await assert.rejects(res, TypeError, fire);
    }
  });

  it("stops the request when the run is cancelled or its deadline passes", async () => {
    const xhr = new FakeXhr();
    const stop = new AbortController();
    const res = sendByXhr(xhr, "https://s/c", {}, "body", stop.signal);
    stop.abort();
    await assert.rejects(res, { name: "AbortError" });
    assert.equal(xhr.aborts, 1);

    const late = new FakeXhr();
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(sendByXhr(late, "https://s/c", {}, "body", stopped.signal), { name: "AbortError" });
    assert.equal(late.sends, 0, "an already-cancelled run sends nothing");
  });
});

describe("a clip upload from a browser", () => {
  it("goes through the browser's fetch, with the picked File in the form", async () => {
    const xhr = new FakeXhr();
    const out = io(xhr);
    const form = new FormData();
    form.append("clip", new Blob(["x"], { type: "video/mp4" }), "clip.mp4");
    const signal = new AbortController().signal;
    const res = await postClipForm(true, "https://s/c", { headers: { "X-Clip-Key": "k" }, body: form, signal }, out);
    assert.equal(res.status, 200);
    assert.deepEqual(out.fetched, [["https://s/c", { method: "POST", headers: { "X-Clip-Key": "k" }, body: form, signal }]]);
    assert.equal(xhr.opened, null);
  });
});

describe("api.ts", () => {
  it("builds the phone's part with nativeClipPart and sends every clip through postClipForm", () => {
    // uploadClip itself imports React Native and cannot load here; this keeps it on the path
    // the tests above drive, rather than back on the global fetch.
    // .pathname: the DOM lib's URL type and Node's disagree under this tsconfig.
    const api = readFileSync(new URL("./api.ts", import.meta.url).pathname, "utf8");
    assert.match(api, /form\.append\("clip", nativeClipPart\(fileUri, name, type\)\);/);
    assert.match(api, /postClipForm\(Platform\.OS === "web", `\$\{base\}\/sessions\/\$\{session\.sessionId\}\/clips`/);
    assert.doesNotMatch(api, /fetch\(`\$\{base\}\/sessions\/\$\{session\.sessionId\}\/clips`/);
  });
});
