// dedupReview.ts — the within-workspace dedup REVIEW orchestrators (database-management-research G09). Thin
// composition over contactRepository: list the workspace's auto-flagged duplicate pairs, and OVERRIDE one call
// (clear a single contact's duplicate pointer). Both are workspace-scoped via RLS (withTenantTx); names only, no
// PII decrypt. The auto-flagging itself is the import dedup pass (prospect/dedup.ts) — this is the human review of it.

import { type TenantScope, contactRepository, withTenantTx } from "@leadwolf/db";
import type { DuplicatePairView } from "@leadwolf/types";

type WorkspaceScope = TenantScope & { workspaceId: string };

/** "First Last", or "—" when the contact has no name (names are the non-PII identity the review shows). */
function displayName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(" ").trim() || "—";
}

/** The workspace's auto-flagged duplicate contacts, each paired with its canonical, for review. RLS-scoped. */
export async function listContactDuplicatePairs(
  scope: WorkspaceScope,
  limit = 200,
): Promise<DuplicatePairView[]> {
  const rows = await withTenantTx(scope, (tx) => contactRepository.listDuplicatePairs(tx, limit));
  return rows.map((r) => ({
    duplicateId: r.duplicateId,
    duplicateName: displayName(r.duplicateFirstName, r.duplicateLastName),
    duplicateCreatedAt: r.duplicateCreatedAt.toISOString(),
    canonicalId: r.canonicalId,
    canonicalName: displayName(r.canonicalFirstName, r.canonicalLastName),
  }));
}

/** Override one auto-dedup decision ("this contact is NOT a duplicate"): clear its pointer. RLS-scoped. Returns
 *  true iff a currently-flagged row was cleared. */
export async function unmarkContactDuplicate(
  scope: WorkspaceScope,
  contactId: string,
): Promise<boolean> {
  return withTenantTx(scope, (tx) => contactRepository.unmarkDuplicate(tx, contactId));
}
