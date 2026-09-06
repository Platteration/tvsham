import { randomUUID } from "node:crypto";
import type { CaptureSource, Identification, ResolvedLink } from "@tvsham/shared";
import { config } from "./config.js";
import type { Evidence } from "./recognize.js";

export interface Session {
  id: string;
  createdAt: number;
  touchedAt: number;
  evidence: Evidence;
  clips: number;
  secondsAnalysed: number;
  last?: { identification: Identification; links: ResolvedLink[] };
  /** Serialises clip processing so two uploads for one session never race. */
  busy: Promise<unknown>;
}

const sessions = new Map<string, Session>();

export function createSession(source: CaptureSource, hints?: string): Session {
  const s: Session = {
    id: randomUUID(),
    createdAt: Date.now(),
    touchedAt: Date.now(),
    evidence: { source, frames: [], transcripts: [], ...(hints ? { hints } : {}) },
    clips: 0,
    secondsAnalysed: 0,
    busy: Promise.resolve(),
  };
  sessions.set(s.id, s);
  return s;
}

export function getSession(id: string): Session | undefined {
  const s = sessions.get(id);
  if (s) s.touchedAt = Date.now();
  return s;
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

export function sweepSessions(now = Date.now()): number {
  let n = 0;
  for (const [id, s] of sessions) {
    if (now - s.touchedAt > config.sessionTtlMs) {
      sessions.delete(id);
      n++;
    }
  }
  return n;
}

export function sessionCount(): number {
  return sessions.size;
}
