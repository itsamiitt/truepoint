// dataApproval.ts — the maker-checker approval CONTRACT for high-risk Data-management operations
// (database-management-research 09). The closed operation vocabulary, the request/decision input schemas, and
// the staff-facing ApprovalRequestView. The approve action is gated by data:review + a server-side
// requested_by != decided_by (maker != checker) check; a high-risk op routes through a pending request before
// it runs. Backed by the platform-owned `approval_requests` table (schema/platformOps.ts, rls/platformOps.sql).

import { z } from "zod";

/** The closed set of high-risk operations that require maker-checker approval. Extend as ops are gated. */
export const dataApprovalOperation = z.enum([
  "bulk_delete", // delete records in bulk (large blast radius)
  "dedup_merge", // merge entities from the dedup / ER review queue
  "retention_enforce", // flip a retention class from shadow to enforce (arms real deletion)
  "bulk_export", // initiate an audited cross-tenant data export (PII egress)
]);
export type DataApprovalOperation = z.infer<typeof dataApprovalOperation>;

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
