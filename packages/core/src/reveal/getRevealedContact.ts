// getRevealedContact.ts — the NO-CHARGE "view already-revealed data" read (Phase 1 read primitive). This is
// what lets an already-revealed contact show its email/phone instantly and persistently, without re-running
// (and re-charging) the reveal. It decrypts email/phone ONLY for the reveal_types this workspace already owns
// (a contact_reveals claim), so it can never surface PII the workspace hasn't paid for. RLS scopes every read
// to the workspace; the decrypt happens IN core (the ciphertext never leaves the server). No credit is spent.

import { type TenantScope, revealRepository, withTenantTx } from "@leadwolf/db";
import type { RevealDataSource, RevealType, RevealedContact } from "@leadwolf/types";
import { decryptPii } from "../import/encryptPii.ts";

export async function getRevealedContact(
  scope: TenantScope & { workspaceId: string },
  contactId: string,
): Promise<RevealedContact | null> {
  return withTenantTx(scope, async (tx) => {
    // Ownership first (PII-free): which reveal_types this workspace holds a claim for.
    const claims = await revealRepository.listContactClaims(tx, scope.workspaceId, contactId);
    const ownedEmail = claims.some(
      (c) => c.revealType === "email" || c.revealType === "full_profile",
    );
    const ownedPhone = claims.some(
      (c) => c.revealType === "phone" || c.revealType === "full_profile",
    );

    const view = await revealRepository.getRevealView(tx, contactId);
    if (!view) return null; // contact gone (tombstoned / never existed in this workspace)

    // Decrypt ONLY owned fields — the ownership check is the security boundary.
    const email = ownedEmail && view.emailEnc ? decryptPii(view.emailEnc) : null;
    const phone = ownedPhone && view.phoneEnc ? decryptPii(view.phoneEnc) : null;

    const revealedFields: string[] = [];
    if (email) revealedFields.push("email");
    if (phone) revealedFields.push("phone");

    const ownedTypes = Array.from(new Set(claims.map((c) => c.revealType))) as RevealType[];

    return {
      contactId,
      email,
      phone,
      // linkedinUrl is a clear-text public URL (not encrypted / charged); surface it once the contact is
      // revealed at all, so the record detail can offer "Copy LinkedIn".
      linkedinUrl: claims.length > 0 ? view.linkedinUrl : null,
      emailStatus: ownedEmail ? view.emailStatus : null,
      phoneStatus: ownedPhone ? view.phoneStatus : null,
      phoneLineType: ownedPhone ? view.phoneLineType : null,
      ownedTypes,
      revealedFields,
      history: claims.map((c) => ({
        revealType: c.revealType as RevealType,
        dataSource: c.dataSource as RevealDataSource,
        creditsConsumed: c.creditsConsumed,
        revealedAt: c.revealedAt.toISOString(),
        revealedByUserId: c.revealedByUserId,
      })),
    };
  });
}
