// tenantSuspension.test.ts — the §9E decision. This gate ships DISARMED, so the tests are what say it is
// correct: nothing in a normal run exercises the enforcing branch until someone flips the flag in production,
// which is the worst possible moment to discover the logic is inverted.

import { describe, expect, test } from "bun:test";
import {
  suspensionEnforced,
  tenantSuspensionDecision,
  tenantSuspensionLog,
} from "./tenantSuspension.ts";

describe("tenantSuspensionDecision", () => {
  test("an active tenant is neither suspended nor refused, armed or not", () => {
    expect(tenantSuspensionDecision("active", false)).toEqual({ suspended: false, refuse: false });
    expect(tenantSuspensionDecision("active", true)).toEqual({ suspended: false, refuse: false });
  });

  test("SHADOW: a suspended tenant is detected but NOT refused while disarmed", () => {
    // This is the whole point of the observe-first rollout — the gap is measured without ejecting anyone.
    expect(tenantSuspensionDecision("suspended", false)).toEqual({
      suspended: true,
      refuse: false,
    });
  });

  test("ENFORCE: a suspended tenant is refused once armed", () => {
    expect(tenantSuspensionDecision("suspended", true)).toEqual({ suspended: true, refuse: true });
  });

  test("an UNRECOGNISED status classifies as suspended — a new status must not become an access grant", () => {
    // Fail closed on classification. If someone adds 'archived' or 'pending_deletion' to the vocabulary, it
    // must not silently be treated as permitted the day it ships.
    for (const status of ["archived", "pending_deletion", "", "ACTIVE"]) {
      expect(tenantSuspensionDecision(status, true).refuse).toBe(true);
    }
  });

  test("null/undefined status classifies as suspended, not as permitted", () => {
    expect(tenantSuspensionDecision(null, true).refuse).toBe(true);
    expect(tenantSuspensionDecision(undefined, true).refuse).toBe(true);
  });
});

describe("suspensionEnforced", () => {
  test('only the literal "true" arms it', () => {
    expect(suspensionEnforced("true")).toBe(true);
    // Everything else is disarmed — including the values someone might reasonably expect to work, which is
    // exactly why the flag's declared contract says "only the literal true".
    for (const v of [undefined, "", "false", "1", "yes", "TRUE", "True"]) {
      expect(suspensionEnforced(v)).toBe(false);
    }
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
