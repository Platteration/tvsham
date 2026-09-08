import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CLIPS_PER_SESSION, type CaptureSource } from "@tvsham/shared";
import { ApiError, createSession, endSession, uploadClip } from "./api";
import {
  IDLE_STATE,
  runIdentification,
  type ClipProducer,
  type IdentifyState,
} from "./identify-run";
import { enqueue } from "./queue";
import { setLastResult } from "./store";

export type { ClipProducer, IdentifyState, Phase } from "./identify-run";

/**
 * React wrapper around `runIdentification`: supplies the real dependencies and
 * keeps the reported states in component state. The loop itself lives in
 * `identify-run.ts` so it can be tested without a renderer.
 */
export function useIdentify() {
  const [state, setState] = useState<IdentifyState>(IDLE_STATE);
  const cancelled = useRef(false);
  const sessionRef = useRef<string | null>(null);
  const producerRef = useRef<ClipProducer | null>(null);

  const cancel = useCallback(() => {
    cancelled.current = true;
    producerRef.current?.stop?.();
    const id = sessionRef.current;
    sessionRef.current = null;
    if (id) void endSession(id);
    setState(IDLE_STATE);
  }, []);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(
    async (source: CaptureSource, producer: ClipProducer, opts: { maxClips?: number; hints?: string } = {}) => {
      cancelled.current = false;
      producerRef.current = producer;
      await runIdentification(
        {
          createSession,
          uploadClip,
          endSession: (id) => {
            sessionRef.current = null;
            void endSession(id);
          },
          enqueue,
          isApiError: (err) => err instanceof ApiError,
          onResult: (result) => setLastResult({ result, source }),
          onState: setState,
          isCancelled: () => cancelled.current,
          onSession: (id) => {
            sessionRef.current = id;
          },
        },
        {
          source,
          producer,
          maxClips: opts.maxClips ?? MAX_CLIPS_PER_SESSION,
          ...(opts.hints ? { hints: opts.hints } : {}),
        },
      );
    },
    [],
  );

  const reset = useCallback(() => {
    cancelled.current = true;
    setState(IDLE_STATE);
  }, []);

  return { state, start, cancel, reset };
}
