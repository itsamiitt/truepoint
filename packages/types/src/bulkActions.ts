// bulkActions.ts — Zod schemas + inferred types for the Phase-3 bulk-action surface (24, prospect search):
// owner assign/reassign, bulk tags, bulk status, bulk archive, bulk enroll, bulk enrich/re-verify, role-gated
// CSV export, and select-all-across-search (resolve a ContactQuery to ids server-side). Single source of truth
// for the apps/api request bodies and the apps/web bulkActionsApi client. Leaf package — validation only; the
// owner-scoping, visible-id filtering, affected-count, and audit logic live in @leadwolf/core + the API routes.
//
// SELECTION CONTRACT (shared by every bulk op): a bulk request targets EITHER an explicit `contactIds` list OR
// a `criteria` ContactQuery (select-all-across-search). Exactly one must be present. When `criteria` is given,
// the API resolves the matching workspace-visible ids via searchRepository, capped at BULK_SELECTION_CAP so a
// runaway "select-all" can never enqueue/mutate an unbounded set in one request. Either way the op only ever
// touches ids the caller can actually see in their workspace (the cross-workspace wall).

import { z } from "zod";
import { contactQuery } from "./search.ts";

/**
 * The hard cap on how many contacts ONE bulk request may target — applies to BOTH branches: an explicit
 * `contactIds` list is bounded to this length, and a `criteria` (select-all) resolution is sliced to the first
 * BULK_SELECTION_CAP visible ids (deterministic order from searchRepository). Keeps a single request's write /
 * enqueue / export footprint bounded (anything larger is a background-job concern, not a synchronous bulk op).
 */
export const BULK_SELECTION_CAP = 10000;

/** An explicit id list, bounded to the selection cap. Ids outside the workspace are dropped server-side. */
const contactIdList = z.array(z.string().uuid()).min(1).max(BULK_SELECTION_CAP);

/**
 * The shared selection envelope every bulk op extends: EITHER `contactIds` OR `criteria` (a ContactQuery for
 * select-all-across-search). The `.refine` enforces exactly-one-of so the API never has to guess. `criteria`
 * resolution is capped at BULK_SELECTION_CAP (documented above).
 */
export const bulkSelectionSchema = z
  .object({
    contactIds: contactIdList.optional(),
    criteria: contactQuery.optional(),
  })
  .refine((s) => (s.contactIds === undefined) !== (s.criteria === undefined), {
    message: "Provide exactly one of { contactIds } or { criteria }.",
  });
export type BulkSelection = z.infer<typeof bulkSelectionSchema>;

/** Helper: extend the selection envelope with op-specific fields while keeping the exactly-one-of refinement. */
function withSelection<T extends z.ZodRawShape>(shape: T) {
  return z
    .object({ contactIds: contactIdList.optional(), criteria: contactQuery.optional(), ...shape })
    .refine((s) => (s.contactIds === undefined) !== (s.criteria === undefined), {
      message: "Provide exactly one of { contactIds } or { criteria }.",
    });
}

// ── The affected-count envelope every bulk mutation returns ────────────────────────────────────────────
/** Every bulk mutation returns how many workspace-visible contacts it actually touched (the UI confirms it). */
export const bulkAffectedSchema = z.object({ affected: z.number().int().nonnegative() });
export type BulkAffected = z.infer<typeof bulkAffectedSchema>;

// ── 1. Assign / reassign owner ─────────────────────────────────────────────────────────────────────────
/**
 * POST /contacts/bulk/assign-owner. `ownerUserId: null` CLEARS the owner (unassign). Policy (enforced in core):
 * workspace owner/admin may set ANY owner; a member may only assign to THEMSELVES or clear (null) — never to a
 * different user. The new owner must be an active member of the workspace (validated in core).
 */
export const bulkAssignOwnerSchema = withSelection({
  ownerUserId: z.string().uuid().nullable(),
});
export type BulkAssignOwnerRequest = z.infer<typeof bulkAssignOwnerSchema>;

// ── 2. Add / remove tags ───────────────────────────────────────────────────────────────────────────────
/**
 * POST /contacts/bulk/tags (add) and DELETE /contacts/bulk/tags (remove). One or more workspace tag ids are
 * applied to / removed from the selection (idempotent at the assignment layer). `affected` = the number of
 * contacts processed (the visible selection size), not the number of (tag, contact) links written.
 */
