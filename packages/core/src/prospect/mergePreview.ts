// mergePreview.ts — the read-only merge PREVIEW builder (import-and-data-model-redesign 04 §6; S-C5). Feeds
// the side-by-side review panel (doc 11 / S-U8): the per-field survivor-vs-loser matrix (with the survivor's
// pin flag so the UI disables an unwinnable loser pick) + the child-count impact summary (how many rows
// re-point per table if this merge runs). Non-mutating: no lock, no write. The seven decidable scalars are the
// clear-text overlay columns (names/title/location — the same fields maskedContactSchema surfaces); channel
// VALUES are never included (04 §6: masked means masked — a count is a facet, a value is PII).

import { contactMergeRepository, withTenantTx } from "@leadwolf/db";
import {
  CONTACT_MERGE_DECIDABLE_FIELDS,
  type FieldProvenanceMap,
  type MergePreview,
  type MergePreviewField,
  NotFoundError,
  ValidationError,
} from "@leadwolf/types";

export interface PreviewContactMergeInput {
  scope: { tenantId: string; workspaceId: string };
  survivorContactId: string;
  loserContactId: string;
}

/**
 * Build the merge preview (04 §6). Both ids are resolved under RLS (a foreign id → 404, the IDOR guard);
 * self-merge → 400. Returns the field matrix + child-impact counts; masked values pre-reveal (scalars only).
 */
export async function previewContactMerge(input: PreviewContactMergeInput): Promise<MergePreview> {
  const { scope, survivorContactId, loserContactId } = input;
  if (survivorContactId === loserContactId) {
    throw new ValidationError("A contact cannot be previewed against itself.");
  }
  return withTenantTx(scope, async (tx) => {
    const { survivor, loser } = await contactMergeRepository.loadPairForPreview(
      tx,
      survivorContactId,
      loserContactId,
    );
    if (!survivor || !loser) {
      throw new NotFoundError("Both contacts must exist in this workspace to preview a merge.");
    }
    const prov = survivor.fieldProvenance as FieldProvenanceMap;
    const fields: MergePreviewField[] = CONTACT_MERGE_DECIDABLE_FIELDS.map((f) => ({
      field: f,
      survivorValue: (survivor as unknown as Record<string, string | null>)[f] ?? null,
      loserValue: (loser as unknown as Record<string, string | null>)[f] ?? null,
      survivorPinned: prov[f]?.pin === true,
    }));
    const childImpact = await contactMergeRepository.countLoserChildren(tx, loserContactId, {
      workspaceId: scope.workspaceId,
    });
    return { survivorContactId, loserContactId, fields, childImpact };
  });
}
