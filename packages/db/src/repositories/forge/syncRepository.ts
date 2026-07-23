// syncRepository — the Forge-side outbox relay primitives (11 §2). Plain functions the @forge/workers sync
// worker adapts to @forge/sync's OutboxStore port (no db→sync/core cycle). drainPending mirrors the shipped
// outboxRelay.ts FOR UPDATE SKIP LOCKED drain (ecosystem-facts §C) so many workers drain with no contention.
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "../../client.ts";
import { masterIdMap, syncOutbox, syncState } from "../../schema/forge.ts";

/** The relay-shaped row (structurally matches @forge/sync's OutboxRow; the worker passes it straight through). */
export interface DrainedOutboxRow {
  id: string;
  eventType: "verified.upserted" | "verified.superseded" | "verified.suppressed";
  aggregateKind:
    | "verified_person"
    | "verified_company"
    | "verified_employment"
    | "verified_email"
    | "verified_phone";
  forgeId: string;
  version: number;
  contentHash: string;
  payload: Record<string, unknown>;
}

/** Drain up to `limit` pending, due outbox rows FOR UPDATE SKIP LOCKED (11 §2). */
export async function drainSyncOutbox(tx: Tx, limit: number): Promise<DrainedOutboxRow[]> {
  const rows = await tx
    .select()
    .from(syncOutbox)
    .where(and(eq(syncOutbox.status, "pending"), lte(syncOutbox.availableAt, sql`now()`)))
    .limit(limit)
    .for("update", { skipLocked: true });

  return rows.map((r) => ({
    id: r.id,
    eventType: r.eventType as DrainedOutboxRow["eventType"],
    aggregateKind: r.aggregateKind as DrainedOutboxRow["aggregateKind"],
    forgeId: r.forgeId ?? "",
    version: r.version,
    contentHash: r.contentHash,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

/** Mark relayed rows dispatched (idempotent apply makes a re-drain of an un-marked row safe). */
export async function markSyncOutboxDispatched(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(syncOutbox)
    .set({ status: "dispatched", dispatchedAt: new Date() })
    .where(inArray(syncOutbox.id, ids));
}

/** Advance a verified record's sync_state to 'synced' after a successful master apply (P-01.20) — the console
 *  "synced" count and reconciliation both read this; it was previously left at 'pending' forever. */
export async function markSyncStateSynced(tx: Tx, verifiedId: string): Promise<void> {
  await tx
    .update(syncState)
    .set({ status: "synced", updatedAt: new Date() })
    .where(eq(syncState.verifiedId, verifiedId));
}

/** Write back the assigned master_id from the /master-sync response (11 §2). */
export async function upsertMasterIdMap(
  tx: Tx,
  row: {
    forgeId: string;
    masterId?: string;
    entityKind: string;
    contentHash: string;
    syncedVersion: number;
  },
): Promise<void> {
  await tx
    .insert(masterIdMap)
    .values({
      forgeId: row.forgeId,
      masterId: row.masterId ?? null,
      entityKind: row.entityKind,
      contentHash: row.contentHash,
      syncedVersion: row.syncedVersion,
    })
    .onConflictDoUpdate({
      target: masterIdMap.forgeId,
      set: {
        masterId: row.masterId ?? null,
        contentHash: row.contentHash,
        syncedVersion: row.syncedVersion,
        updatedAt: new Date(),
      },
    });
}
