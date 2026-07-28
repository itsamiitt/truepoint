// platformAudit.ts — the closed action vocabulary for platform_audit_log (ADR-0032). SEPARATE from the tenant
// audit_log `auditAction` enum (billing.ts) so staff-only + tenant-less identity values never leak into a
// tenant's DSAR/export. Mirrors audit_log's dotted, present-tense convention. The DB-side CHECK constraint
// lands with the apps/admin track (ADR-0032 §5); this enum is the enforced contract at the type boundary now.
import { z } from "zod";

export const platformAuditAction = z.enum([
  // Staff / admin actions (ADR-0011, ADR-0032 §3) — wired with the apps/admin track.
  "tenant.suspend",
  "tenant.reactivate",
  "credit.grant",
  "credit.adjust",
  "plan.override",
  "user.deactivate",
  "user.reactivate",
  "elevation.grant",
  "support_note.add",
  "credit_pack.set",
  "plan_template.set",
  "account.hold",
  "account.hold.lift",
  "announcement.publish",
  "retention.set",
  "suppress.add.global",
  "suppress.remove.global",
  "impersonation.start",
  "impersonation.end",
  "feature_flag.set",
  "provider_config.update",
  "retention_policy.set",
  "dsar.transition",
  "sub_processor.set",
  "audit.export",
  "staff.login",
  "staff.login.failure",
  // Tenant-less identity events routed here by ADR-0031 §3 (pre-tenant: no single tenant to satisfy
  // audit_log's NOT NULL tenant_id). password.reset.* are wired (P0-01); the rest land with their flows.
  "login.failure",
  "mfa.challenge",
  "mfa.success",
  "mfa.failure",
  "password.reset.request",
  "password.reset.complete",
  // AUTH-024 — passkey credential added / removed (tenant-less sink for multi-/no-tenant users).
  "passkey.register",
  "passkey.remove",
  // AUTH — self-service session revoke whose current session carries no tenant (tenant-less branch of the
  // session.revoked dual-sink; the tenant branch lands on audit_log).
  "session.revoked",
  // TruePoint Forge operator console (ADR-0047) — staff CROSS-TENANT reads. The Forge data plane is shared,
  // not tenant-scoped, so every one of these reads spans tenants by construction; the console says as much
  // with a standing "Cross-tenant view" badge. They are reads, and they are audited for the same reason the
  // apps/admin reads above are (admin.read_audit_log, admin.list_dsars): under ADR-0032 the auditable event is
  // a staff member reaching across tenants, not whether the statement mutated anything.
  "forge.read_overview",
  "forge.read_review_tasks",
  "forge.read_parsers",
  "forge.read_sync_status",
  "forge.read_captures",
  // CRM bidirectional sync (crm-sync 00 §4.11 / 01 Block C.3) — staff-side enablement via withPlatformTx,
  // super_admin-gated: turning the integration on for a tenant, and setting a connection's spend/rate
  // budget. Both are cross-tenant staff mutations, which is exactly the ADR-0032 auditable event. Per this
  // file's own note the platform_audit_log DB CHECK lands with the apps/admin track, so this type enum is
  // the enforced contract today.
  "crm_integration.enable",
  "crm_budget.set",
  // The staff CRM-sync monitor's cross-tenant read. Audited for the same reason admin.read_audit_log and the
  // forge.read_* reads are: under ADR-0032 the auditable event is a staff member reaching ACROSS tenants,
  // not whether the statement mutated anything. This one spans tenants by construction — the whole point of
  // the monitor is fleet-wide connection health.
  "crm.read_sync_health",
  // Triaging a poison job is a staff MUTATION on tenant-scoped data from the owner path, so it is audited
  // for the same reason every other cross-tenant staff action is (ADR-0032).
  "crm.dead_letter.triage",
]);

export type PlatformAuditAction = z.infer<typeof platformAuditAction>;

// ── Audit-log viewer query (13a F4 / Area 11) ──────────────────────────────────────────────────────────
// Keyset pagination + optional filters for GET /admin/audit-log (and the CSV export). All filters are
// optional and AND-combined; `cursor` is an opaque keyset token (never an offset). Values arrive as URL
// query params, so numeric/limit fields are coerced. Bounded by a max limit — no unbounded scans (ADR-0032).
export const platformAuditQuerySchema = z.object({
  action: z.string().trim().min(1).max(64).optional(), // exact action match (e.g. "tenant.suspend")
  tenantId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  since: z.string().datetime().optional(), // ISO lower bound (inclusive)
  until: z.string().datetime().optional(), // ISO upper bound (exclusive)
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PlatformAuditQuery = z.infer<typeof platformAuditQuerySchema>;

/** One audit entry as surfaced to the staff console — the structured envelope only (never `metadata`). */
export const platformAuditEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  actorUserId: z.string().uuid().nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  tenantId: z.string().uuid().nullable(),
  workspaceId: z.string().uuid().nullable(),
  ip: z.string().nullable(),
  occurredAt: z.string(), // ISO-8601
});
export type PlatformAuditEntry = z.infer<typeof platformAuditEntrySchema>;

/** A keyset page of audit entries — `nextCursor` is null when the last page has been reached. */
export interface PlatformAuditPage {
  entries: PlatformAuditEntry[];
  nextCursor: string | null;
}
