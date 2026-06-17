// policy.test.ts — the PURE auto-enrich policy decision (G-ENR-1; 29 §3, 06 §4.1). Proves the fail-closed
// order of checks: disabled → trigger-not-allowed → no-allowed-fields → budget-exhausted, and that an
// allowed decision narrows the requested fields to the allowlist + reports the remaining budget. The
// DB-backed enforceAutoEnrichPolicy is exercised by the db itest (RLS + spend); here we test the logic only.

import { describe, expect, test } from "bun:test";
import type { EnrichmentPolicy } from "@leadwolf/types";
import { decideAutoEnrich } from "./policy.ts";

const ENABLED: EnrichmentPolicy = {
  enabled: true,
  triggers: ["on_import", "on_reveal"],
  fieldAllowlist: ["email", "phone"],
  monthlyBudgetMicros: 1_000_000,
};

describe("decideAutoEnrich", () => {
  test("disabled policy is denied (policy_disabled), no fields allowed", () => {
    const d = decideAutoEnrich(
      { ...ENABLED, enabled: false },
      { trigger: "on_import", requestedFields: ["email"], monthlySpentMicros: 0 },
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("policy_disabled");
    expect(d.allowedFields).toEqual([]);
  });

  test("a trigger not in the enabled set is denied (trigger_not_allowed)", () => {
    const d = decideAutoEnrich(ENABLED, {
      trigger: "on_stale",
      requestedFields: ["email"],
      monthlySpentMicros: 0,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("trigger_not_allowed");
  });

  test("requested fields outside the allowlist are denied (no_allowed_fields)", () => {
    const d = decideAutoEnrich(ENABLED, {
      trigger: "on_import",
      requestedFields: ["jobTitle", "department"],
      monthlySpentMicros: 0,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no_allowed_fields");
  });

  test("an empty allowlist permits nothing even when enabled (fail-closed)", () => {
    const d = decideAutoEnrich(
      { ...ENABLED, fieldAllowlist: [] },
      { trigger: "on_import", requestedFields: ["email"], monthlySpentMicros: 0 },
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no_allowed_fields");
  });

  test("at/over the monthly budget cap the run is skipped (budget_exhausted)", () => {
    const d = decideAutoEnrich(ENABLED, {
      trigger: "on_import",
      requestedFields: ["email"],
      monthlySpentMicros: 1_000_000, // exactly the cap
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("budget_exhausted");
    expect(d.remainingBudgetMicros).toBe(0);
  });

  test("a zero budget cap denies all auto-enrich spend", () => {
    const d = decideAutoEnrich(
      { ...ENABLED, monthlyBudgetMicros: 0 },
      { trigger: "on_import", requestedFields: ["email"], monthlySpentMicros: 0 },
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("budget_exhausted");
  });

  test("allowed: narrows requested fields to the allowlist + reports remaining budget", () => {
    const d = decideAutoEnrich(ENABLED, {
      trigger: "on_reveal",
      requestedFields: ["email", "jobTitle", "phone"], // jobTitle is NOT on the allowlist
      monthlySpentMicros: 250_000,
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBeNull();
    expect(d.allowedFields).toEqual(["email", "phone"]); // order preserved, jobTitle dropped
    expect(d.remainingBudgetMicros).toBe(750_000);
  });
});
