// originCooldowns.ts — the in-process per-origin cooldown store the failover chain consults before
// spending a request (linkedinSourceClient walk). IN-PROCESS on purpose, not Redis and not a DB column:
// core cannot import ioredis (dep-cruiser), the chain's callers have no Redis seam to thread one through,
// and the origin cache's own 60s TTL would make a persisted column LESS accurate than this map for the
// single-digit-second Retry-After values QUEUE_FULL sends. Worst case per process: one cheap probe per
// origin per cooldown window against a proxy that answers 429/503 instantly. Keyed by origin id (or
// baseUrl for the synthetic env-fallback origin, which has no row).

export interface OriginCooldownStore {
  /** `throttled` echoes what set() recorded — backpressure (429/queue) vs outage/misconfig — so the
   *  walk's `unavailable.reason` stays honest across walks, not just on the walk that set the cooldown. */
  cooling(key: string): { cooling: boolean; remainingMs: number; throttled: boolean };
  set(key: string, ms: number, throttled?: boolean): void;
  /** Clear on success — an origin that answered is healthy regardless of an old horizon. */
  clear(key: string): void;
  /** Drop all state — wired into invalidateOriginCache so an admin fix/probe sees a fresh fleet. */
  reset(): void;
}

export function makeOriginCooldownStore(now: () => number = Date.now): OriginCooldownStore {
  const until = new Map<string, { at: number; throttled: boolean }>();
  return {
    cooling(key) {
      const entry = until.get(key);
      if (entry === undefined) return { cooling: false, remainingMs: 0, throttled: false };
      const remainingMs = entry.at - now();
      if (remainingMs <= 0) {
        until.delete(key);
        return { cooling: false, remainingMs: 0, throttled: false };
      }
      return { cooling: true, remainingMs, throttled: entry.throttled };
    },
    set(key, ms, throttled = false) {
      if (ms > 0) until.set(key, { at: now() + ms, throttled });
    },
    clear(key) {
      until.delete(key);
    },
    reset() {
      until.clear();
    },
  };
}

/** The shared per-process default instance the production chain uses. */
export const originCooldowns: OriginCooldownStore = makeOriginCooldownStore();
