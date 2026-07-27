// readiness.test.ts — proves the two properties that make a readiness probe safe rather than harmful:
// it is BOUNDED (a wedged dependency resolves false instead of hanging) and THRESHOLDED (a single blip does
// not de-rotate a healthy replica). Both are failure modes that only show up under load, so they are pinned
// here rather than discovered in an incident.
//
// dbReadinessProbe itself is not unit-tested — it needs a real Postgres, and CI's itests already exercise the
// pool it probes. What is tested is the gate logic wrapped around any probe, which is where the sharp edges
// are.

import { describe, expect, test } from "bun:test";
import { DEFAULT_PROBE_FAILURE_THRESHOLD, boundedProbe, createReadinessGate } from "./readiness.ts";

const alwaysUp = async () => true;
const alwaysDown = async () => false;

describe("boundedProbe", () => {
  test("true when the work resolves in time", async () => {
    expect(await boundedProbe(1_000, async () => "ok")).toBe(true);
  });

  test("false — not a hang — when the dependency never answers", async () => {
    // The failure mode this exists for: a wedged Postgres leaves the query pending forever. If the probe
    // waited with it, /ready would hang and the process would look fine until the orchestrator's own timeout
    // fired. Bounding it turns "unknown" into a definite no.
    const started = performance.now();
    expect(await boundedProbe(50, () => new Promise(() => {}))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("false when the work rejects", async () => {
    expect(
      await boundedProbe(1_000, async () => {
        throw new Error("ECONNREFUSED");
      }),
    ).toBe(false);
  });

  test("an abandoned probe's later rejection does not become an unhandled rejection", async () => {
    // A query that loses the race and rejects afterwards must be swallowed. Otherwise the health endpoint is
    // itself a way to crash the process — exactly backwards.
    let reject: (e: Error) => void = () => {};
    const work = () =>
      new Promise((_resolve, rej) => {
        reject = rej;
      });
    expect(await boundedProbe(20, work)).toBe(false);
    reject(new Error("connection terminated after the probe gave up"));
    // Give the rejection a turn to surface; the test process must survive it.
    await new Promise((r) => setTimeout(r, 20));
    expect(true).toBe(true);
  });
});

describe("createReadinessGate", () => {
  test("ready when not draining and the probe succeeds", async () => {
    const gate = createReadinessGate({ isDraining: () => false, probe: alwaysUp });
    expect(await gate()).toEqual({ ready: true });
  });

  test("draining short-circuits before the probe runs", async () => {
    // A draining process must shed traffic at once — not after N failures, and without spending a probe on a
    // database it is about to disconnect from.
    let probed = 0;
    const gate = createReadinessGate({
      isDraining: () => true,
      probe: async () => {
        probed++;
        return true;
      },
    });
    expect(await gate()).toEqual({ ready: false, reason: "draining" });
    expect(probed).toBe(0);
  });

  test("drain state is read per request, not captured once", async () => {
    let draining = false;
    const gate = createReadinessGate({ isDraining: () => draining, probe: alwaysUp });
    expect(await gate()).toEqual({ ready: true });
    draining = true;
    expect(await gate()).toEqual({ ready: false, reason: "draining" });
  });

  test("COLD START: a process that has never been ready reports not-ready on the FIRST failure", async () => {
    // The threshold must not apply before the first success. An orchestrator needs only ONE healthy probe to
    // mark the container up and release everything gated on it (compose has web/admin waiting on
    // `api: service_healthy`), so tolerating early failures would let an API that cannot reach Postgres
    // announce itself as serving — and take its dependents up with it.
    const gate = createReadinessGate({
      isDraining: () => false,
      probe: alwaysDown,
      failureThreshold: 3,
    });
    expect(await gate()).toEqual({ ready: false, reason: "database" });
    expect(await gate()).toEqual({ ready: false, reason: "database" });
  });

  test("COLD START: becomes ready as soon as the dependency answers", async () => {
    let up = false;
    const gate = createReadinessGate({
      isDraining: () => false,
      probe: async () => up,
      failureThreshold: 3,
    });
    expect(await gate()).toEqual({ ready: false, reason: "database" });
    up = true;
    expect(await gate()).toEqual({ ready: true });
  });

  test("after a first success, a single failure does NOT flip readiness (no blip-flap)", async () => {
    // The point of the threshold: if one failed probe de-rotated a replica, a brief hiccup would pull every
    // replica out of rotation at once, since they all probe on the same interval.
    let up = true;
    const gate = createReadinessGate({
      isDraining: () => false,
      probe: async () => up,
      failureThreshold: 3,
    });
    expect(await gate()).toEqual({ ready: true }); // earns the benefit of the doubt
    up = false;
    expect(await gate()).toEqual({ ready: true });
    expect(await gate()).toEqual({ ready: true });
    expect(await gate()).toEqual({ ready: false, reason: "database" });
  });

  test("a success resets the failure streak", async () => {
    let up = true;
    const gate = createReadinessGate({
      isDraining: () => false,
      probe: async () => up,
      failureThreshold: 3,
    });
    await gate(); // first success — threshold now active
    up = false;
    await gate(); // fail 1
    await gate(); // fail 2
    up = true;
    expect(await gate()).toEqual({ ready: true }); // streak resets here
    up = false;
    // Without the reset these two would already have crossed the threshold.
    expect(await gate()).toEqual({ ready: true });
    expect(await gate()).toEqual({ ready: true });
    expect(await gate()).toEqual({ ready: false, reason: "database" });
  });

  test("stays not-ready while the dependency stays down", async () => {
    const gate = createReadinessGate({
      isDraining: () => false,
      probe: alwaysDown,
      failureThreshold: 2,
    });
    for (let i = 0; i < 4; i++) {
      expect(await gate()).toEqual({ ready: false, reason: "database" });
    }
  });

  test("a THROWING probe counts as a failure, never a crash", async () => {
    // A probe that rejects must be indistinguishable from one that resolves false — otherwise a driver error
    // propagates out of the health endpoint and takes down the thing that was supposed to report the problem.
    let boom = false;
    const gate = createReadinessGate({
      isDraining: () => false,
      probe: async () => {
        if (boom) throw new Error("connection terminated unexpectedly");
        return true;
      },
      failureThreshold: 2,
    });
    expect(await gate()).toEqual({ ready: true });
    boom = true;
    expect(await gate()).toEqual({ ready: true });
    expect(await gate()).toEqual({ ready: false, reason: "database" });
  });

  test("defaults to the shared threshold (parity with apps/workers)", async () => {
    expect(DEFAULT_PROBE_FAILURE_THRESHOLD).toBe(3);
    let up = true;
    const gate = createReadinessGate({ isDraining: () => false, probe: async () => up });
    await gate();
    up = false;
    for (let i = 1; i < DEFAULT_PROBE_FAILURE_THRESHOLD; i++) {
      expect(await gate()).toEqual({ ready: true });
    }
    expect(await gate()).toEqual({ ready: false, reason: "database" });
  });

  test("draining wins over a healthy dependency", async () => {
    const gate = createReadinessGate({ isDraining: () => true, probe: alwaysUp });
    expect(await gate()).toEqual({ ready: false, reason: "draining" });
  });
});
