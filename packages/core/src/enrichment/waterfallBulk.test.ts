// waterfallBulk.test.ts — the additive bulk / parallel-cheap waterfall (06 §4; 31 §4). Cheap providers race
// in parallel (the best-trust hit wins); on a cheap-batch miss the expensive providers run sequentially.
// Asserts the parallel fan-out, best-trust selection, sequential fallthrough, full attempt accounting, and
// that open breakers are skipped. runWaterfall (single-call) is covered separately and is left unchanged.

import { beforeEach, describe, expect, test } from "bun:test";
import type { EnrichRequest, EnrichmentProvider, ProviderResult } from "./providerPort.ts";
import { recordOutcome, resetBreakers, runWaterfallBulk } from "./waterfall.ts";

const REQ: EnrichRequest = {
  workspaceId: "11111111-1111-1111-1111-111111111111",
  entityType: "contact",
  fields: ["email"],
  subject: { companyDomain: "acme.com" },
};

const CHEAP_THRESHOLD = 50_000;

function fake(
  name: string,
  trust: number,
  cost: number,
  status: ProviderResult["status"],
  log: { calls: string[] },
): EnrichmentProvider {
  return {
    name,
    trust,
    capabilities: ["contact.email"],
    estimateCostMicros: () => cost,
    enrich: () => {
      log.calls.push(name);
      return Promise.resolve({
        fields: status === "hit" ? [{ field: "email", value: "x@acme.com" }] : [],
        rawPayload: { from: name },
        costMicros: status === "hit" || status === "miss" ? cost : 0,
        status,
      });
    },
  };
}

beforeEach(resetBreakers);

describe("runWaterfallBulk (06 §4 parallel-cheap)", () => {
  test("races the cheap batch in parallel and returns the best hit", async () => {
    const log = { calls: [] as string[] };
    const cheapA = fake("cheapA", 0.5, 10_000, "hit", log);
    const cheapB = fake("cheapB", 0.9, 10_000, "hit", log); // higher score at equal cost → wins
    const outcome = await runWaterfallBulk([cheapA, cheapB], REQ, {
      cheapCostThresholdMicros: CHEAP_THRESHOLD,
    });
    expect(outcome.provider).toBe("cheapB");
    // BOTH cheap providers were called (parallel fan-out), not short-circuited like the sequential waterfall.
    expect(log.calls.sort()).toEqual(["cheapA", "cheapB"]);
    expect(outcome.attempts.map((a) => a.provider).sort()).toEqual(["cheapA", "cheapB"]);
  });

  test("among cheap hits, the best trust ÷ cost wins — not raw trust (cost discipline on the residual)", async () => {
    const log = { calls: [] as string[] };
    // dear has higher raw trust but worse trust÷cost; lean is cheaper with near-equal trust → better score.
    const dear = fake("dear", 0.9, 40_000, "hit", log); // 0.9/40k = 2.25e-5
    const lean = fake("lean", 0.8, 5_000, "hit", log); // 0.8/5k  = 1.6e-4  → wins
    const outcome = await runWaterfallBulk([dear, lean], REQ, {
      cheapCostThresholdMicros: CHEAP_THRESHOLD,
    });
    expect(outcome.provider).toBe("lean");
  });

  test("on a cheap-batch miss, falls through to the expensive providers sequentially (first hit wins)", async () => {
    const log = { calls: [] as string[] };
    const cheapMiss = fake("cheapMiss", 0.9, 10_000, "miss", log);
    const expHit = fake("expHit", 0.9, 80_000, "hit", log);
    const expHit2 = fake("expHit2", 0.9, 90_000, "hit", log);
    const outcome = await runWaterfallBulk([cheapMiss, expHit, expHit2], REQ, {
      cheapCostThresholdMicros: CHEAP_THRESHOLD,
    });
    expect(outcome.provider).toBe("expHit");
    // expHit2 is never reached — the sequential expensive tier short-circuits on the first hit.
    expect(log.calls).not.toContain("expHit2");
    expect(outcome.attempts.map((a) => a.provider)).toEqual(["cheapMiss", "expHit"]);
  });

  test("a cheap hit short-circuits before any expensive provider is called", async () => {
    const log = { calls: [] as string[] };
    const cheapHit = fake("cheapHit", 0.8, 5_000, "hit", log);
    const expensive = fake("expensive", 0.99, 80_000, "hit", log);
    const outcome = await runWaterfallBulk([cheapHit, expensive], REQ, {
      cheapCostThresholdMicros: CHEAP_THRESHOLD,
    });
    expect(outcome.provider).toBe("cheapHit");
    expect(log.calls).toEqual(["cheapHit"]); // expensive provider untouched
  });

  test("all miss → no provider, every attempt recorded for cost accounting", async () => {
    const log = { calls: [] as string[] };
    const cheap = fake("cheap", 0.9, 10_000, "miss", log);
    const expensive = fake("expensive", 0.9, 80_000, "miss", log);
    const outcome = await runWaterfallBulk([cheap, expensive], REQ, {
      cheapCostThresholdMicros: CHEAP_THRESHOLD,
    });
    expect(outcome.provider).toBeNull();
    expect(outcome.result).toBeNull();
    expect(outcome.attempts.map((a) => a.provider).sort()).toEqual(["cheap", "expensive"]);
  });

  test("skips providers whose breaker is open", async () => {
    recordOutcome("flaky", false);
    recordOutcome("flaky", false);
    recordOutcome("flaky", false); // breaker open

    const log = { calls: [] as string[] };
    const flaky = fake("flaky", 0.99, 1, "hit", log); // cheap + best trust, but open → skipped
    const backup = fake("backup", 0.5, 10_000, "hit", log);
    const outcome = await runWaterfallBulk([flaky, backup], REQ, {
      cheapCostThresholdMicros: CHEAP_THRESHOLD,
    });
    expect(outcome.provider).toBe("backup");
    expect(log.calls).toEqual(["backup"]);
  });

  test("a thrown adapter error becomes a zero-cost error attempt, not a throw", async () => {
    const log = { calls: [] as string[] };
    const thrower: EnrichmentProvider = {
      name: "thrower",
      trust: 0.9,
      capabilities: ["contact.email"],
      estimateCostMicros: () => 10_000,
      enrich: () => {
        log.calls.push("thrower");
        return Promise.reject(new Error("boom"));
      },
    };
    const backup = fake("backup", 0.5, 80_000, "hit", log);
    const outcome = await runWaterfallBulk([thrower, backup], REQ, {
      cheapCostThresholdMicros: CHEAP_THRESHOLD,
    });
    expect(outcome.provider).toBe("backup");
    const throwerAttempt = outcome.attempts.find((a) => a.provider === "thrower");
    expect(throwerAttempt).toEqual({ provider: "thrower", status: "error", costMicros: 0 });
  });
});
