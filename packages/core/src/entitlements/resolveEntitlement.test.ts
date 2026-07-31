import { describe, expect, test } from "bun:test";
import { type EntitlementGrant, periodFor, resolveEntitlement } from "./resolveEntitlement.ts";

const plan = (cap: number | null, key = "reveal_month"): EntitlementGrant => ({
  key,
  cap,
  period: "month",
  source: "plan",
});
const community = (cap: number | null, key = "reveal_month"): EntitlementGrant => ({
  key,
  cap,
  period: "month",
  source: "community",
});

describe("resolveEntitlement", () => {
  test("under the cap is allowed; at the cap is not", () => {
    expect(resolveEntitlement("reveal_month", [plan(25)], 24).allowed).toBe(true);
    const at = resolveEntitlement("reveal_month", [plan(25)], 25);
    expect(at.allowed).toBe(false);
    expect(at.reason).toBe("cap_reached");
    // >= not >: the 25th reveal consumed the 25th unit, so the 26th request is the one refused.
    expect(resolveEntitlement("reveal_month", [plan(25)], 26).allowed).toBe(false);
  });

  test("cap 0 is a feature switch, not an exhausted allowance", () => {
    // Different copy, different upsell — "your plan does not include this" is not "you have used it all".
    const d = resolveEntitlement("reveal_month", [plan(0)], 0);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("feature_disabled");
  });

  test("null cap is unlimited and beats any number", () => {
    // Math.max over nulls would treat unlimited as 0 and lock out the most privileged tenants — the exact
    // inversion this ordering exists to prevent.
    const d = resolveEntitlement("reveal_month", [plan(25), community(null)], 10_000);
    expect(d.allowed).toBe(true);
    expect(d.cap).toBeNull();
  });

  test("most permissive wins across sources", () => {
    const d = resolveEntitlement("reveal_month", [plan(25), community(100)], 40);
    expect(d.allowed).toBe(true);
    expect(d.cap).toBe(100);
    expect(d.source).toBe("community");
  });

  test("when a Community grant lapses the plan cap reappears untouched", () => {
    // The whole reason `source` is in the primary key: expiring one row must not have rewritten the other.
    // The caller drops expired rows, so this is what resolution sees afterwards.
    const d = resolveEntitlement("reveal_month", [plan(25)], 40);
    expect(d.allowed).toBe(false);
    expect(d.cap).toBe(25);
    expect(d.source).toBe("plan");
  });

  test("an uncovered key fails OPEN, and says why", () => {
    // Phase 1 ships the table empty. Failing closed would take every metered action offline for every tenant
    // the moment the flag flipped. "Nobody expressed a limit" is not "the limit is zero".
    const d = resolveEntitlement("export_month", [plan(25)], 999);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("no_entitlement");
    expect(d.source).toBeNull();
  });

  test("grants for other keys are ignored", () => {
    const d = resolveEntitlement("reveal_month", [plan(5, "export_month")], 100);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("no_entitlement");
  });

  test("usage is reported whatever the outcome", () => {
    // Shadow mode logs this to measure disagreement before enforcing, so it must be present on allow too.
    expect(resolveEntitlement("reveal_month", [plan(25)], 7).used).toBe(7);
    expect(resolveEntitlement("reveal_month", [plan(25)], 99).used).toBe(99);
  });
});

describe("periodFor", () => {
  test("an explicit period beats an unset one", () => {
    // A lifetime/unset grant must not silently widen the window a monthly grant defined.
    expect(
      periodFor("reveal_month", [
        { key: "reveal_month", cap: 10, period: null, source: "grant" },
        plan(25),
      ]),
    ).toBe("month");
  });

  test("no grant means no period", () => {
    expect(periodFor("reveal_month", [])).toBeNull();
  });
});
