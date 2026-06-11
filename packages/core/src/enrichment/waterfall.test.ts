// waterfall.test.ts — ordering (trust ÷ cost), first-hit short-circuit, and the per-provider circuit
// breaker opening after consecutive errors (06 §4/§6).

import { beforeEach, describe, expect, test } from "bun:test";
import type { EnrichRequest, EnrichmentProvider, ProviderResult } from "./providerPort.ts";
import {
  breakerOpen,
  orderProviders,
  recordOutcome,
  resetBreakers,
  runWaterfall,
} from "./waterfall.ts";

const REQ: EnrichRequest = {
  workspaceId: "11111111-1111-1111-1111-111111111111",
  entityType: "contact",
  fields: ["email"],
  subject: { companyDomain: "acme.com" },
};

function fake(
  name: string,
  trust: number,
  cost: number,
  status: ProviderResult["status"],
  calls: string[],
): EnrichmentProvider {
  return {
    name,
    trust,
    capabilities: ["contact.email"],
    estimateCostMicros: () => cost,
    enrich: () => {
      calls.push(name);
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

describe("waterfall (06 §4)", () => {
  test("orders by trust ÷ cost and stops at the first hit", async () => {
    const calls: string[] = [];
    const cheapButWeak = fake("cheap", 0.4, 10_000, "miss", calls); // 0.4/10k = 4e-5
    const strongValue = fake("strong", 0.9, 20_000, "hit", calls); // 0.9/20k = 4.5e-5 → first
    const expensive = fake("expensive", 0.9, 90_000, "hit", calls);

    expect(orderProviders([cheapButWeak, expensive, strongValue], REQ).map((p) => p.name)).toEqual([
      "strong",
      "cheap",
      "expensive",
    ]);

    const outcome = await runWaterfall([cheapButWeak, expensive, strongValue], REQ);
    expect(outcome.provider).toBe("strong");
    expect(calls).toEqual(["strong"]); // short-circuit: nobody after the hit is called
  });

  test("misses fall through; total attempts are reported for cost accounting", async () => {
    const calls: string[] = [];
    const a = fake("a", 0.9, 10_000, "miss", calls);
    const b = fake("b", 0.5, 10_000, "hit", calls);
    const outcome = await runWaterfall([a, b], REQ);
    expect(outcome.provider).toBe("b");
    expect(outcome.attempts.map((x) => x.provider)).toEqual(["a", "b"]);
  });

  test("the breaker opens after consecutive errors and the waterfall skips the open provider", async () => {
    recordOutcome("flaky", false);
    recordOutcome("flaky", false);
    recordOutcome("flaky", false);
    expect(breakerOpen("flaky")).toBe(true);

    const calls: string[] = [];
    const flaky = fake("flaky", 0.99, 1, "hit", calls); // best score, but open
    const backup = fake("backup", 0.5, 10_000, "hit", calls);
    const outcome = await runWaterfall([flaky, backup], REQ);
    expect(outcome.provider).toBe("backup");
    expect(calls).toEqual(["backup"]);
  });

  test("a success closes the breaker again", () => {
    recordOutcome("p", false);
    recordOutcome("p", false);
    recordOutcome("p", false);
    expect(breakerOpen("p")).toBe(true);
    recordOutcome("p", true);
    expect(breakerOpen("p")).toBe(false);
  });
});
