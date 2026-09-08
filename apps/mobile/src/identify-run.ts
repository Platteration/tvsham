/**
 * The identification loop, with every side effect injected.
 *
 * This is the most intricate logic in the app — record and upload overlap, a
 * failure may keep the clip for later, and the user can cancel at any point —
 * so it lives apart from React and is tested directly. `useIdentify` supplies
 * the real dependencies and turns the reported states into React state.
 */
import type { CaptureSource, RecognitionResult } from "@tvsham/shared";

export type Phase = "idle" | "recording" | "uploading" | "done" | "error" | "queued";

export interface IdentifyState {
  phase: Phase;
  /** 1-based index of the clip currently being recorded or uploaded. */
  clip: number;
  result: RecognitionResult | null;
  error: string | null;
  /** Set when the clip could not be sent and was kept for later. */
  queued?: boolean;
}

export const IDLE_STATE: IdentifyState = { phase: "idle", clip: 0, result: null, error: null };

/**
 * Something that produces one clip on disk when asked: the camera records
 * CLIP_SECONDS of video; screen mode returns a file the user picked.
 */
export interface ClipProducer {
  record(): Promise<string | null>;
  /** Abort an in-flight recording early. */
  stop?(): void;
}

export interface IdentifyDeps {
  createSession(source: CaptureSource, hints?: string): Promise<string>;
  uploadClip(sessionId: string, uri: string, opts: { clipKey: string }): Promise<RecognitionResult>;
  endSession(sessionId: string): void;
  /** Keep a clip that never reached the server. Returns null if it could not be kept. */
  enqueue(uri: string, source: CaptureSource, reason: string, hints?: string): Promise<unknown | null>;
  /** True when the error came from the server rather than the network. */
  isApiError(err: unknown): boolean;
  /** Hand the finished answer to the rest of the app. */
  onResult(result: RecognitionResult, source: CaptureSource): void;
  /** Report progress. Called with each new state, in order. */
  onState(next: IdentifyState | ((prev: IdentifyState) => IdentifyState)): void;
  /** Whether the user has cancelled since this run began. */
  isCancelled(): boolean;
  /** Called once the session id exists, so a cancel can end it server-side. */
  onSession(sessionId: string): void;
}

export interface IdentifyOptions {
  source: CaptureSource;
  producer: ClipProducer;
  maxClips: number;
  hints?: string;
}

function messageFor(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

/**
 * Record a clip, upload it, read the answer, repeat until the server is
 * confident, the user cancels, or the clip limit is reached. The next clip
 * records while the previous one uploads, so no time is lost waiting.
 */
export async function runIdentification(deps: IdentifyDeps, opts: IdentifyOptions): Promise<void> {
  const { source, producer, maxClips } = opts;
  deps.onState({ phase: "recording", clip: 1, result: null, error: null });

  // The clip in hand and not yet accepted by the server, kept outside the try
  // so a failure can still queue it. Cleared as soon as one is analysed.
  let unsentClipUri: string | null = null;
  // Set only when talking to the server failed, never when the camera did.
  let networkFailed = false;
  const overNetwork = async <T,>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (err) {
      if (!deps.isApiError(err)) networkFailed = true;
      throw err;
    }
  };

  // Start recording immediately; the session is created while the first clip records.
  let recording: Promise<string | null> = producer.record().catch(() => null);
  let sessionId: string | null = null;

  try {
    sessionId = await overNetwork(() => deps.createSession(source, opts.hints));
    if (deps.isCancelled()) return;
    deps.onSession(sessionId);

    let latest: RecognitionResult | null = null;
    let clipsDone = 0;
    for (let clip = 1; clip <= maxClips; clip++) {
      const uri = await recording;
      if (deps.isCancelled()) return;
      if (!uri) throw new Error("Recording produced no file.");
      unsentClipUri = uri;

      deps.onState({ phase: "uploading", clip, result: latest, error: null });
      const upload = overNetwork(() => deps.uploadClip(sessionId!, uri, { clipKey: `${sessionId}:${clip}` }));
      // Keep listening while the server thinks.
      const hasNext = clip < maxClips;
      recording = hasNext ? producer.record() : Promise.resolve(null);

      latest = await upload;
      // Analysed and paid for: it must never be queued and sent again.
      unsentClipUri = null;
      clipsDone = clip;
      if (deps.isCancelled()) return;

      if (!latest.wantsMore || !hasNext) {
        producer.stop?.();
        break;
      }
      deps.onState({ phase: "recording", clip: clip + 1, result: latest, error: null });
    }

    if (latest) {
      deps.onResult(latest, source);
      deps.onState({ phase: "done", clip: clipsDone, result: latest, error: null });
    }
  } catch (err) {
    if (deps.isCancelled()) return;
    producer.stop?.();
    const message = messageFor(err);
    // The server being unreachable is not the user's problem to solve now: keep
    // the clip and identify it once there is a connection again. A clip that was
    // still recording when the session failed is worth keeping too.
    if (networkFailed && !unsentClipUri) unsentClipUri = await recording.catch(() => null);
    if (deps.isCancelled()) return;
    const kept =
      networkFailed && unsentClipUri ? await deps.enqueue(unsentClipUri, source, message, opts.hints) : null;
    deps.onState((prev) =>
      kept
        ? { ...prev, phase: "queued", error: null, queued: true }
        : { ...prev, phase: "error", error: message },
    );
  } finally {
    if (sessionId) deps.endSession(sessionId);
  }
}
