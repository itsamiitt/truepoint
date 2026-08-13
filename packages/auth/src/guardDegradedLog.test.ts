// guardDegradedLog.test.ts — guards the C11 alertable marker. These lines are the ONLY operator signal that
// the fail-open guards have opened, so their shape is a contract: an alert keys on "] DEGRADED ", and the
// marker must never carry a rate-limit key (an IP, an email, a subject id) into the log during an outage.

import { describe, expect, it } from "bun:test";
import { guardDegradedLog, makeDegradedThrottle } from "./guardDegradedLog.ts";
import { denyListDegradedLog } from "./revocationLog.ts";

describe("guardDegradedLog", () => {
  it("emits the stable alertable prefix + guard name", () => {
    const line = guardDegradedLog("rate-limit", new Error("ECONNREFUSED 127.0.0.1:6379"));
    expect(line).toStartWith("[guard:rate-limit] DEGRADED");
    expect(line).toContain("failing OPEN");
    expect(line).toContain("ECONNREFUSED 127.0.0.1:6379");
  });

  it("distinguishes each guard, so the page says which control opened", () => {
    expect(guardDegradedLog("reveal-rate-limit", "boom")).toContain("[guard:reveal-rate-limit]");
    expect(guardDegradedLog("entitlement", "boom")).toContain("[guard:entitlement]");
  });

  it("carries no key material — no ip, email, or subject id", () => {
    const line = guardDegradedLog("rate-limit", new Error("timeout"));
    expect(line).not.toMatch(/\d+\.\d+\.\d+\.\d+/); // no ip
    expect(line).not.toContain("@"); // no email
    expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no uuid-shaped subject
  });

  it("stringifies a non-Error rejection without throwing", () => {
    expect(guardDegradedLog("entitlement", { code: 42 })).toContain("[object Object]");
  });

  // The composite alert is the whole point of C11: one expression must catch every fail-open guard, including
  // the deny-list marker that predates this module and keeps its own prefix.
  it("shares one alert expression with the pre-existing revocation marker", () => {
    const ALERT = "] DEGRADED ";
    expect(guardDegradedLog("rate-limit", "x")).toContain(ALERT);
    expect(guardDegradedLog("entitlement", "x")).toContain(ALERT);
    expect(denyListDegradedLog("check", "x")).toContain(ALERT);
  });
});

describe("makeDegradedThrottle", () => {
  it("passes the first call, then suppresses until the interval elapses", () => {
    const allow = makeDegradedThrottle(10_000);
    expect(allow(0)).toBe(true);
    expect(allow(1)).toBe(false);
    expect(allow(9_999)).toBe(false);
    expect(allow(10_000)).toBe(true);
  });

  it("does not suppress the very first call regardless of clock origin", () => {
    // A naive `last = 0` initial value would swallow the first marker when now < intervalMs, which is exactly
    // the case at process start — the moment an outage is most likely to be noticed.
    expect(makeDegradedThrottle(10_000)(5)).toBe(true);
  });

  it("keeps independent state per throttle", () => {
    const a = makeDegradedThrottle(1_000);
    const b = makeDegradedThrottle(1_000);
    expect(a(0)).toBe(true);
    expect(b(0)).toBe(true);
    expect(a(500)).toBe(false);
    expect(b(1_000)).toBe(true);
  });
});
