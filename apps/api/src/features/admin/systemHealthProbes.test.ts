// systemHealthProbes.test.ts — unit coverage for the PURE redis/workers derivation behind GET
// /admin/system-health (plan B2). The fan-out (probeQueues) does Redis I/O so it is exercised by the
// route + CI; deriveServiceHealth is the threshold logic and is the part with edge cases worth guarding
// here: Redis-down → unknown workers (never fabricated), and worker liveness is ANY-queue not a sum.

import { describe, expect, test } from "bun:test";
import { type QueueReport, deriveServiceHealth } from "./systemHealthProbes.ts";

// Only `reachable` + `workers` drive the derivation; counts are irrelevant to it, so they are zeroed
// (reachable) or null (unreachable — matching how probeQueues reports a failed probe).
function q(reachable: boolean, workers: number | null): QueueReport {
  return reachable
    ? { name: "x", waiting: 0, active: 0, failed: 0, delayed: 0, workers, reachable: true }
    : { name: "x", waiting: null, active: null, failed: null, delayed: null, workers: null, reachable: false };
}

describe("deriveServiceHealth", () => {
  test("no queue reachable (Redis down) → redis down, workers unknown (not fabricated)", () => {
    expect(deriveServiceHealth([q(false, null), q(false, null)])).toEqual({
      redis: "down",
      workers: "unknown",
    });
  });

  test("empty input → redis down, workers unknown", () => {
    expect(deriveServiceHealth([])).toEqual({ redis: "down", workers: "unknown" });
  });

  test("a reachable queue with a connected worker → redis up, workers up", () => {
    expect(deriveServiceHealth([q(true, 1), q(false, null)])).toEqual({
      redis: "up",
      workers: "up",
    });
  });

  test("reachable queues but zero workers anywhere → redis up, workers down", () => {
    expect(deriveServiceHealth([q(true, 0), q(true, 0)])).toEqual({
      redis: "up",
      workers: "down",
    });
  });

  test("any single reachable queue with a worker flips workers up (any-queue, not a sum)", () => {
    expect(deriveServiceHealth([q(true, 0), q(true, 2)])).toEqual({
      redis: "up",
      workers: "up",
    });
  });

  test("reachable with a null worker count is treated as zero", () => {
    expect(deriveServiceHealth([q(true, null)])).toEqual({ redis: "up", workers: "down" });
  });
});
