// tokenBucket.ts — a pure token-bucket rate limiter (M12 P1, WARM-001). One step of the algorithm: refill by
// elapsed time (capped at capacity), then consume `cost` if available. Deterministic — `nowMs` and prior state
// are passed in, so it is fully unit-testable and the SAME math runs in the Redis Lua adapter (apps/workers).
// Used per-mailbox to cap the send burst rate that would otherwise scorch a sending reputation.

export interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export interface BucketConfig {
  /** Max tokens (the burst ceiling). */
  capacity: number;
  /** Tokens added per second (the steady-state rate). */
  refillPerSec: number;
}

export interface BucketResult {
  allowed: boolean;
  state: BucketState;
  /** When denied, the ms until `cost` tokens would be available; 0 when allowed. */
  retryAfterMs: number;
}

/** Refill-then-consume one step. `prev === null` starts a full bucket (first use is never throttled). */
export function consumeToken(
  prev: BucketState | null,
  cfg: BucketConfig,
  nowMs: number,
  cost = 1,
): BucketResult {
  const base = prev ?? { tokens: cfg.capacity, lastRefillMs: nowMs };
  const elapsedSec = Math.max(0, (nowMs - base.lastRefillMs) / 1000);
  const tokens = Math.min(cfg.capacity, base.tokens + elapsedSec * cfg.refillPerSec);

  if (tokens >= cost) {
    return {
      allowed: true,
      state: { tokens: tokens - cost, lastRefillMs: nowMs },
      retryAfterMs: 0,
    };
  }
  const deficit = cost - tokens;
  const retryAfterMs =
    cfg.refillPerSec > 0
      ? Math.ceil((deficit / cfg.refillPerSec) * 1000)
      : Number.POSITIVE_INFINITY;
  return { allowed: false, state: { tokens, lastRefillMs: nowMs }, retryAfterMs };
}
