import { randomBytes, randomUUID } from "node:crypto";
import type { CaptureSource, CastMember, Identification, ResolvedLink, WatchOption } from "@tvsham/shared";
import { config } from "./config.js";
import type { Evidence } from "./recognize.js";

export interface Session {
  id: string;
  /**
   * The secret returned to whoever created it, and the only thing that
   * authorises a later call. The id is in the path of every request and so in
   * every access log on the way; this is in a header and is never printed.
   */
  key: string;
  createdAt: number;
  touchedAt: number;
  evidence: Evidence;
  clips: number;
  /** Client-supplied keys of clips already analysed, so a retried upload is not processed twice. */
  seenClipKeys: Set<string>;
  secondsAnalysed: number;
  /** ISO 3166-1 country used for "where to watch". */
  region: string;
  last?: { identification: Identification; links: ResolvedLink[]; watch: WatchOption[]; cast: CastMember[] };
  /**
   * The caller bucket that created it. Sessions are otherwise anonymous, and a
   * table with no owners cannot tell "500 users" from "one address holding
   * every slot".
   */
  owner: string;
  /** Serialises clip processing so two uploads for one session never race. */
  busy: Promise<unknown>;
  /** Clips of this session currently being analysed. */
  analysing: number;
}

const sessions = new Map<string, Session>();

export function createSession(
  source: CaptureSource,
  hints?: string,
  region = config.defaultRegion,
  owner = "ip:unknown",
): Session {
  const s: Session = {
    id: randomUUID(),
    // 256 bits from the CSPRNG: this is a bearer credential, not an id.
    key: randomBytes(32).toString("base64url"),
    createdAt: Date.now(),
    touchedAt: Date.now(),
    evidence: { source, frames: [], transcripts: [], ...(hints ? { hints } : {}) },
    clips: 0,
    seenClipKeys: new Set(),
    secondsAnalysed: 0,
    region,
    owner,
    busy: Promise.resolve(),
    analysing: 0,
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
    // Idle sessions go, and so do old ones however recently they were read:
    // getSession refreshes touchedAt, so an idle timeout alone lets a caller
    // hold a slot indefinitely by polling its own session.
    if (now - s.touchedAt > config.sessionTtlMs || now - s.createdAt > config.sessionMaxAgeMs) {
      sessions.delete(id);
      n++;
    }
  }
  return n;
}

export function sessionCount(): number {
  return sessions.size;
}

/** How many live sessions one caller bucket is holding. */
export function sessionsHeldBy(owner: string): number {
  let n = 0;
  for (const s of sessions.values()) if (s.owner === owner) n++;
  return n;
}
