// crmSyncStateRepository.ts — the per-(connection, object, direction) watermark + backfill cursor
// (crm-sync 00 §4.4). WORKSPACE-scoped under FORCE RLS; every call runs inside withTenantTx.
//
// THE MONOTONIC INVARIANT is the whole point of this file. The watermark is "everything modified at or
// before this instant has been applied". Two things must never happen to it:
//
//   - It must never go BACKWARDS. Jobs are retried and can complete out of order; a late-finishing job for
//     an older window that wrote its own watermark unconditionally would rewind the cursor and cause every
//     record since to be re-pulled — for a large workspace, indefinitely. `advanceWatermark` compares in SQL
//     (GREATEST) rather than in the caller, so no caller can forget.
//   - It must never SKIP. That is why the puller subtracts an overlap window when it reads the watermark
//     rather than starting exactly at it: CRM modstamps are not globally ordered against our clock, so a
//     record written during the previous poll can carry a timestamp just under the mark. Re-seeing a record
//     is free (the content-hash short-circuit and the link table make it a no-op); missing one is silent
//     data loss. `readWithOverlap` makes that subtraction the default rather than each runner's decision.
//
// Inbound and outbound keep SEPARATE rows (00 §6.4): sharing one watermark is how a two-way sync starts
// echoing its own writes back at itself.

import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { crmSyncState } from "../schema/crm.ts";

export type CrmFlowDirection = "inbound" | "outbound";

export interface CrmSyncStateRecord {
  id: string;
  connectionId: string;
  objectType: string;
  direction: string;
  watermark: Date | null;
  replayId: string | null;
  backfillStatus: string;
  backfillCursor: string | null;
  lastRunId: string | null;
}

const columns = {
  id: crmSyncState.id,
  connectionId: crmSyncState.connectionId,
  objectType: crmSyncState.objectType,
  direction: crmSyncState.direction,
  watermark: crmSyncState.watermark,
  replayId: crmSyncState.replayId,
  backfillStatus: crmSyncState.backfillStatus,
  backfillCursor: crmSyncState.backfillCursor,
  lastRunId: crmSyncState.lastRunId,
};

export const crmSyncStateRepository = {
  /**
   * Get the stream row, creating it if this is the first run for the (connection, object, direction).
   *
   * `onConflictDoNothing` + re-select rather than a read-then-insert: two workers starting the same stream
   * concurrently is normal (a webhook and the sweep can race on a fresh connection), and a read-then-insert
   * would make one of them fail on the unique index for no reason.
   */
  async getOrCreate(
    tx: Tx,
    scope: { tenantId: string; workspaceId: string },
    connectionId: string,
    objectType: string,
    direction: CrmFlowDirection,
  ): Promise<CrmSyncStateRecord> {
    await tx
      .insert(crmSyncState)
      .values({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        connectionId,
        objectType,
        direction,
      })
      .onConflictDoNothing();

    const rows = await tx
      .select(columns)
      .from(crmSyncState)
      .where(
        and(
          eq(crmSyncState.connectionId, connectionId),
          eq(crmSyncState.objectType, objectType),
          eq(crmSyncState.direction, direction),
        ),
      )
      .limit(1);
    return rows[0]!;
  },

  /**
   * Advance the watermark MONOTONICALLY. A candidate older than the stored value is ignored.
   *
   * GREATEST(...) with a NULL-safe COALESCE, evaluated in SQL so it is atomic against a concurrent advance
   * from another worker. Returns the value the row now holds, so a caller can tell whether its candidate
   * actually won without a second read.
   */
  async advanceWatermark(
    tx: Tx,
    stateId: string,
    candidate: Date,
    lastRunId?: string | null,
  ): Promise<Date | null> {
    const iso = candidate.toISOString();
    const updated = await tx
      .update(crmSyncState)
      .set({
        watermark: sql`GREATEST(COALESCE(${crmSyncState.watermark}, ${iso}::timestamptz), ${iso}::timestamptz)`,
        updatedAt: sql`now()`,
        ...(lastRunId ? { lastRunId } : {}),
      })
      .where(eq(crmSyncState.id, stateId))
      .returning({ watermark: crmSyncState.watermark });
    return updated[0]?.watermark ?? null;
  },

  /**
   * The watermark minus an overlap window — what a delta pull should actually ask the CRM for.
   *
   * Returns null when there is no watermark yet (the caller should backfill, not pull "since the epoch").
   * The overlap is subtracted here rather than at each call site so a new runner cannot quietly omit it and
   * introduce a silent-data-loss window that only shows up as "some records never synced".
   */
  async readWithOverlap(
    tx: Tx,
    stateId: string,
    overlapMs: number,
  ): Promise<{ since: Date | null; watermark: Date | null }> {
    const rows = await tx
      .select({ watermark: crmSyncState.watermark })
      .from(crmSyncState)
      .where(eq(crmSyncState.id, stateId))
      .limit(1);
    const watermark = rows[0]?.watermark ?? null;
    if (!watermark) return { since: null, watermark: null };
    return { since: new Date(watermark.getTime() - overlapMs), watermark };
  },

  /** Persist the resumable backfill page token + status. */
  async setBackfill(
    tx: Tx,
    stateId: string,
    backfillStatus: "pending" | "running" | "completed",
    backfillCursor?: string | null,
  ): Promise<void> {
    await tx
      .update(crmSyncState)
      .set({
        backfillStatus,
        ...(backfillCursor !== undefined ? { backfillCursor } : {}),
        updatedAt: sql`now()`,
      })
      .where(eq(crmSyncState.id, stateId));
  },

  /** Persist the SFDC CDC replay id (null for HubSpot / poll-based streams). */
  async setReplayId(tx: Tx, stateId: string, replayId: string | null): Promise<void> {
    await tx
      .update(crmSyncState)
      .set({ replayId, updatedAt: sql`now()` })
      .where(eq(crmSyncState.id, stateId));
  },

  /** Every stream for a connection — the sync-health surface's read. */
  async listByConnection(tx: Tx, connectionId: string): Promise<CrmSyncStateRecord[]> {
    return tx.select(columns).from(crmSyncState).where(eq(crmSyncState.connectionId, connectionId));
  },
};
