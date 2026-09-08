import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaptureSource, RecognitionResult } from "@tvsham/shared";
import { runIdentification, type ClipProducer, type IdentifyDeps, type IdentifyState } from "./identify-run.js";

class FakeApiError extends Error {}

function result(patch: Partial<RecognitionResult> = {}): RecognitionResult {
  return {
    sessionId: "s1",
    status: "identified",
    secondsAnalysed: 8,
    links: [],
    watch: [],
    cast: [],
    analysing: false,
    wantsMore: false,
    message: "Found it.",
    identification: { kind: "movie", title: "Inception", confidence: 0.9, evidence: "t" },
    ...patch,
  };
}

interface Harness {
  deps: IdentifyDeps;
  states: IdentifyState[];
  uploaded: string[];
  queued: Array<{ uri: string; reason: string }>;
  results: RecognitionResult[];
  endedSessions: string[];
  cancel(): void;
}

/**
 * `upload` decides what the server answers for each clip; the harness always
 * records the uri, so a test cannot accidentally disable its own bookkeeping.
 */
function harness(
  opts: { upload?: (uri: string, n: number) => Promise<RecognitionResult> } & Partial<IdentifyDeps> = {},
): Harness {
  const { upload, ...overrides } = opts;
  const states: IdentifyState[] = [];
  const uploaded: string[] = [];
  const queued: Array<{ uri: string; reason: string }> = [];
  const results: RecognitionResult[] = [];
  const endedSessions: string[] = [];
  let cancelled = false;
  let last: IdentifyState = { phase: "idle", clip: 0, result: null, error: null };

  const deps: IdentifyDeps = {
    createSession: async () => "s1",
    uploadClip: async (_id, uri) => {
      uploaded.push(uri);
      return upload ? upload(uri, uploaded.length) : result();
    },
    endSession: (id) => endedSessions.push(id),
    enqueue: async (uri, _source, reason) => {
      queued.push({ uri, reason });
      return { id: "q1" };
    },
    isApiError: (err) => err instanceof FakeApiError,
    onResult: (r) => results.push(r),
    onState: (next) => {
      last = typeof next === "function" ? next(last) : next;
      states.push(last);
    },
    isCancelled: () => cancelled,
    onSession: () => {},
    ...overrides,
  };

  return {
    deps,
    states,
    uploaded,
    queued,
    results,
    endedSessions,
    cancel: () => {
      cancelled = true;
    },
  };
}

function producer(uris: Array<string | null>): ClipProducer & { stopped: number; recordings: number } {
  let i = 0;
  return {
    stopped: 0,
    recordings: 0,
    async record() {
      this.recordings++;
      return uris[i++] ?? null;
    },
    stop() {
      this.stopped++;
    },
  };
}

const source: CaptureSource = "camera";
const run = (h: Harness, p: ClipProducer, maxClips = 4, hints?: string) =>
  runIdentification(h.deps, { source, producer: p, maxClips, ...(hints ? { hints } : {}) });

