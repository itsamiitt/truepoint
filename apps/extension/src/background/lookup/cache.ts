// LookupCache — a short-lived, memory-only warm cache + single-flight coalescer for LOOKUP resolution
// (02 §state-and-storage: "the SW's live objects are caches, not sources of truth"). It exists because the
// content script re-fires LOOKUP on every SPA navigation AND every DOM-settle (observer.ts), so viewing one
// profile, or bouncing between two, used to hit /contacts/lookup once per signal with no coalescing.
//
// Two guarantees:
//   1. Single-flight — concurrent LOOKUPs for the same subject (the nav + the settle that follows it) await
//      ONE request instead of racing two.
//   2. Warm TTL — a repeat LOOKUP for the same subject inside the window returns the last result with no
//      network call.
//
// Correctness rules that keep this from ever showing stale truth:
//   - Memory-only. It dies with the service worker; a cold worker just re-resolves. There is no durable tier
//     to fall out of sync with — a miss is always the safe outcome.
//   - Successes only. A failed resolution (offline / signed-out → the bus's "unknown" default) is NEVER
//     cached, so a transient blip can't stick for the whole window.
//   - Cleared on mutation. Any action that could change what a lookup returns (capture, add-to-workspace,
//     reveal, workspace/org switch, sign-out) invalidates the affected key or the whole cache in the bus
//     router — so the next LOOKUP re-resolves against the truth.
//
// GENERIC over the cached value (defaulting to SubjectStatus, so every existing call site is unchanged): the
// Profile Intelligence Panel's intel read wants exactly the same coalescing and the same invalidation points,
// and a second copy of this logic would drift from the first the moment one of them gained a rule.
import type { SubjectStatus } from "../../shared/types.ts";

const DEFAULT_TTL_MS = 60_000;
// A safety valve, not a real bound: the worker is killed within ~30s of idle, so entries rarely accumulate.
// An active Sales-Nav session could view many profiles before that, so cap the map and evict oldest-first.
const MAX_ENTRIES = 200;

interface Entry<T> {
  status: T;
  at: number;
}

export class LookupCache<T = SubjectStatus> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /** Return a fresh cached status, or the in-flight request for this key, or start `fetcher` and remember its
   *  success. `now` is injectable so the TTL is testable without fake timers (matches captureQueue.due). A
   *  rejected `fetcher` is propagated and NOT cached — the caller decides how to degrade. */
  async resolve(key: string, fetcher: () => Promise<T>, now: number = Date.now()): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.status;

    // A stale entry with a refresh already running: prefer the in-flight fresh result over serving stale.
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const pending = fetcher();
    this.inflight.set(key, pending);
    try {
      const status = await pending;
      this.remember(key, status, now);
      return status;
    } finally {
      this.inflight.delete(key);
    }
  }

  private remember(key: string, status: T, now: number): void {
    this.entries.set(key, { status, at: now });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Drop one subject (used when we know exactly which subject an action changed, e.g. a capture). */
  invalidate(key: string): void {
    this.entries.delete(key);
  }

  /** Drop everything (used when an action's affected subject isn't cleanly known — reveal/add — or the whole
   *  scope changed — workspace/org switch, sign-out). In-flight requests are left to settle; they simply
   *  re-populate a now-empty cache, which is correct. */
  clear(): void {
    this.entries.clear();
  }
}
