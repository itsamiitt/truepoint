// dataApproval.ts — the maker-checker approval CONTRACT for high-risk Data-management operations
// (database-management-research 09). The closed operation vocabulary, the request/decision input schemas, and
// the staff-facing ApprovalRequestView. The approve action is gated by data:review + a server-side
// requested_by != decided_by (maker != checker) check; a high-risk op routes through a pending request before
// it runs. Backed by the platform-owned `approval_requests` table (schema/platformOps.ts, rls/platformOps.sql).

import { z } from "zod";
import { retentionDataClass } from "./retention.ts";

/** The closed set of high-risk operations that require maker-checker approval. Extend as ops are gated.
 *  The `credit_*` money operations (M11, ADR-0041 / owner decision #4) are decided under the BILLING capability
 *  (a different billing operator approves), NOT data:review — see apps/api billing approvals queue. */
export const dataApprovalOperation = z.enum([
  "bulk_delete", // delete records in bulk (large blast radius)
  "dedup_merge", // merge entities from the dedup / ER review queue
  "retention_enforce", // flip a retention class from shadow to enforce (arms real deletion)
  "bulk_export", // initiate an audited cross-tenant data export (PII egress)
  "credit_adjust", // manual credit grant/adjustment on a tenant (delta sign = grant vs debit)
  "credit_refund", // refund a purchase (reverse the granted credits)
]);
export type DataApprovalOperation = z.infer<typeof dataApprovalOperation>;

/** The money operations, split out so each approvals queue only shows its own kind (billing vs data-ops). */
export const MONEY_APPROVAL_OPERATIONS = ["credit_adjust", "credit_refund"] as const;
export const DATA_APPROVAL_OPERATIONS = [
  "bulk_delete",
  "dedup_merge",
  "retention_enforce",
  "bulk_export",
] as const;

/** The lifecycle of an approval request. */
export const approvalStatus = z.enum(["pending", "approved", "rejected", "executed", "expired"]);
export type ApprovalStatus = z.infer<typeof approvalStatus>;

/** Create a maker-checker request (the MAKER — data:manage). `params` is the op's parameters, validated per-op
 *  at execute time; `targetTenantId` is the org the op acts on (omit for platform-wide). */
export const createApprovalSchema = z.object({
  operation: dataApprovalOperation,
  params: z.record(z.unknown()).default({}),
  targetTenantId: z.string().uuid().nullish(),
  reason: z.string().min(3).max(2000),
});
export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;

/** Approve or reject a pending request (the CHECKER — data:review). The reason is captured on the audit trail. */
export const decideApprovalSchema = z.object({
  reason: z.string().min(3).max(2000),
});
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

/** What the approvals queue renders — the request + its decision metadata. No secrets; `params` are
 *  operator-supplied operation parameters (counts/ids/flags), never imported PII. */
export const approvalRequestViewSchema = z.object({
  id: z.string().uuid(),
  operation: dataApprovalOperation,
  params: z.record(z.unknown()),
  targetTenantId: z.string().uuid().nullable(),
  requestedByUserId: z.string().uuid(),
  requestReason: z.string(),
  status: approvalStatus,
  decidedByUserId: z.string().uuid().nullable(),
  decisionReason: z.string().nullable(),
  decidedAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  executedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ApprovalRequestView = z.infer<typeof approvalRequestViewSchema>;

/** Params a `retention_enforce` approval carries — which data class to flip to `enforce`, and its TTL (days;
 *  null = never auto-delete). The executor validates these before the flip runs. */
export const retentionEnforceParamsSchema = z.object({
  dataClass: retentionDataClass,
  ttlDays: z.number().int().positive().nullable(),
});
export type RetentionEnforceParams = z.infer<typeof retentionEnforceParamsSchema>;

/** Params a `bulk_export` approval carries — the TARGET workspace whose contacts a staff member exports
 *  (cross-tenant PII egress). The executor reads that workspace's contacts under the owner path, applies the
 *  explicit-scope suppression filter, decrypts, and writes a CSV. Platform-audited, not credit-charged. */
export const bulkExportParamsSchema = z.object({
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type BulkExportParams = z.infer<typeof bulkExportParamsSchema>;

/** Params a `dedup_merge` approval carries — GRAIN A overlay merge (pending/dedup-merge-design.md v1): mark
 *  `loser` a duplicate of `survivor` in ONE declared tenant+workspace. Marker-only (the same annotation the
 *  automated dedup sweep writes), so it is REVERSIBLE via the customer "not a duplicate" unmark. ONE pair per
 *  request (blast-radius rule §4.4). NO master-graph write — grain B remains security-review-gated. */
export const dedupMergeParamsSchema = z
  .object({
    tenantId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    survivorContactId: z.string().uuid(),
    loserContactId: z.string().uuid(),
  })
  .refine((p) => p.survivorContactId !== p.loserContactId, "survivor and loser must differ");
export type DedupMergeParams = z.infer<typeof dedupMergeParamsSchema>;

/** Params a `bulk_delete` approval carries — a BOUNDED explicit id set (≤1000, design §4.4) in ONE declared
 *  tenant+workspace. SOFT delete only (deleted_at tombstone — the customer-grade delete; PII nulling stays the
 *  DSAR/retention path's job). Ids, never record values (audit-trail PII rule §4.6). */
export const bulkDeleteParamsSchema = z.object({
  tenantId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  contactIds: z.array(z.string().uuid()).min(1).max(1000),
});
export type BulkDeleteParams = z.infer<typeof bulkDeleteParamsSchema>;

/** Params a `credit_adjust` approval carries — the tenant + the SIGNED delta (positive grants, negative
 *  debits). The executor re-validates before running adjustCredits + posting the ledger entry (M11, decision #4). */
export const creditAdjustParamsSchema = z.object({
  tenantId: z.string().uuid(),
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((n) => n !== 0, "delta must be non-zero"),
});
export type CreditAdjustParams = z.infer<typeof creditAdjustParamsSchema>;

/** Params a `credit_refund` approval carries — the tenant + the purchase to reverse + the categorical reason
 *  (audited). The executor re-validates before running refundPurchase + posting the ledger entry (decision #4). */
export const creditRefundParamsSchema = z.object({
  tenantId: z.string().uuid(),
  purchaseId: z.string().uuid(),
  refundReason: z.enum(["duplicate", "fraud", "billing_error", "goodwill", "other"]),
  note: z.string().max(500).optional(),
});
export type CreditRefundParams = z.infer<typeof creditRefundParamsSchema>;
