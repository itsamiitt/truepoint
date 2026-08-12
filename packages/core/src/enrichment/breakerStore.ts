// breakerStore.ts — the circuit-breaker PORT for the enrichment waterfall (06 §4; waterfall v2 / 0109).
// core owns the port; the production Redis implementation lives in packages/integrations
// (redisBreakerStore, modeled on redisCrmBudgetStore) because workers are horizontally scaled — a
// process-local breaker lets N workers each burn the full error budget before any breaker opens (the
// exact reason waterfall.ts:4 flagged its Map as a follow-up). The in-memory default keeps unit tests
// hermetic and the (flag-retired) inline API path dependency-free.
//
// Failure posture is asymmetric ON PURPOSE:
//   • isOpen() read errors FAIL OPEN (allow the call) — a Redis blip must not halt all enrichment; the
//     provider's own errors still count against it on the next successful record().
//   • record() errors are swallowed — breaker bookkeeping must never fail a paid, already-made call.
// That asymmetry is implemented by the CALLER (fieldWaterfall) so every store stays a dumb counter.

export interface BreakerStore {
  /** Is the provider's circuit open right now? (Half-open probing is the store's concern.) */
  isOpen(provider: string): Promise<boolean>;
  /** Record a call outcome. ok = the provider ANSWERED (hit or miss); rate_limited/error are failures. */
  record(provider: string, ok: boolean): Promise<void>;
}

const DEFAULT_THRESHOLD = 3; // consecutive failures → open (the waterfall.ts constant, unchanged)
const DEFAULT_COOLDOWN_MS = 60_000; // half-open probe after cooldown

interface BreakerState {
  consecutiveErrors: number;
  openedAt: number | null;
}

/**
 * Per-process breaker — the exact semantics waterfall.ts shipped (threshold 3, 60s cooldown, half-open
 * probe by letting the first post-cooldown call through). Suitable for tests and single-process runs.
 */
export function inMemoryBreakerStore(
  threshold = DEFAULT_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now: () => number = Date.now,
): BreakerStore {
  const states = new Map<string, BreakerState>();
  const stateFor = (name: string): BreakerState => {
    let s = states.get(name);
    if (!s) {
      s = { consecutiveErrors: 0, openedAt: null };
      states.set(name, s);
    }
    return s;
  };
  return {
    isOpen(provider) {
      const s = stateFor(provider);
      if (s.openedAt === null) return Promise.resolve(false);
      if (now() - s.openedAt >= cooldownMs) return Promise.resolve(false); // half-open probe
      return Promise.resolve(true);
    },
    record(provider, ok) {
      const s = stateFor(provider);
      if (ok) {
        s.consecutiveErrors = 0;
        s.openedAt = null;
      } else {
        s.consecutiveErrors += 1;
        if (s.consecutiveErrors >= threshold) s.openedAt = now();
      }
      return Promise.resolve();
    },
  };
}
