// revocationLog.test.ts — guards the AUTH-066 alertable marker. The deny-list fails open silently today; the
// marker is the operator signal, so its shape must be stable (an alert keys on "[revocation] DEGRADED") and it
// must never leak a session id / PII — only the op and the error reason.
import { describe, expect, it } from "bun:test";
import { denyListDegradedLog } from "./revocationLog.ts";

describe("denyListDegradedLog", () => {
  it("emits the stable alertable prefix + op for a record failure", () => {
    const line = denyListDegradedLog("mark", new Error("ECONNREFUSED 127.0.0.1:6379"));
    expect(line).toStartWith("[revocation] DEGRADED op=mark");
    expect(line).toContain("failing OPEN");
    expect(line).toContain("ECONNREFUSED 127.0.0.1:6379");
  });

  it("distinguishes the per-request lookup failure", () => {
    const line = denyListDegradedLog("check", "boom");
    expect(line).toContain("op=check");
    expect(line).toContain("boom");
  });

  it("carries no session id / PII (only op + reason)", () => {
    const line = denyListDegradedLog("check", new Error("timeout"));
    expect(line).not.toContain("revoked-sid:");
    expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/); // no uuid-shaped session id
  });

  it("stringifies a non-Error rejection without throwing", () => {
    expect(denyListDegradedLog("mark", { code: 42 })).toContain("[object Object]");
  });
});
