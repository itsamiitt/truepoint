// warmup.test.ts — the warmup ramp schedule (M12 P5). Pure, runs without infra. Proves the ramp starts low,
// climbs monotonically, and saturates at the steady-state cap (never jumps a cold identity to full volume).

import { describe, expect, test } from "bun:test";
import { isWarmupComplete, warmupDailyTarget } from "./warmup.ts";

describe("warmupDailyTarget", () => {
  test("day 0 is the start cap", () => {
    expect(warmupDailyTarget(0)).toBe(20);
    expect(warmupDailyTarget(-5)).toBe(20);
  });

  test("saturates at the full cap on/after rampDays", () => {
    expect(warmupDailyTarget(30)).toBe(200);
    expect(warmupDailyTarget(100)).toBe(200);
  });

  test("climbs monotonically between start and cap", () => {
    let prev = warmupDailyTarget(0);
    for (let d = 1; d <= 30; d++) {
      const v = warmupDailyTarget(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(200);
      prev = v;
    }
  });

  test("honors a custom schedule", () => {
    expect(warmupDailyTarget(0, { startPerDay: 5, capPerDay: 50, rampDays: 10 })).toBe(5);
    expect(warmupDailyTarget(10, { startPerDay: 5, capPerDay: 50, rampDays: 10 })).toBe(50);
    expect(warmupDailyTarget(5, { startPerDay: 5, capPerDay: 50, rampDays: 10 })).toBe(28);
  });

  test("isWarmupComplete flips at rampDays", () => {
    expect(isWarmupComplete(29)).toBe(false);
    expect(isWarmupComplete(30)).toBe(true);
  });
});
