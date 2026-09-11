import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_CLIPS_PER_SESSION, type CaptureSource, type SessionHandle } from "@tvsham/shared";
import { ApiError, createSession, endSession, uploadClip } from "./api";
import {
  IDLE_STATE,
  createRunGuard,
  runIdentification,
  type ClipProducer,
  type IdentifyState,
} from "./identify-run";
import { discardFile, enqueue } from "./queue";
import { setLastResult } from "./store";

export type { ClipProducer, IdentifyState, Phase } from "./identify-run";

/**
 * React wrapper around `runIdentification`: supplies the real dependencies and
 * keeps the reported states in component state. The loop itself lives in
 * `identify-run.ts` so it can be tested without a renderer.
 */
export function useIdentify() {
  const [state, setState] = useState<IdentifyState>(IDLE_STATE);
  // One token per run, not one flag for all of them: see createRunGuard.
  const guard = useRef(createRunGuard());
  const sessionRef = useRef<SessionHandle | null>(null);
  const producerRef = useRef<ClipProducer | null>(null);

  const cancel = useCallback(() => {
    guard.current.cancel();
    producerRef.current?.stop?.();
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) void endSession(session);
    setState(IDLE_STATE);
  }, []);

  useEffect(() => cancel, [cancel]);

  const start = useCallback(
    async (source: CaptureSource, producer: ClipProducer, opts: { maxClips?: number; hints?: string } = {}) => {
      const run = guard.current.begin();
      producerRef.current = producer;
      await runIdentification(
        {
          createSession,
          uploadClip,
          endSession: (session) => {
            // Only forget the session this run owns. A run that finishes late
            // must not clear the session of the run that replaced it, or a
            // later cancel has nothing to end server-side.
            if (sessionRef.current?.sessionId === session.sessionId) sessionRef.current = null;
            void endSession(session);
          },
          enqueue,
          discardClip: discardFile,
          isApiError: (err) => err instanceof ApiError,
          onResult: (result) => setLastResult({ result, source }),
          onState: setState,
          isCancelled: run.isCancelled,
          onSession: (session) => {
            sessionRef.current = session;
          },
        },
        {
          source,
          producer,
          maxClips: opts.maxClips ?? MAX_CLIPS_PER_SESSION,
          signal: run.signal,
          ...(opts.hints ? { hints: opts.hints } : {}),
        },
      );
    },
    [],
  );

  const reset = useCallback(() => {
    guard.current.cancel();
    setState(IDLE_STATE);
  }, []);

  return { state, start, cancel, reset };
}