describe("identification loop", () => {
  it("stops after one clip when the server is confident", async () => {
    const h = harness();
    const p = producer(["a.mp4", "b.mp4"]);
    await run(h, p);

    assert.deepEqual(h.uploaded, ["a.mp4"]);
    assert.equal(h.results.length, 1);
    assert.equal(h.states.at(-1)?.phase, "done");
    assert.equal(h.states.at(-1)?.clip, 1);
    assert.equal(p.stopped, 1, "the recorder must be told to stop");
    assert.deepEqual(h.endedSessions, ["s1"]);
  });

  it("keeps going while the server asks for more", async () => {
    const h = harness({
      upload: async (_uri, n) => result(n === 1 ? { wantsMore: true, status: "listening" } : {}),
    });
    const p = producer(["a.mp4", "b.mp4", "c.mp4"]);
    await run(h, p);

    assert.deepEqual(h.uploaded, ["a.mp4", "b.mp4"]);
    assert.equal(h.states.at(-1)?.phase, "done");
    assert.equal(h.states.at(-1)?.clip, 2);
  });

  it("stops at the clip limit even if the server still wants more", async () => {
    const h = harness({ upload: async () => result({ wantsMore: true }) });
    const p = producer(["a.mp4", "b.mp4", "c.mp4"]);
    await run(h, p, 2);

    assert.deepEqual(h.uploaded, ["a.mp4", "b.mp4"]);
    assert.equal(h.states.at(-1)?.phase, "done");
  });

  it("records the next clip while the current one uploads", async () => {
    const recordingsDuringUpload: number[] = [];
    const p = producer(["a.mp4", "b.mp4", "c.mp4"]);
    const h = harness({
      upload: async (uri) => {
        // Give the loop a turn to start the next recording before resolving.
        await new Promise((r) => setTimeout(r, 5));
        recordingsDuringUpload.push(p.recordings);
        return result(uri === "a.mp4" ? { wantsMore: true } : {});
      },
    });
    await run(h, p);
    // While clip 1 was uploading, clip 2 had already been asked for.
    assert.equal(recordingsDuringUpload[0], 2, "the next clip must record during the upload");
  });

  it("keeps a clip the network never delivered", async () => {
    const h = harness({
      upload: async () => {
        throw new Error("Network request failed");
      },
    });
    const p = producer(["a.mp4", "b.mp4"]);
    await run(h, p, 4, "on Netflix");

    assert.deepEqual(h.queued.map((q) => q.uri), ["a.mp4"]);
    assert.equal(h.states.at(-1)?.phase, "queued");
    assert.equal(h.states.at(-1)?.error, null);
  });

  it("does not keep a clip the server itself rejected", async () => {
    const h = harness({
      upload: async () => {
        throw new FakeApiError("clip too large");
      },
    });
    await run(h, producer(["a.mp4"]));

    assert.deepEqual(h.queued, []);
    assert.equal(h.states.at(-1)?.phase, "error");
    assert.equal(h.states.at(-1)?.error, "clip too large");
  });

  it("never re-sends a clip that was already analysed", async () => {
    // First clip succeeds, second upload dies on the network: only the second
    // clip is unsent, and the first must not be queued and paid for twice.
    const h = harness({
      upload: async (uri) => {
        if (uri === "a.mp4") return result({ wantsMore: true });
        throw new Error("Network request failed");
      },
    });
    await run(h, producer(["a.mp4", "b.mp4", "c.mp4"]));

    assert.deepEqual(h.queued.map((q) => q.uri), ["b.mp4"]);
  });

  it("keeps a clip that was still recording when the session could not be created", async () => {
    const h = harness({
      createSession: async () => {
        throw new Error("Network request failed");
      },
    });
    await run(h, producer(["a.mp4"]));

    assert.deepEqual(h.queued.map((q) => q.uri), ["a.mp4"]);
  });

  it("surfaces a recording failure as an error rather than queueing nothing", async () => {
    const h = harness();
    await run(h, producer([null]));

    assert.deepEqual(h.queued, []);
    assert.equal(h.states.at(-1)?.phase, "error");
    assert.match(h.states.at(-1)?.error ?? "", /Recording produced no file/);
  });

  it("goes quiet when cancelled mid-upload: no result, no state, no queue", async () => {
    const h = harness({
      upload: async () => {
        h.cancel();
        throw new Error("Network request failed");
      },
    });
    await run(h, producer(["a.mp4"]));

    assert.deepEqual(h.queued, [], "a cancelled run must not queue the clip");
    assert.deepEqual(h.results, []);
    assert.ok(
      h.states.every((s) => s.phase !== "error" && s.phase !== "queued"),
      "cancelling must not clobber the idle state with a failure",
    );
  });

  it("ends the session even when the run fails", async () => {
    const h = harness({
      upload: async () => {
        throw new FakeApiError("nope");
      },
    });
    await run(h, producer(["a.mp4"]));
    assert.deepEqual(h.endedSessions, ["s1"]);
  });
});
