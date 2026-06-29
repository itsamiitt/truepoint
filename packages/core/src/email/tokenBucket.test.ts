// tokenBucket.test.ts — the pure token-bucket math (M12 P1, WARM-001). Deterministic (nowMs injected).

import { describe, expect, it } from "bun:test";
import { type BucketConfig, consumeToken } from "./tokenBucket.ts";

const CFG: BucketConfig = { capacity: 5, refillPerSec: 1 }; // 5 burst, 1/sec steady

describe("consumeToken", () => {
  it("starts full — the first send is never throttled", () => {
    const r = consumeToken(null, CFG, 1_000);
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBe(4);
    expect(r.retryAfterMs).toBe(0);
  });

  it("drains the burst, then denies with a retry delay", () => {
    let state = consumeToken(null, CFG, 0).state; // 4 left
    for (let i = 0; i < 4; i++) state = consumeToken(state, CFG, 0).state; // drain to 0 at the same instant
    const denied = consumeToken(state, CFG, 0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(1000); // 1 token / 1 per sec = 1s
  });

  it("refills by elapsed time and allows again", () => {
    // Drain to empty at t=0.
    let state = { tokens: 0, lastRefillMs: 0 };
    const tooSoon = consumeToken(state, CFG, 500); // 0.5s → 0.5 tokens < 1
    expect(tooSoon.allowed).toBe(false);
    // After 1s a whole token is available.
    state = { tokens: 0, lastRefillMs: 0 };
    const ok = consumeToken(state, CFG, 1_000);
    expect(ok.allowed).toBe(true);
  });

  it("caps refill at capacity (no unbounded accrual while idle)", () => {
    const r = consumeToken({ tokens: 5, lastRefillMs: 0 }, CFG, 1_000_000);
    expect(r.allowed).toBe(true);
    expect(r.state.tokens).toBe(4); // refilled to cap (5), then consumed 1
  });

  it("treats a zero refill rate as a hard cap (infinite retry once drained)", () => {
    const denied = consumeToken(
      { tokens: 0, lastRefillMs: 0 },
      { capacity: 3, refillPerSec: 0 },
      10_000,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });
});