export const bulkTagsSchema = withSelection({
  tagIds: z.array(z.string().uuid()).min(1).max(50),
});
export type BulkTagsRequest = z.infer<typeof bulkTagsSchema>;

// ── 3. Change outreach status ──────────────────────────────────────────────────────────────────────────
/** POST /contacts/bulk/status. The target outreach_status (validated against the closed enum in contacts.ts). */
export const bulkStatusSchema = withSelection({
  // Re-declared here (not imported as `outreachStatus`) so this file stays the single edge schema; the values
  // mirror contacts.ts outreachStatus exactly (the CHECK constraint is the DB backstop).
  outreachStatus: z.enum([
    "new",
    "in_sequence",
    "replied",
    "meeting_booked",
    "disqualified",
    "nurture",
    "unsubscribed",
  ]),
});
export type BulkStatusRequest = z.infer<typeof bulkStatusSchema>;

// ── 4. Archive (soft hide) ─────────────────────────────────────────────────────────────────────────────
/**
 * POST /contacts/bulk/archive. Soft-archive = set contacts.deleted_at for the visible selection so the row stops
 * surfacing in search/lists. DISTINCT from the DSAR tombstone path (which also NULLs PII + fans out): archive
 * only hides the row and is reversible by a future restore. No request fields beyond the selection envelope.
 */
export const bulkArchiveSchema = bulkSelectionSchema;
export type BulkArchiveRequest = z.infer<typeof bulkArchiveSchema>;

// ── 6. Enroll into a sequence ──────────────────────────────────────────────────────────────────────────
/**
 * POST /outreach/sequences/:id/enroll-bulk. The sequence id is the path param; the body is just the selection.
 * Each contact is enrolled idempotently (existing membership is a no-op). Suppression/revealed-only gating runs
 * per contact in core; `affected` counts NEW enrollments (existing/suppressed ones are skipped, not failures).
 */
export const bulkEnrollSchema = bulkSelectionSchema;
export type BulkEnrollRequest = z.infer<typeof bulkEnrollSchema>;
/** Bulk-enroll returns the affected (newly enrolled) count plus the per-outcome tally for the confirmation UI. */
export const bulkEnrollResultSchema = z.object({
  affected: z.number().int().nonnegative(),
  enrolled: z.number().int().nonnegative(),
  alreadyEnrolled: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type BulkEnrollResult = z.infer<typeof bulkEnrollResultSchema>;

// ── 7. Enrich / re-verify ──────────────────────────────────────────────────────────────────────────────
/**
 * POST /contacts/bulk/enrich. Enqueue a re-enrich/re-verify job for the selection (the existing enrichment_jobs
 * path). `affected` = the number of visible contacts enqueued into the job. The response also returns the new
 * job id so the caller can poll its status via the enrichment job-status surface.
 */
export const bulkEnrichSchema = bulkSelectionSchema;
export type BulkEnrichRequest = z.infer<typeof bulkEnrichSchema>;
export const bulkEnrichResultSchema = z.object({
  affected: z.number().int().nonnegative(),
  jobId: z.string().uuid(),
});
export type BulkEnrichResult = z.infer<typeof bulkEnrichResultSchema>;

// ── 8. CSV export (role-gated, masked columns only) ──────────────────────────────────────────────────────
/**
 * POST /contacts/bulk/export. Returns text/csv of the MASKED, non-PII columns for the visible selection (never
 * decrypts email/phone here). Role-gated server-side (owner/admin/member; viewer denied). Audited (`export`).
 * Body is just the selection envelope; the response is the CSV body, not JSON.
 */
export const bulkExportSchema = bulkSelectionSchema;
export type BulkExportRequest = z.infer<typeof bulkExportSchema>;

// ── 9. Select-all-across-search count ────────────────────────────────────────────────────────────────────
/**
 * POST /search/count. Body = a ContactQuery; returns the TOTAL matching, workspace-visible contacts (same
 * filters/owner-scoping as searchRepository.searchContacts). Powers the "Select all N results" affordance. The
 * count is exact (not capped) — only the per-request MUTATION footprint is capped (BULK_SELECTION_CAP), so the
 * UI can warn when the match set exceeds the cap.
 */
export const searchCountResultSchema = z.object({ total: z.number().int().nonnegative() });
export type SearchCountResult = z.infer<typeof searchCountResultSchema>;
