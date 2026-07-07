// contactExternalIdRepository.ts — data access for the P5 DELTA import external-id rung
// (import-and-data-model-redesign 08 §9 layer 3; migration 0068). A DELIBERATELY SEPARATE repo (not folded
// into contactRepository) so the delta feature never edits the contact-repo surface the Phase-4 merge train
// owns concurrently — the additive external_id rung is a self-contained read+write pair. Tx-aware so it
// composes into `runImport`'s per-row `withTenantTx` (RLS-enforcing) exactly like `findByDedupKeys`.
//
// WHY NOT ContactWriteValues.externalId: writing the key via a dedicated UPDATE (rather than a new column on
// the shared write-value type) keeps the change out of contactRepository.ts. The write runs ONLY on the
// insert (new-contact) branch, so the column starts NULL and the set is a first-write; a cross-row workspace
// collision surfaces at the partial unique `uniq_contacts_ws_external_id` (the row's tx aborts → reported as a
// per-row processing_error, the correct outcome for a genuine external-id clash).

import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { contacts } from "../schema/contacts.ts";

export const contactExternalIdRepository = {
  /**
   * Resolve a contact by the caller's stable external key within the workspace (the TOP dedup rung when the
   * DELTA gate + `externalIdUpsert` opt-in are on). Workspace-scoped explicitly (belt-and-suspenders with the
   * RLS tx GUC, mirroring `findByDedupKeys`); the partial unique guarantees ≤1 LIVE row per key so `.limit(1)`
   * is exact. Does NOT exclude soft-deleted rows in the predicate — the live-only partial unique already
   * ensures at most one non-tombstoned holder, and a tombstoned holder's key is released (deleted_at set), so
   * it cannot be returned (its row would only match if it were the sole holder, which the WHERE below allows —
   * so we additionally require the row to be live to never resolve onto a DSAR tombstone, matching the
   * addLandedToList soft-delete guard posture).
   */
  async findIdByExternalId(
    tx: Tx,
    workspaceId: string,
    externalId: string,
  ): Promise<{ id: string } | null> {
    const rows = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.externalId, externalId)))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * FILL-BLANK stamp of the external key onto a landing contact — sets `external_id` ONLY when it is currently
   * NULL (`WHERE id = :id AND external_id IS NULL`), so it NEVER overwrites an existing/different stored key
   * (the caller-declared key disagreeing with a populated one is left as-is — a conflict, not a silent clobber;
   * 08 §9 "conflict strategy defers to the field_provenance winner-map + pin"). Safe to call on any landing row
   * (a new insert has NULL → gets stamped; a match already holding this key is a no-op; a match holding a
   * DIFFERENT key is untouched). Same-tx as the write. A workspace collision on a fresh stamp throws at the
   * partial unique `uniq_contacts_ws_external_id` and aborts the row's tx (→ per-row processing_error).
   */
  async setExternalId(tx: Tx, contactId: string, externalId: string): Promise<void> {
    await tx
      .update(contacts)
      .set({ externalId })
      .where(and(eq(contacts.id, contactId), isNull(contacts.externalId)));
  },
};
