// tenantSuspension.test.ts — the §9E decision. This gate ships DISARMED, so the tests are what say it is
// correct: nothing in a normal run exercises the enforcing branch until someone flips the flag in production,
// which is the worst possible moment to discover the logic is inverted.

import { describe, expect, test } from "bun:test";
import {
  suspensionMode,
  tenantSuspensionDecision,
  tenantSuspensionLog,
} from "./tenantSuspension.ts";

describe("tenantSuspensionDecision", () => {
  test("an active tenant is neither suspended nor refused, in any mode", () => {
    for (const mode of ["disabled", "shadow", "enforce"] as const) {
      expect(tenantSuspensionDecision("active", mode)).toEqual({ suspended: false, refuse: false });
    }
  });

  test("SHADOW: a suspended tenant is detected but NOT refused while disarmed", () => {
    // This is the whole point of the observe-first rollout — the gap is measured without ejecting anyone.
    expect(tenantSuspensionDecision("suspended", "shadow")).toEqual({
      suspended: true,
      refuse: false,
    });
  });

  test("ENFORCE: a suspended tenant is refused once armed", () => {
    expect(tenantSuspensionDecision("suspended", "enforce")).toEqual({
      suspended: true,
      refuse: true,
    });
  });

  test("an UNRECOGNISED status classifies as suspended — a new status must not become an access grant", () => {
    // Fail closed on classification. If someone adds 'archived' or 'pending_deletion' to the vocabulary, it
    // must not silently be treated as permitted the day it ships.
    for (const status of ["archived", "pending_deletion", "", "ACTIVE"]) {
      expect(tenantSuspensionDecision(status, "enforce").refuse).toBe(true);
    }
  });

  test("null/undefined status classifies as suspended, not as permitted", () => {
    expect(tenantSuspensionDecision(null, "enforce").refuse).toBe(true);
    expect(tenantSuspensionDecision(undefined, "enforce").refuse).toBe(true);
  });
});

describe("suspensionMode", () => {
  test("only 'true' or 'enforce' arm it — 'true' kept for the flag's original contract", () => {
    expect(suspensionMode("true")).toBe("enforce");
    expect(suspensionMode("enforce")).toBe("enforce");
  });

  test("SHADOW IS THE DEFAULT — an unset flag observes rather than going blind", () => {
    // This is the load-bearing default of the whole rollout. If an absent flag meant "disabled", the gate
    // would ship producing no data and nobody would ever have the numbers needed to arm it.
    for (const v of [undefined, "", "false", "1", "yes", "TRUE", "True", "shadow"]) {
      expect(suspensionMode(v)).toBe("shadow");
    }
  });

  test('only the exact literal "disabled" turns the read off', () => {
    expect(suspensionMode("disabled")).toBe("disabled");
    expect(suspensionMode("DISABLED")).toBe("shadow");
  });
});

describe("tenantSuspensionLog", () => {
  test("shadow lines say the request was ALLOWED and would be refused once armed", () => {
    const line = tenantSuspensionLog("t-1", "suspended", false);
    expect(line).toContain("mode=shadow");
    expect(line).toContain("ALLOWED");
    expect(line).toContain("would refuse");
    expect(line).toContain("tenant=t-1");
  });

  test("enforce lines say it was refused", () => {
    const line = tenantSuspensionLog("t-1", "suspended", true);
    expect(line).toContain("mode=enforce");
    expect(line).toContain("refused");
    expect(line).not.toContain("ALLOWED");
  });

  test("carries the tenant and status but no user identity", () => {
    const line = tenantSuspensionLog("t-1", "suspended", false);
    expect(line).toContain("status=suspended");
    expect(line).not.toContain("@"); // no email
    expect(line).toStartWith("[tenant-suspension]");
  });

  test("a null status renders explicitly rather than as 'undefined'", () => {
    expect(tenantSuspensionLog("t-1", null, false)).toContain("status=null");
  });
});
