import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_CLIPS_PER_SESSION,
  type CaptureSource,
  type RecognitionResult,
} from "@tvsham/shared";
import { ApiError, createSession, endSession, uploadClip } from "./api";
import { enqueue } from "./queue";
import { setLastResult } from "./store";

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

const idle: IdentifyState = { phase: "idle", clip: 0, result: null, error: null };

/**
 * Something that produces one clip on disk when asked: the camera records
 * CLIP_SECONDS of video; screen mode returns a file the user picked.
 */
export interface ClipProducer {
  record(): Promise<string | null>;
  /** Abort an in-flight recording early. */
  stop?(): void;
}

/**
 * Drives one recognition session: record clip → upload → read the answer → repeat
 * until the server is confident, the user cancels, or the clip limit is reached.
 * While a clip uploads, the next one is already recording so no time is lost.
 */
export function useIdentify() {
  const [state, setState] = useState<IdentifyState>(idle);
  const cancelled = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const producerRef = useRef<ClipProducer | null>(null);

  const cancel = useCallback(() => {
    cancelled.current = true;
    producerRef.current?.stop?.();
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id) void endSession(id);
    setState(idle);
  }, []);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(
    async (source: CaptureSource, producer: ClipProducer, opts: { maxClips?: number; hints?: string } = {}) => {
      cancelled.current = false;
      producerRef.current = producer;
      const maxClips = opts.maxClips ?? MAX_CLIPS_PER_SESSION;
      setState({ phase: "recording", clip: 1, result: null, error: null });

      // The clip in hand, kept outside the try so a failure can still queue it.
      let lastClipUri: string | null = null;
      // Start recording immediately; the session is created while the first clip records.
      let recording: Promise<string | null> = producer.record().catch(() => null);

      try {
        const sessionId = await createSession(source, opts.hints);
        if (cancelled.current) return;
        sessionRef.current = sessionId;

        let latest: RecognitionResult | null = null;
        let clipsDone = 0;
        for (let clip = 1; clip <= maxClips; clip++) {
          const uri = await recording;
          if (cancelled.current) return;
          if (!uri) throw new Error("Recording produced no file.");
          lastClipUri = uri;

          setState({ phase: "uploading", clip, result: latest, error: null });
          const upload = uploadClip(sessionId, uri, { clipKey: `${sessionId}:${clip}` });
          // Keep listening while the server thinks.
          const hasNext = clip < maxClips;
          recording = hasNext ? producer.record() : Promise.resolve(null);

          latest = await upload;
          clipsDone = clip;
          if (cancelled.current) return;

          if (!latest.wantsMore || !hasNext) {
            producer.stop?.();
            break;
          }
          setState({ phase: "recording", clip: clip + 1, result: latest, error: null });
        }

        if (latest) {
          setLastResult({ result: latest, source });
          setState({ phase: "done", clip: clipsDone, result: latest, error: null });
        }
      } catch (err) {
        if (cancelled.current) return;
        producer.stop?.();
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Something went wrong.";
        // The server being unreachable is not the user's problem to solve now:
        // keep the clip and identify it once there is a connection again.
        const networkProblem = !(err instanceof ApiError);
        // A clip that was still recording when the session failed is worth keeping too.
        if (!lastClipUri) lastClipUri = await recording.catch(() => null);
        const kept =
          networkProblem && lastClipUri ? await enqueue(lastClipUri, source, message, opts.hints) : null;
        setState((prev) =>
          kept
            ? { ...prev, phase: "queued", error: null, queued: true }
            : { ...prev, phase: "error", error: message },
        );
      } finally {
        const id = sessionRef.current;
        sessionRef.current = null;
        if (id) void endSession(id);
      }
    },
    [],
  );

  const reset = useCallback(() => {
    cancelled.current = true;
    setState(idle);
  }, []);

  return { state, start, cancel, reset };
}
