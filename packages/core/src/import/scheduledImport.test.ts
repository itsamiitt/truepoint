// scheduledImport.test.ts — T-P5's pure decision-core matrix (import-and-data-model-redesign 08 §9): the
// cadence math (skip-missed-windows, never backfill), the idempotency-key derivation (window-floored so a
// ms jitter can't split one window into two keys), and the fire-time grant re-eval (a null/absent-role
// creator is a hard loss). No I/O — the sweep's orchestration composes these, so proving them in isolation
// pins every rule the leader-locked fire depends on.

import { describe, expect, test } from "bun:test";
import {
  computeNextRunAt,
  deriveScheduleIdempotencyKey,
  evaluateScheduleFireGrant,
} from "./scheduledImport.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe("computeNextRunAt — cadence grid + skip-missed-windows (08 §9)", () => {
  test("advances by ONE whole interval when the next grid instant is still in the future", () => {
    const fired = new Date("2026-07-01T00:00:00.000Z");
    const now = new Date("2026-07-01T00:30:00.000Z"); // half an hour after firing
    expect(computeNextRunAt(fired, "hourly", now).toISOString()).toBe("2026-07-01T01:00:00.000Z");
  });

  test("per-cadence intervals: hourly / daily / weekly", () => {
    const fired = new Date("2026-07-01T00:00:00.000Z");
    const now = fired; // now == fired ⇒ exactly one interval out
    expect(computeNextRunAt(fired, "hourly", now).getTime()).toBe(fired.getTime() + HOUR);
    expect(computeNextRunAt(fired, "daily", now).getTime()).toBe(fired.getTime() + DAY);
    expect(computeNextRunAt(fired, "weekly", now).getTime()).toBe(fired.getTime() + WEEK);
  });

  test("SKIPS missed windows (a worker outage never unleashes a catch-up storm)", () => {
    const fired = new Date("2026-07-01T00:00:00.000Z");
    // 5.5 hours later: windows 01:00…05:00 were all missed ⇒ jump to the first grid instant AFTER now.
    const now = new Date("2026-07-01T05:30:00.000Z");
    expect(computeNextRunAt(fired, "hourly", now).toISOString()).toBe("2026-07-01T06:00:00.000Z");
  });

  test("stays aligned to the fired-window grid across a long outage", () => {
    const fired = new Date("2026-07-01T00:00:00.000Z");
    const now = new Date("2026-07-10T13:37:00.000Z"); // days later, off-grid
    const next = computeNextRunAt(fired, "daily", now);
    // On the daily grid anchored at 00:00, and strictly after now.
    expect((next.getTime() - fired.getTime()) % DAY).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.toISOString()).toBe("2026-07-11T00:00:00.000Z");
  });

  test("the result is ALWAYS strictly greater than both fired-window and now", () => {
    const fired = new Date("2026-07-01T00:00:00.000Z");
    for (const now of [fired, new Date(fired.getTime() + 1), new Date(fired.getTime() + 3 * WEEK)]) {
      const next = computeNextRunAt(fired, "weekly", now);
      expect(next.getTime()).toBeGreaterThan(fired.getTime());
      expect(next.getTime()).toBeGreaterThan(now.getTime());
    }
  });
});

describe("deriveScheduleIdempotencyKey — window-floored, per-schedule (08 §9)", () => {
  const id = "11111111-1111-7111-8111-111111111111";

  test("format: sched:<scheduleId>:<windowSeconds>", () => {
    const w = new Date("2026-07-01T00:00:00.000Z");
    expect(deriveScheduleIdempotencyKey(id, w)).toBe(`sched:${id}:${Math.floor(w.getTime() / 1000)}`);
  });

  test("millisecond jitter within the same second yields the SAME key (one window, one job)", () => {
    const base = new Date("2026-07-01T00:00:00.000Z");
    const jittered = new Date(base.getTime() + 999); // same whole second
    expect(deriveScheduleIdempotencyKey(id, jittered)).toBe(deriveScheduleIdempotencyKey(id, base));
  });

  test("a different window ⇒ a different key (a fresh run each cadence tick)", () => {
    const w1 = new Date("2026-07-01T00:00:00.000Z");
    const w2 = new Date("2026-07-01T01:00:00.000Z");
    expect(deriveScheduleIdempotencyKey(id, w1)).not.toBe(deriveScheduleIdempotencyKey(id, w2));
  });

  test("a different schedule ⇒ a different key (cross-schedule collisions impossible)", () => {
    const w = new Date("2026-07-01T00:00:00.000Z");
    const other = "22222222-2222-7222-8222-222222222222";
    expect(deriveScheduleIdempotencyKey(id, w)).not.toBe(deriveScheduleIdempotencyKey(other, w));
  });
});

describe("evaluateScheduleFireGrant — fire-time grant re-eval (08 §9 / 10 §2)", () => {
  test("a null role (deleted/departed creator) is a HARD loss", () => {
    expect(evaluateScheduleFireGrant(null, "member")).toBe("insufficient_role");
    expect(evaluateScheduleFireGrant(null, "admin")).toBe("insufficient_role");
  });

  test("a viewer can never fire (read-only role product-wide)", () => {
    expect(evaluateScheduleFireGrant("viewer", "member")).toBe("insufficient_role");
    expect(evaluateScheduleFireGrant("viewer", "admin")).toBe("insufficient_role");
  });

  test("a member fires under the broad default, is denied under an admin-only policy", () => {
    expect(evaluateScheduleFireGrant("member", "member")).toBe("ok");
    expect(evaluateScheduleFireGrant("member", "admin")).toBe("disabled_by_policy");
  });

  test("admin / owner fire under either policy", () => {
    for (const policy of ["member", "admin"] as const) {
      expect(evaluateScheduleFireGrant("admin", policy)).toBe("ok");
      expect(evaluateScheduleFireGrant("owner", policy)).toBe("ok");
    }
  });
});
