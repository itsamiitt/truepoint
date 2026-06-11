// consentRepository.ts — data access for lawful-basis/consent records (compliance domain, 08 §2).
// Workspace-scoped via RLS; a withdrawal is an UPDATE (withdrawn_at), never a delete — the record of
// having-had-a-basis is itself compliance evidence.

import { and, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { consentRecords } from "../schema/compliance.ts";

export interface ConsentInsert {
  tenantId: string;
  workspaceId: string;
  contactId: string;
  jurisdiction: string;
  lawfulBasis: string;
  source?: string | null;
  validUntil?: Date | null;
  recordedByUserId?: string | null;
}

export const consentRepository = {
  async record(tx: Tx, input: ConsentInsert): Promise<string> {
    const rows = await tx.insert(consentRecords).values(input).returning({ id: consentRecords.id });
    return rows[0]!.id;
  },

  /** Mark every active basis for the contact withdrawn (08 §2: objection/opt-out). Returns count. */
  async withdrawForContact(tx: Tx, contactId: string): Promise<number> {
    const rows = await tx
      .update(consentRecords)
      .set({ withdrawnAt: new Date() })
      .where(and(eq(consentRecords.contactId, contactId), isNull(consentRecords.withdrawnAt)))
      .returning({ id: consentRecords.id });
    return rows.length;
  },

  async listForContact(tx: Tx, contactId: string) {
    return tx
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.contactId, contactId))
      .orderBy(desc(consentRecords.createdAt));
  },
};
