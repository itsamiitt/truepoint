// mergeDecisions.ts — the PURE merge-review decision logic (no client/transport deps, so it unit-tests without
// the browser seam). The IRREVERSIBLE merge sends only the LOSER overrides (survivor-wins is the server default,
// 04 §3.2); a PINNED survivor field is structurally unoverwritable (DM6) and NEVER yields a loser decision —
// defense-in-depth mirroring planFieldWrite, never the boundary.

import type { MergeFieldDecision, MergePreviewField } from "@leadwolf/types";

/** The per-field survivor/loser choice the review UI collects, keyed by field name. */
export type FieldPick = "survivor" | "loser";

/** Build the minimal decisions payload from the review picks. Survivor-wins is the default, so only `loser`
 *  overrides are emitted; pinned survivor fields are dropped (the UI also locks them). */
export function buildMergeDecisions(
  fields: Pick<MergePreviewField, "field" | "survivorPinned">[],
  picks: Record<string, FieldPick>,
): MergeFieldDecision[] {
  const decisions: MergeFieldDecision[] = [];
  for (const f of fields) {
    if (f.survivorPinned) continue; // pinned survivor value wins structurally — never assert the loser's
    if (picks[f.field] === "loser") decisions.push({ field: f.field, winner: "loser" });
  }
  return decisions;
}
