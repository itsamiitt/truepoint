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
