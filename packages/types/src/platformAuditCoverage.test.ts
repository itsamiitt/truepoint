// platformAuditCoverage.test.ts — drift guard for the closed platform_audit_action vocabulary (ADR-0032),
// mirroring auditCoverage.test.ts for the tenant audit_log enum. Every value in `platformAuditAction` must be
// accounted for as WRITTEN (has a recordPlatformEvent/recordPlatformAuthEvent call-site today) or PENDING
// (defined but not yet wired). Adding/removing a value without updating this bookkeeping fails the test.
import { describe, expect, it } from "bun:test";
import { platformAuditAction } from "./platformAudit.ts";

// Wired via recordPlatformAuthEvent (packages/auth, ADR-0031 §3 / P0-01).
const WRITTEN = new Set<string>([
  "password.reset.request",
  // password.reset.complete reaches platform_audit_log on the 0/>1-tenant branch; the single-tenant branch
  // writes audit_log (see auditCoverage.test.ts). Either way it has a verified call-site.
  "password.reset.complete",
]);

// Defined in the closed enum but not yet wired: staff/admin actions land with the apps/admin track; the
// remaining tenant-less identity events land as their flows are built.
const PENDING = new Set<string>([
  "tenant.suspend",
  "tenant.reactivate",
  "credit.grant",
  "plan.override",
  "impersonation.start",
  "impersonation.end",
  "feature_flag.set",
  "provider_config.update",
  "retention_policy.set",
  "audit.export",
  "staff.login",
  "staff.login.failure",
  "login.failure",
  "mfa.challenge",
  "mfa.success",
  "mfa.failure",
]);

describe("platform_audit_log.action coverage", () => {
  const all = [...platformAuditAction.options].sort();

  it("WRITTEN ∪ PENDING exactly covers the closed enum", () => {
    const union = [...new Set([...WRITTEN, ...PENDING])].sort();
    expect(union).toEqual(all);
  });

  it("WRITTEN and PENDING are disjoint", () => {
    const both = [...WRITTEN].filter((action) => PENDING.has(action));
    expect(both).toEqual([]);
  });

  it("every bookkeeping entry is a real enum member (no stale literal)", () => {
    const members = new Set<string>(platformAuditAction.options);
    const stale = [...WRITTEN, ...PENDING].filter((action) => !members.has(action));
    expect(stale).toEqual([]);
  });
});
