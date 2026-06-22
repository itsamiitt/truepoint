// firmographics.test.ts — the PURE firmographics rollup logic (24 Phase-0.5): tech-slug normalization and the
// per-account fold (tech_install → deduped/sorted technologies; latest funding_round → funding stage). The
// withTenantTx path is covered by the db itest. Env is seeded by the global test preload.

import { describe, expect, test } from "bun:test";
import type { FirmographicSignalRow } from "@leadwolf/db";
import { aggregateFirmographics, normalizeTech } from "./firmographics.ts";

const sig = (over: Partial<FirmographicSignalRow>): FirmographicSignalRow => ({
  accountId: "acct-1",
  signalType: "tech_install",
  detail: "Salesforce",
  detectedAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

describe("normalizeTech", () => {
  test("lowercases + trims; empty → null", () => {
    expect(normalizeTech("  Salesforce ")).toBe("salesforce");
    expect(normalizeTech("")).toBeNull();
    expect(normalizeTech(null)).toBeNull();
    expect(normalizeTech("   ")).toBeNull();
  });
});

describe("aggregateFirmographics", () => {
  test("tech_install → deduped, sorted technology slugs per account", () => {
    const out = aggregateFirmographics([
      sig({ detail: "Salesforce" }),
      sig({ detail: "salesforce" }), // dup after normalize
      sig({ detail: "AWS" }),
      sig({ detail: "" }), // ignored
    ]);
    expect(out.get("acct-1")?.technologies).toEqual(["aws", "salesforce"]);
    expect(out.get("acct-1")?.fundingStage).toBeNull();
  });

  test("funding_round → the MOST RECENT detail wins", () => {
    const out = aggregateFirmographics([
      sig({
        signalType: "funding_round",
        detail: "Series A",
        detectedAt: new Date("2025-01-01T00:00:00Z"),
      }),
      sig({
        signalType: "funding_round",
        detail: "Series B",
        detectedAt: new Date("2026-03-01T00:00:00Z"),
      }),
    ]);
    expect(out.get("acct-1")?.fundingStage).toBe("Series B");
    expect(out.get("acct-1")?.technologies).toEqual([]);
  });

  test("groups per account; accounts without derivable facets are absent", () => {
    const out = aggregateFirmographics([
      sig({ accountId: "a", detail: "Stripe" }),
      sig({ accountId: "b", signalType: "funding_round", detail: "Seed" }),
      sig({ accountId: "c", detail: "" }), // no usable signal → absent
    ]);
    expect(out.get("a")?.technologies).toEqual(["stripe"]);
    expect(out.get("b")?.fundingStage).toBe("Seed");
    expect(out.has("c")).toBe(false);
  });
});
