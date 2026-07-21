import { describe, expect, test } from "bun:test";
import {
  type ErasureStep,
  capacityPlan,
  classifyAlerts,
  desiredWorkers,
  freshnessBreached,
  isPiiFree,
  planErasure,
  reachesAllLayers,
  renderPrometheus,
} from "../src/index.ts";

describe("observability (15)", () => {
  test("renderPrometheus emits labelled samples", () => {
    const text = renderPrometheus([
      { name: "forge_parse_total", value: 5, labels: { stage: "parse" } },
      { name: "forge_queue_depth", value: 3 },
    ]);
    expect(text).toContain('forge_parse_total{stage="parse"} 5');
    expect(text).toContain("forge_queue_depth 3");
  });

  test("freshness SLO breaches when lag exceeds budget", () => {
    expect(freshnessBreached(61_000, 60_000)).toBe(true);
    expect(freshnessBreached(200, 300)).toBe(false);
  });

  test("alerts fire on symptoms, not a single transient retry (OQ-R20)", () => {
    expect(classifyAlerts({ retriesExhausted: 0, queueDepth: 10, queueDepthPrev: 10 })).toEqual([]);
    expect(
      classifyAlerts({
        retriesExhausted: 3,
        queueDepth: 40,
        queueDepthPrev: 10,
        groundingCoverage: 0.5,
      }),
    ).toEqual(["retry_exhaustion", "backlog_growth", "grounding_drop"]);
  });

  test("autoscale on queue depth/load, scale-to-zero when idle", () => {
    expect(desiredWorkers(0, 0, 4, { min: 0, max: 10 })).toBe(0);
    expect(desiredWorkers(10, 30, 4, { min: 1, max: 10 })).toBe(10); // ceil(40/4)=10
    expect(desiredWorkers(2, 2, 4, { min: 1, max: 10 })).toBe(1);
  });
});

describe("DSAR cross-layer erasure (14/15)", () => {
  test("the plan reaches every layer and is PII-free (keyed on the blind index)", () => {
    const steps: ErasureStep[] = planErasure("bi-abc");
    expect(reachesAllLayers(steps)).toBe(true);
    expect(isPiiFree(steps, "bi-abc")).toBe(true);
  });

  test("a plan missing a layer is non-compliant", () => {
    const partial: ErasureStep[] = [{ layer: "raw_captures", action: "tombstone", key: "bi" }];
    expect(reachesAllLayers(partial)).toBe(false);
  });
});

describe("capacity model (17)", () => {
  test("sizes worker fleets from the capture rate", () => {
    const plan = capacityPlan(
      { capturesPerDay: 8_640_000, avgPayloadBytes: 2048 },
      { parsePerSec: 50, extractPerSec: 2, syncPerSec: 100 },
    );
    expect(plan.capturesPerSec).toBe(100); // 8.64M/day = 100/s
    expect(plan.parseWorkers).toBe(2); // ceil(100/50)
    expect(plan.extractWorkers).toBe(50); // ceil(100/2)
    expect(plan.rawStorageBytesPerDay).toBe(8_640_000 * 2048);
  });
});
