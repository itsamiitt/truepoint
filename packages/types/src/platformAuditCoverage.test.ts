// platformAuditCoverage.test.ts — drift guard for the closed platform_audit_action vocabulary (ADR-0032),
// mirroring auditCoverage.test.ts for the tenant audit_log enum. Every value in `platformAuditAction` must be
// accounted for as WRITTEN (has a recordPlatformEvent/recordPlatformAuthEvent call-site today) or PENDING
// (defined but not yet wired). Adding/removing a value without updating this bookkeeping fails the test.
import { describe, expect, it } from "bun:test";
import { platformAuditAction } from "./platformAudit.ts";

// WRITTEN = has a verified call-site today. Identity events are wired via recordPlatformAuthEvent
// (packages/auth, ADR-0031 §3 / P0-01); the tenant/credit staff actions are wired via withPlatformTx in
// apps/api/src/features/admin/routes.ts (13a Area 1 — the tenant-lifecycle + manual-credit endpoints).
const WRITTEN = new Set<string>([
  "password.reset.request",
  // password.reset.complete reaches platform_audit_log on the 0/>1-tenant branch; the single-tenant branch
  // writes audit_log (see auditCoverage.test.ts). Either way it has a verified call-site.
  "password.reset.complete",
  // 13a Area 1 — staff tenant-management mutations (POST /admin/tenants/:id/{suspend,reactivate,credits}).
  "tenant.suspend",
  "tenant.reactivate",
  // 13a Area 1 — apply a plan template to a tenant (POST /admin/tenants/:id/plan).
  "plan.override",
  "credit.grant",
  "credit.adjust",
  // 13a Area 2 — staff global-user mutations (POST /admin/users/:id/{deactivate,reactivate}).
  "user.deactivate",
  "user.reactivate",
  // 13a F1 — JIT elevation grant (POST /admin/elevations), consumed by the credit/suspend mutations.
  "elevation.grant",
  // 13a F4 — audit-log CSV export (GET /admin/audit-log/export) writes its own audited row.
  "audit.export",
  // 13a Area 3 — staff support note added to a tenant (POST /admin/tenants/:id/notes).
  "support_note.add",
  // 13a Area 5 — credit-pack (pricing) catalog upsert / toggle (PUT/POST /admin/pricing/credit-packs).
  "credit_pack.set",
  // 13a Area 5 — plan-template catalog upsert / toggle (PUT/POST /admin/pricing/plan-templates).
  "plan_template.set",
  // 13a Area 7 — place / lift an account hold (POST /admin/tenants/:id/holds[/:holdId/lift]).
  "account.hold",
  "account.hold.lift",
  // 13a Area 10 — publish / update / toggle an announcement (POST/PUT /admin/announcements).
  "announcement.publish",
  // 13a Area 8 — set / toggle a retention policy (POST/PUT /admin/compliance/retention).
  "retention.set",
  // data-management #6 — set/flip a GLOBAL retention-class policy (PUT /admin/retention-policies). The engine's
  // policy store (table renamed retention_policies → retention_class_policies on the main-merge to avoid the 13a
  // retention_policies collision); super_admin-only + audited (apps/api/.../admin/routes.ts).
  "retention_policy.set",
  // 13a Area 8 — add / remove a global suppression (POST /admin/compliance/suppression[/:id/remove]).
  "suppress.add.global",
  "suppress.remove.global",
  // 13a Area 8 — staff DSAR workflow transition (POST /admin/compliance/dsars/:id/status): verifying /
  // processing / rejected only. 'completed' is deliberately NOT staff-settable (the erasure/export process
  // records completion; a manual 'completed' with no fulfilment would be a compliance violation).
  "dsar.transition",
  // 13a Area 8 / GDPR Art. 28 — set / toggle a sub-processor registry entry (POST/PUT + /:id/active under
  // /admin/compliance/sub-processors). Audited "sub_processor.set".
  "sub_processor.set",
]);

// Defined in the closed enum but not yet wired: the remaining staff/admin actions land with their slices;
// the remaining tenant-less identity events land as their flows are built.
const PENDING = new Set<string>([
  "impersonation.start",
  "impersonation.end",
  "feature_flag.set",
  "provider_config.update",
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
