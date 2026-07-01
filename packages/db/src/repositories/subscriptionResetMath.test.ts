// subscriptionResetMath.test.ts — unit tests for the subscription monthly-reset arithmetic (M11, ADR-0041).
// The two owner decisions this encodes: (2) the subscription allotment resets each month; (3) purchased credits
// never expire. Pure — no database (the SQL that applies it is covered by CI itests + staging recon).

import { describe, expect, test } from "bun:test";
import { computeMonthlyReset } from "./subscriptionResetMath.ts";

describe("computeMonthlyReset", () => {
  test("expires the old allotment, grants the new, leaves purchased untouched", () => {
    // total 100 = 30 subscription + 70 purchased; new monthly grant 50.
    const m = computeMonthlyReset(100, 30, 50);
    expect(m.expired).toBe(30);
    expect(m.afterExpiry).toBe(70); // purchased 70 preserved — decision (3)
    expect(m.afterGrant).toBe(120);
    expect(m.newSubscription).toBe(50); // fresh allotment — decision (2)
  });

  test("the two ledger deltas sum to the net counter change (recon invariant)", () => {
    const total = 100;
    const m = computeMonthlyReset(total, 30, 50);
    // ledger posts adjustment(-expired) + grant(+newSubscription); their sum must equal counter delta.
    expect(-m.expired + m.newSubscription).toBe(m.afterGrant - total);
  });

  test("first grant with no prior allotment (subscription bucket 0)", () => {
    const m = computeMonthlyReset(70, 0, 50);
    expect(m.expired).toBe(0);
    expect(m.afterExpiry).toBe(70);
    expect(m.afterGrant).toBe(120);
    expect(m.newSubscription).toBe(50);
  });

  test("a zero-grant cycle still expires the old allotment", () => {
    const m = computeMonthlyReset(100, 30, 0);
    expect(m.expired).toBe(30);
    expect(m.afterExpiry).toBe(70);
    expect(m.afterGrant).toBe(70);
    expect(m.newSubscription).toBe(0);
  });

  test("unused allotment fully spent before reset (subscription 0, purchased remains)", () => {
    // A tenant that burned its whole allotment: subscription 0, total 40 all purchased; grant 50.
    const m = computeMonthlyReset(40, 0, 50);
    expect(m.expired).toBe(0);
    expect(m.afterExpiry).toBe(40);
    expect(m.afterGrant).toBe(90);
    expect(m.newSubscription).toBe(50);
  });
});
