// dedupReview.ts — the within-workspace dedup REVIEW contract (database-management-research G09). A workspace user
// reviews the contacts the import dedup auto-flagged as duplicates (contacts.duplicate_of_contact_id) against the
// canonical each was pointed at, and can OVERRIDE a wrong call ("this is not a duplicate"). NAMES ONLY — the
// review identifies the pair; it never carries the encrypted email/phone (reveal is a separate, metered path).

import { z } from "zod";

/** One duplicate contact + the canonical it was auto-pointed at. Display names only; both sides are same-workspace. */
export const duplicatePairView = z.object({
  duplicateId: z.string(),
  duplicateName: z.string(),
  duplicateCreatedAt: z.string().datetime({ offset: true }),
  canonicalId: z.string(),
  canonicalName: z.string(),
});
export type DuplicatePairView = z.infer<typeof duplicatePairView>;

/** GET /contacts/duplicates — the workspace's flagged duplicate pairs for review. */
export const duplicatePairListResponse = z.object({ pairs: z.array(duplicatePairView) });
export type DuplicatePairListResponse = z.infer<typeof duplicatePairListResponse>;

/** POST /contacts/duplicates/:id/unmark — the override result (whether a flag was cleared). */
export const unmarkDuplicateResponse = z.object({ unmarked: z.boolean() });
export type UnmarkDuplicateResponse = z.infer<typeof unmarkDuplicateResponse>;
