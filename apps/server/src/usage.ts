/**
 * A per-caller daily cap on analysed clips. Every clip costs real money, so an
 * exposed server needs a ceiling that does not depend on the app behaving.
 *
 * Counts are in memory: they reset when the process restarts, which is fine for
 * a single self-hosted instance. Put a shared store behind this before running
 * more than one replica.
 */
export interface UsageStore {
  /** Consume one unit. Returns false when the caller is already at the cap. */
  take(caller: string, now?: number): boolean;
  /** Units already used today. */
  used(caller: string, now?: number): number;
  remaining(caller: string, now?: number): number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createUsageStore(limitPerDay: number): UsageStore {
  const counts = new Map<string, { day: number; used: number }>();
  const unlimited = limitPerDay <= 0;

  const dayOf = (now: number) => Math.floor(now / DAY_MS);

  const entry = (caller: string, now: number) => {
    const day = dayOf(now);
    const found = counts.get(caller);
    if (!found || found.day !== day) {
      const fresh = { day, used: 0 };
      counts.set(caller, fresh);
      // Drop other callers' stale days so the map cannot grow without bound.
      if (counts.size > 10_000) {
        for (const [k, v] of counts) if (v.day !== day) counts.delete(k);
      }
      return fresh;
    }
    return found;
  };

  return {
    take(caller, now = Date.now()) {
      if (unlimited) return true;
      const e = entry(caller, now);
      if (e.used >= limitPerDay) return false;
      e.used++;
      return true;
    },
    used(caller, now = Date.now()) {
      return unlimited ? 0 : entry(caller, now).used;
    },
    remaining(caller, now = Date.now()) {
      return unlimited ? Number.POSITIVE_INFINITY : Math.max(0, limitPerDay - entry(caller, now).used);
    },
  };
}
