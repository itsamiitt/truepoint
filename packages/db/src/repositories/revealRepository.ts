// revealRepository.ts — data access for the reveal transaction (reveal domain, 07 §3). Tx-aware pieces the
// core service composes inside ONE withTenantTx: the contact row (with ciphertext, for in-tx decryption by
// core — never returned over HTTP unmasked elsewhere), the idempotent reveal claim, and the usage list.

import type { RevealDataSource, RevealType } from "@leadwolf/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { contactReveals } from "../schema/billing.ts";
import { contacts } from "../schema/contacts.ts";

/** What the reveal transaction needs to know about the contact (RLS already scopes it to the workspace). */
export interface ContactForReveal {
  id: string;
  emailEnc: Uint8Array | null;
  emailBlindIndex: Uint8Array | null;
  emailDomain: string | null;
  emailStatus: string;
  phoneEnc: Uint8Array | null;
  isRevealed: boolean;
}

export interface RevealClaimInput {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  revealedByUserId: string;
  revealType: RevealType;
  dataSource: RevealDataSource;
  creditsConsumed: number;
  revealedFields: string[];
}

export interface RevealUsageRow {
  id: string;
  contactId: string;
  revealType: string;
  creditsConsumed: number;
  revealedAt: Date;
  revealedByUserId: string;
}

export const revealRepository = {
  /** Load the contact inside the reveal tx. Returns null when it doesn't exist in the scoped workspace. */
  async getContactForReveal(tx: Tx, contactId: string): Promise<ContactForReveal | null> {
    const rows = await tx
      .select({
        id: contacts.id,
        emailEnc: contacts.emailEnc,
        emailBlindIndex: contacts.emailBlindIndex,
        emailDomain: contacts.emailDomain,
        emailStatus: contacts.emailStatus,
        phoneEnc: contacts.phoneEnc,
        isRevealed: contacts.isRevealed,
      })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), isNull(contacts.deletedAt))) // tombstones are gone (08 §4.2)
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * The idempotent reveal claim: INSERT … ON CONFLICT (workspace_id, contact_id, reveal_type) DO NOTHING.
   * Returns true when THIS call claimed the reveal (→ charge), false when the workspace copy already owned
   * it (→ free re-reveal). The AFTER INSERT trigger flips contact ownership, first-wins (03 §10).
   */
  async claimReveal(tx: Tx, input: RevealClaimInput): Promise<boolean> {
    const rows = await tx
      .insert(contactReveals)
      .values({ ...input, revealedFields: input.revealedFields })
      .onConflictDoNothing()
      .returning({ id: contactReveals.id });
    return rows.length > 0;
  },

  /** Usage history for Settings ▸ Billing & Credits (07 §9). Workspace-scoped via RLS. */
  async listByWorkspace(scope: TenantScope, limit = 100): Promise<RevealUsageRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: contactReveals.id,
          contactId: contactReveals.contactId,
          revealType: contactReveals.revealType,
          creditsConsumed: contactReveals.creditsConsumed,
          revealedAt: contactReveals.revealedAt,
          revealedByUserId: contactReveals.revealedByUserId,
        })
        .from(contactReveals)
        .where(
          and(
            eq(contactReveals.workspaceId, scope.workspaceId ?? ""),
            eq(contactReveals.tenantId, scope.tenantId),
          ),
        )
        .orderBy(desc(contactReveals.revealedAt))
        .limit(limit),
    );
  },
};
