// editContact.ts — PLAN_03 §1.4 the overlay pin: a hand-edit blocks future enrichment overwrite of that
// field; this is the SETTER. A user edit ALWAYS wins (it's the human asserting the truth) and sets the pin,
// so a subsequent provider enrichment leaves the edited scalar untouched (planFieldWrite skips pinned fields).
// We read the existing provenance, plan the edit (which stamps {src:'user_edit', pin:true, by:<id>} on each
// edited field), and write the edited columns + the new provenance map in ONE workspace-scoped tx (RLS).
// The HTTP transport is PATCH /contacts/:id (apps/api reveal routes; contactFieldEditSchema-validated, scope
// from the verified token), which delegates here.

import { auditRepository, contactRepository, withTenantTx } from "@leadwolf/db";
import type { FieldChangeAuditMetadata } from "@leadwolf/types";
import { planUserEdit } from "./fieldProvenance.ts";

/** The scalar overlay fields a user may hand-edit (PLAN_03 §3.1 CONTACT_PROVENANCE_FIELDS). `null` clears. */
export interface ContactFieldEdits {
  firstName?: string | null;
  lastName?: string | null;
  jobTitle?: string | null;
  seniorityLevel?: string | null;
  department?: string | null;
  locationCountry?: string | null;
  locationCity?: string | null;
}

/**
 * Apply a USER edit to a contact's scalar overlay fields and PIN every edited field (PLAN_03 §1.4): the
 * provenance descriptor for each becomes a user-sourced pin, so future enrichment will not overwrite it.
 * Only the keys actually present on `edits` (value !== undefined) are written and pinned — an omitted field
 * is left as-is, descriptor and all. Runs in one withTenantTx so RLS scopes the read + write to the caller's
 * workspace; a foreign/absent contactId reads `{}` provenance and the UPDATE touches no row.
 */
export async function editContactFields(
  scope: { tenantId: string; workspaceId: string },
  contactId: string,
  edits: ContactFieldEdits,
  userId: string,
): Promise<void> {
  await withTenantTx(scope, async (tx) => {
    const existing = await contactRepository.getFieldProvenance(tx, contactId);
    const edited = Object.keys(edits).filter(
      (k) => edits[k as keyof ContactFieldEdits] !== undefined,
    );
    if (edited.length === 0) return; // nothing to write — no audit noise either
    // Before-values for the field-change audit metadata contract (04 §4): the CLEAR-TEXT scalars only (this
    // path never touches email_enc/phone_enc), read in the SAME tx as the write so the before/after is
    // consistent and the audit row commits or rolls back WITH the mutation (in-tx, never fire-and-forget).
    const before = await contactRepository.getScalarValues(tx, contactId);
    const provenance = planUserEdit(existing, edited, userId, new Date().toISOString());
    await contactRepository.update(tx, contactId, { ...edits, fieldProvenance: provenance });
    // If no visible row was read (foreign/absent id → before = {}), the UPDATE touched nothing; still record
    // the attempt honestly with the requested after-values (RLS made it a no-op — the audit reflects intent).
    const metadata: FieldChangeAuditMetadata = {
      src: "user_edit",
      fields: Object.fromEntries(
        edited.map((f) => [f, { b: before[f] ?? null, a: edits[f as keyof ContactFieldEdits] ?? null }]),
      ),
    };
    await auditRepository.insert(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: userId,
      action: "contact.update",
      entityType: "contact",
      entityId: contactId,
      metadata: metadata as unknown as Record<string, unknown>,
    });
  });
}
