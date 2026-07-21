// contactMerge.ts — the contact TRUE-MERGE contract types (import-and-data-model-redesign 04 §3/§6; S-C3
// flag key + S-C5 DTOs). Browser-safe leaf (no env, no db). The merge is the highest-risk write verb: field
// union through the canonical planFieldWrite/planUserEdit pin machinery, a complete child re-point inventory,
// a loser tombstone, and irreversibility guardrails (never auto-merge; 2-record cap; daily cap; dual gate).

import { z } from "zod";
import { CONTACT_PROVENANCE_FIELDS } from "./fieldProvenance.ts";

/** The per-tenant half of the S-C3 dual gate (04 §3.1; seeded off in 0067). Effective merge =
 *  CONTACT_MERGE_ENABLED env kill-switch AND this flag. The shared key lives here so api/workers can never
 *  drift (the CHANNELS_DUAL_WRITE_FLAG_KEY / BULK_IMPORT_FLAG_KEY precedent). */
export const CONTACT_MERGE_FLAG_KEY = "contact_merge_enabled";

/** v1 operation cap (04 §3.1): TWO records per merge — survivor + exactly one loser (below Salesforce's 3;
 *  start tighter, relax later). The engine + verb both enforce it. */
export const CONTACT_MERGE_RECORDS_PER_OP = 2;

/** The scalar fields whose winner a merge decision may pick (the seven pin-protected hand-editable scalars —
 *  CONTACT_PROVENANCE_FIELDS). Channel values are NOT decided here (they demote structurally, 04 §3.3);
 *  custom_fields union is survivor-wins-per-key (04 §3.2). A decision key outside this set → 400 (closed
 *  allowlist, 04 §pre-build security). */
export const CONTACT_MERGE_DECIDABLE_FIELDS = CONTACT_PROVENANCE_FIELDS;

/** One per-field survivor decision from the review step (04 §3.2). `winner: "survivor"` keeps the survivor's
 *  value (default); `winner: "loser"` is a human assertion of the loser's value → runs through planUserEdit
 *  (sets pin:true). Absent fields default to survivor-wins / loser-fills-blanks. */
export const mergeFieldDecisionSchema = z.object({
  field: z.enum(CONTACT_MERGE_DECIDABLE_FIELDS),
  winner: z.enum(["survivor", "loser"]),
});
export type MergeFieldDecision = z.infer<typeof mergeFieldDecisionSchema>;

/** POST /contacts/:id/merge body (04 §3.1/§6): survivor = :id (path); loser + the per-field decision set.
 *  Idempotency-Key rides the header, not the body. */
export const mergeRequestSchema = z.object({
  loserContactId: z.string().uuid(),
  decisions: z.array(mergeFieldDecisionSchema).max(CONTACT_PROVENANCE_FIELDS.length).default([]),
});
export type MergeRequest = z.infer<typeof mergeRequestSchema>;

/** Per-child-table re-point tallies (04 §4 — carried in the audit event + the result). */
export const mergeRepointTalliesSchema = z.record(z.string(), z.number().int().nonnegative());
export type MergeRepointTallies = z.infer<typeof mergeRepointTalliesSchema>;

/** POST /contacts/:id/merge result (04 §6): survivor id (unchanged — the survivor keeps its id), the
 *  re-point tallies per table, and the audit event id (support's reconstruction handle). */
export const mergeResultSchema = z.object({
  survivorContactId: z.string().uuid(),
  loserContactId: z.string().uuid(),
  repointed: mergeRepointTalliesSchema,
  auditEventId: z.string().uuid().nullable(),
});
export type MergeResult = z.infer<typeof mergeResultSchema>;

/** One side of the side-by-side preview field matrix (04 §6): masked (non-PII) survivor + loser values per
 *  decidable scalar, plus whether the survivor's field is pinned (a pin is structurally unoverwritable — the
 *  UI disables the loser pick). */
export const mergePreviewFieldSchema = z.object({
  field: z.enum(CONTACT_MERGE_DECIDABLE_FIELDS),
  survivorValue: z.string().nullable(),
  loserValue: z.string().nullable(),
  survivorPinned: z.boolean(),
});
export type MergePreviewField = z.infer<typeof mergePreviewFieldSchema>;

/** GET/POST merge-preview response (04 §6): the field matrix + a child-count impact summary (how many rows
 *  re-point per table if this merge runs). Masked values pre-reveal. */
export const mergePreviewSchema = z.object({
  survivorContactId: z.string().uuid(),
  loserContactId: z.string().uuid(),
  fields: z.array(mergePreviewFieldSchema),
  childImpact: mergeRepointTalliesSchema,
});
export type MergePreview = z.infer<typeof mergePreviewSchema>;
