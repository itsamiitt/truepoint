// listGovernance.ts — the Phase-5 admin/staff governance contract for the List tab (list-plan/07, D2).
// Single source of truth shared by apps/api (response shapes), apps/admin (staff lists-overview view), and
// apps/web (the customer-visible staff-access log). Leaf package (validation/types only).
//
// PRIVACY-FIRST (D2): the staff lists-overview is METADATA + AGGREGATE COUNT only — it deliberately carries
// NO list-member rows and NO contact-PII field (email/phone/name). Record-level access to a tenant's list
// contents is reachable ONLY through an audited, time-boxed break-glass impersonation (separate surface).

import { z } from "zod";

// ── List-aware platform-audit action vocabulary (list-plan/07 §5, gap #1) ────────────────────────────────
// `platform_audit_log.action` is free-text, so these need no migration — only a defined, code-referenced
// vocabulary. The member-PII actions (view_members / bulk_action) are emitted ONLY inside an impersonation
// session; view_metadata is the day-to-day staff read. Kept as a const object so callers reference a symbol,
// never a typo-prone string literal.
export const LIST_PLATFORM_AUDIT_ACTIONS = {
  /** Staff read a tenant's list METADATA + aggregate counts (no member PII) — the default operating read. */
  viewMetadata: "admin.list.view_metadata",
  /** Staff read a list's MEMBER rows — impersonation-only (break-glass), never the default console. */
  viewMembers: "admin.list.view_members",
  /** Staff ran a bulk action AS the tenant under impersonation — impersonation-only. */
  bulkAction: "admin.list.bulk_action",
  /** Staff quarantined a list (abuse response on the container). */
  quarantine: "admin.list.quarantine",
  /** Staff lifted a list quarantine. */
  unquarantine: "admin.list.unquarantine",
  /** A compliance/DSAR action touched list members (the privileged DSAR fan-out). */
  dsarAction: "admin.list.dsar_action",
} as const;

export type ListPlatformAuditAction =
  (typeof LIST_PLATFORM_AUDIT_ACTIONS)[keyof typeof LIST_PLATFORM_AUDIT_ACTIONS];

/** The break-glass impersonation lifecycle actions (already emitted by apps/api/.../impersonation.ts). Named
 *  here so the customer-visible-access-log allow-list can be DERIVED from a single vocabulary rather than
 *  re-typing the literals. */
export const IMPERSONATION_AUDIT_ACTIONS = {
  start: "admin.impersonate.start",
  end: "admin.impersonate.end",
} as const;

/**
 * The actions that constitute a staff record-/data-level access to a TENANT's list data and are therefore
 * surfaced on the customer-visible access log (list-plan/07 §5). DERIVED from the canonical vocabularies above
 * (one source of truth) — a rename of any action symbol updates this set automatically. The db read filters
 * `platform_audit_log` to this set for the tenant.
 */
export const TENANT_VISIBLE_STAFF_ACTIONS = [
  ...Object.values(LIST_PLATFORM_AUDIT_ACTIONS),
  ...Object.values(IMPERSONATION_AUDIT_ACTIONS),
] as const;

// ── Staff lists-overview (metadata + aggregate ONLY) ─────────────────────────────────────────────────────
/**
 * One list as a STAFF member sees it (list-plan/07 §3.1). METADATA + an AGGREGATE member COUNT only — no
 * `list_members`, no contact PII. The owner is identified by `ownerUserId` only; the owner's EMAIL is NOT
 * surfaced — it is a customer employee's PII, which the privacy-first staff surface does not leak. This is
 * the shape the apps/admin tenant-detail "Lists" panel renders.
 *
 * NOTE: list-plan Phase 0 (`listKind`/`source`/`archivedAt`) is not yet on this branch; add those metadata
 * fields here when it lands — they are container metadata, never member PII, so they belong on this shape.
 */
export const staffListOverviewSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  ownerUserId: z.string().uuid(),
  memberCount: z.number().int().min(0),
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
});
export type StaffListOverview = z.infer<typeof staffListOverviewSchema>;

// ── Customer-visible staff-access log (list-plan/07 §5 — "the customer can see staff looking") ───────────
/**
 * One staff access to the CUSTOMER's tenant data, as surfaced to a tenant-admin (Settings ▸ Compliance ▸
 * Access Log). The transparency projection of `platform_audit_log` filtered to this tenant: who (the staff
 * actor), what action, which list, when. The staff actor's request IP and the free-form metadata are
 * deliberately NOT included — internal staff context is never surfaced to the customer.
 */
export const tenantStaffAccessSchema = z.object({
  id: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  occurredAt: z.string(), // ISO-8601
});
export type TenantStaffAccess = z.infer<typeof tenantStaffAccessSchema>;
