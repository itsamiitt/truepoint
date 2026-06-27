// supportNoteRepository.ts — data access for support_notes (13a Area 3). Every method takes the transaction
// handed by withPlatformTx (owner connection, audited), so a note write and its platform_audit_log row share
// one transaction. Reads are bounded — no unbounded scans (ADR-0032).

import { desc, eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { supportNotes } from "../schema/platformOps.ts";

export interface SupportNoteRow {
  id: string;
  tenantId: string;
  staffUserId: string;
  body: string;
  ticketUrl: string | null;
  createdAt: Date;
}

const NOTES_LIMIT = 200;

export const supportNoteRepository = {
  /** Append a note to a tenant. Returns the created row (for an optimistic console insert). */
  async add(
    tx: Tx,
    input: { tenantId: string; staffUserId: string; body: string; ticketUrl: string | null },
  ): Promise<SupportNoteRow> {
    const [row] = await tx
      .insert(supportNotes)
      .values({
        tenantId: input.tenantId,
        staffUserId: input.staffUserId,
        body: input.body,
        ticketUrl: input.ticketUrl,
      })
      .returning();
    return row as SupportNoteRow;
  },

  /** The notes for one tenant, newest first, bounded. */
  async listForTenant(tx: Tx, tenantId: string): Promise<SupportNoteRow[]> {
    const rows = await tx
      .select()
      .from(supportNotes)
      .where(eq(supportNotes.tenantId, tenantId))
      .orderBy(desc(supportNotes.id))
      .limit(NOTES_LIMIT);
    return rows as SupportNoteRow[];
  },
};
