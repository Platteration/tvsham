import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_CLIPS_PER_SESSION,
  type CaptureSource,
  type RecognitionResult,
} from "@tvsham/shared";
import { ApiError, createSession, endSession, uploadClip } from "./api";
import { setLastResult } from "./store";

export type Phase = "idle" | "recording" | "uploading" | "done" | "error";

export interface IdentifyState {
  phase: Phase;
  /** 1-based index of the clip currently being recorded or uploaded. */
  clip: number;
  result: RecognitionResult | null;
  error: string | null;
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

      try {
        // Start recording immediately; the session is created while the first clip records.
        let recording: Promise<string | null> = producer.record();
        const sessionId = await createSession(source, opts.hints);
        if (cancelled.current) return;
        sessionRef.current = sessionId;

        let latest: RecognitionResult | null = null;
        let clipsDone = 0;
        for (let clip = 1; clip <= maxClips; clip++) {
          const uri = await recording;
          if (cancelled.current) return;
          if (!uri) throw new Error("Recording produced no file.");

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
        setState((prev) => ({ ...prev, phase: "error", error: message }));
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
