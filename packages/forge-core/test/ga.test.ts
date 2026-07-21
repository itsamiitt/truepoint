import { describe, expect, test } from "bun:test";
import {
  type GaReadiness,
  canaryDecision,
  enableTenant,
  evaluateGaReadiness,
  isLiveForTenant,
  newCanaryState,
} from "../src/index.ts";

const READY: GaReadiness = {
  dpiaSigned: true,
  liaSigned: true,
  art14NoticeReady: true,
  singlePurposeDeclared: true,
  dpdpConsentPosture: true,
  testsGreen: true,
  killSwitchArmed: true,
  darkConnectorRetired: true,
};

describe("GA readiness gate (P9, OQ-2)", () => {
  test("all preconditions → ready", () => {
    expect(evaluateGaReadiness(READY)).toEqual({ ready: true, blockers: [] });
  });

  test("an unsigned DPIA blocks GA (legal sign-off is not a planning decision)", () => {
    const r = evaluateGaReadiness({ ...READY, dpiaSigned: false });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain("dpia_unsigned");
  });
});

describe("per-tenant canary (never global, G-FORGE-1905)", () => {
  test("cannot enable a tenant until the GA gate is green", () => {
    const state = newCanaryState();
    const notReady = evaluateGaReadiness({ ...READY, dpiaSigned: false });
    expect(enableTenant(state, "t1", notReady)).toMatchObject({ enabled: false });
    expect(isLiveForTenant(state, "t1")).toBe(false);
  });

  test("enables one tenant once ready — not the whole fleet", () => {
    const state = newCanaryState();
    const gate = evaluateGaReadiness(READY);
    expect(enableTenant(state, "t1", gate)).toMatchObject({ enabled: true });
    expect(isLiveForTenant(state, "t1")).toBe(true);
    expect(isLiveForTenant(state, "t2")).toBe(false);
  });
});

describe("metric-gated canary auto-rollback [S112]", () => {
  const t = { maxErrorRate: 0.01, maxFreshnessBreaches: 3 };
  test("proceeds within SLO, rolls back on regression", () => {
    expect(canaryDecision({ errorRate: 0.005, freshnessBreaches: 1 }, t)).toBe("proceed");
    expect(canaryDecision({ errorRate: 0.05, freshnessBreaches: 0 }, t)).toBe("rollback");
    expect(canaryDecision({ errorRate: 0, freshnessBreaches: 10 }, t)).toBe("rollback");
  });
});
