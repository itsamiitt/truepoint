// accountHoldRepository.ts — data access for account_holds (13a Area 7). Every method takes the transaction
// handed by withPlatformTx (owner connection, audited). A hold is active while lifted_at IS NULL; lifting is
// idempotent (only an active hold is touched). Reads are bounded — no unbounded scans (ADR-0032).

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { accountHolds } from "../schema/platformOps.ts";

export interface AccountHoldRow {
  id: string;
  tenantId: string;
  kind: string;
  reason: string;
  placedByUserId: string;
  placedAt: Date;
  liftedAt: Date | null;
  liftedByUserId: string | null;
}

const HOLD_LIMIT = 200;

export const accountHoldRepository = {
  /** Place a hold on a tenant. Returns the created row. */
  async place(
    tx: Tx,
    input: { tenantId: string; kind: string; reason: string; placedByUserId: string },
  ): Promise<AccountHoldRow> {
    const [row] = await tx
      .insert(accountHolds)
      .values({
        tenantId: input.tenantId,
        kind: input.kind,
        reason: input.reason,
        placedByUserId: input.placedByUserId,
      })
      .returning();
    return row as AccountHoldRow;
  },

  /** The holds for one tenant, active first (lifted_at IS NULL), then newest, bounded. */
  async listForTenant(tx: Tx, tenantId: string): Promise<AccountHoldRow[]> {
    const rows = await tx
      .select()
      .from(accountHolds)
      .where(eq(accountHolds.tenantId, tenantId))
      // Active (lifted_at NULL) sorts before lifted; within each, newest id first.
      .orderBy(sql`${accountHolds.liftedAt} IS NOT NULL`, desc(accountHolds.id))
      .limit(HOLD_LIMIT);
    return rows as AccountHoldRow[];
  },

  /** Lift an active hold (scoped to the tenant). Returns rows touched (0 = unknown / already lifted → 404). */
  async lift(tx: Tx, tenantId: string, holdId: string, liftedByUserId: string): Promise<number> {
    const updated = await tx
      .update(accountHolds)
      .set({ liftedAt: sql`now()`, liftedByUserId })
      .where(
        and(
          eq(accountHolds.id, holdId),
          eq(accountHolds.tenantId, tenantId),
          isNull(accountHolds.liftedAt),
        ),
      )
      .returning({ id: accountHolds.id });
    return updated.length;
  },
};
