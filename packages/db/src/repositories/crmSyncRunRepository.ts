// crmSyncRunRepository.ts — the per-batch run ledger + the inbound-event firehose (crm-sync 00 §4.5/§4.6).
// WORKSPACE-scoped under FORCE RLS. Two tables, one file, because they are written by the same code path
// and neither is large enough to earn its own.
//
// crm_sync_runs is the DURABLE metric store — the repo has no metrics backend, so a run row is how anyone
// answers "is this connection healthy" after the fact. It snapshots `mode` at run time, so a shadow run
// that counted-but-did-not-write stays auditable as such (the retention_runs evidence pattern).
//
// crm_inbound_events is the redelivered-webhook wall: append-only, UNIQUE(connection_id, provider_event_id),
// ingested with onConflictDoNothing. `append` returning false IS the dedupe signal — a redelivery must be
// acknowledged with a fast 200 and NOT re-processed.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { crmInboundEvents, crmSyncRuns } from "../schema/crm.ts";

export interface CrmSyncRunStart {
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  provider: string;
  objectType: string;
  direction: "inbound" | "outbound";
  trigger: "backfill" | "scheduled" | "webhook" | "manual" | "replay" | "dsar";
  /** Snapshot of connection.sync_mode AT RUN TIME — not read later, when it may have changed. */
  mode: "disabled" | "shadow" | "enforce";
  syncRunId?: string | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  watermarkBefore?: Date | null;
}

export interface CrmSyncRunCounts {
  recordsSeen?: number;
  recordsCreated?: number;
  recordsUpdated?: number;
  recordsMatched?: number;
  recordsSkipped?: number;
  recordsConflicted?: number;
  recordsFailed?: number;
  apiCalls?: number;
  rateLimitedCt?: number;
}

export const crmSyncRunRepository = {
  /** Open a run row in `running`. The id correlates every later count and the DLQ rows for this batch. */
  async start(tx: Tx, row: CrmSyncRunStart): Promise<string> {
    const inserted = await tx
      .insert(crmSyncRuns)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        connectionId: row.connectionId,
        provider: row.provider,
        objectType: row.objectType,
        direction: row.direction,
        trigger: row.trigger,
        mode: row.mode,
        status: "running",
        syncRunId: row.syncRunId ?? null,
        windowStart: row.windowStart ?? null,
        windowEnd: row.windowEnd ?? null,
        watermarkBefore: row.watermarkBefore ?? null,
      })
      .returning({ id: crmSyncRuns.id });
    return inserted[0]!.id;
  },

  /**
   * Add to the counters. RELATIVE (`col = col + n`), never absolute.
   *
   * A run is processed in pages by code that retries, so a caller that computed a total and wrote it would
   * lose everything counted by a concurrent page or overwrite its own earlier page on retry. Summing in SQL
   * keeps the arithmetic atomic and makes each call safe in isolation.
   */
  async addCounts(tx: Tx, runId: string, counts: CrmSyncRunCounts): Promise<void> {
    await tx
      .update(crmSyncRuns)
      .set({
        ...(counts.recordsSeen
          ? { recordsSeen: sql`${crmSyncRuns.recordsSeen} + ${counts.recordsSeen}` }
          : {}),
        ...(counts.recordsCreated
          ? { recordsCreated: sql`${crmSyncRuns.recordsCreated} + ${counts.recordsCreated}` }
          : {}),
        ...(counts.recordsUpdated
          ? { recordsUpdated: sql`${crmSyncRuns.recordsUpdated} + ${counts.recordsUpdated}` }
          : {}),
        ...(counts.recordsMatched
          ? { recordsMatched: sql`${crmSyncRuns.recordsMatched} + ${counts.recordsMatched}` }
          : {}),
        ...(counts.recordsSkipped
          ? { recordsSkipped: sql`${crmSyncRuns.recordsSkipped} + ${counts.recordsSkipped}` }
          : {}),
        ...(counts.recordsConflicted
          ? {
              recordsConflicted: sql`${crmSyncRuns.recordsConflicted} + ${counts.recordsConflicted}`,
            }
          : {}),
        ...(counts.recordsFailed
          ? { recordsFailed: sql`${crmSyncRuns.recordsFailed} + ${counts.recordsFailed}` }
          : {}),
        ...(counts.apiCalls ? { apiCalls: sql`${crmSyncRuns.apiCalls} + ${counts.apiCalls}` } : {}),
        ...(counts.rateLimitedCt
          ? { rateLimitedCt: sql`${crmSyncRuns.rateLimitedCt} + ${counts.rateLimitedCt}` }
          : {}),
      })
      .where(eq(crmSyncRuns.id, runId));
  },

  /**
   * Close the run. `failedReason` is PII-FREE by contract — a provider code or a short message, never a
   * field value; the run ledger is read by staff across tenants on the health surface.
   */
  async finish(
    tx: Tx,
    runId: string,
    status: "completed" | "partial" | "failed" | "cancelled",
    opts: { watermarkAfter?: Date | null; failedReason?: string | null } = {},
  ): Promise<void> {
    await tx
      .update(crmSyncRuns)
      .set({
        status,
        finishedAt: sql`now()`,
        ...(opts.watermarkAfter !== undefined ? { watermarkAfter: opts.watermarkAfter } : {}),
        ...(opts.failedReason !== undefined ? { failedReason: opts.failedReason } : {}),
      })
      .where(eq(crmSyncRuns.id, runId));
  },

  /** Newest-first runs for a connection — the sync-health read. Index-backed by (connection, started_at). */
  async listRecentForConnection(tx: Tx, connectionId: string, limit: number) {
    return tx
      .select({
        id: crmSyncRuns.id,
        direction: crmSyncRuns.direction,
        objectType: crmSyncRuns.objectType,
        trigger: crmSyncRuns.trigger,
        mode: crmSyncRuns.mode,
        status: crmSyncRuns.status,
        recordsSeen: crmSyncRuns.recordsSeen,
        recordsCreated: crmSyncRuns.recordsCreated,
        recordsUpdated: crmSyncRuns.recordsUpdated,
        recordsFailed: crmSyncRuns.recordsFailed,
        recordsConflicted: crmSyncRuns.recordsConflicted,
        apiCalls: crmSyncRuns.apiCalls,
        startedAt: crmSyncRuns.startedAt,
        finishedAt: crmSyncRuns.finishedAt,
        failedReason: crmSyncRuns.failedReason,
      })
      .from(crmSyncRuns)
      .where(eq(crmSyncRuns.connectionId, connectionId))
      .orderBy(desc(crmSyncRuns.startedAt))
      .limit(limit);
  },
};

export interface CrmInboundEventAppend {
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  provider: string;
  objectType: string;
  crmObjectType: string;
  crmRecordId: string;
  providerEventId: string;
  eventType?: string | null;
  sourceTag?: string | null;
}

export const crmInboundEventRepository = {
  /**
   * Append an inbound event, idempotently.
   *
   * Returns `{ id, isNew }`. `isNew === false` means this is a REDELIVERY: the webhook route should return
   * 200 (so the provider stops retrying) and must NOT enqueue processing again. Providers redeliver
   * aggressively and at-least-once, so this is the normal path, not an edge case.
   *
   * onConflictDoNothing returns no row on conflict, so the id is re-read — the extra select only happens on
   * the duplicate path.
   */
  async append(tx: Tx, row: CrmInboundEventAppend): Promise<{ id: string; isNew: boolean }> {
    const inserted = await tx
      .insert(crmInboundEvents)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        connectionId: row.connectionId,
        provider: row.provider,
        objectType: row.objectType,
        crmObjectType: row.crmObjectType,
        crmRecordId: row.crmRecordId,
        providerEventId: row.providerEventId,
        eventType: row.eventType ?? null,
        sourceTag: row.sourceTag ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: crmInboundEvents.id });

    if (inserted[0]) return { id: inserted[0].id, isNew: true };

    const existing = await tx
      .select({ id: crmInboundEvents.id })
      .from(crmInboundEvents)
      .where(
        and(
          eq(crmInboundEvents.connectionId, row.connectionId),
          eq(crmInboundEvents.providerEventId, row.providerEventId),
        ),
      )
      .limit(1);
    return { id: existing[0]!.id, isNew: false };
  },

  /**
   * NOTE ON THE MISSING `markProcessed`.
   *
   * crm_inbound_events is APPEND-ONLY under FORCE RLS (SELECT + INSERT policies only), so `process_status`
   * cannot be advanced by leadwolf_app at all — an UPDATE silently affects zero rows rather than raising.
   * Offering a markProcessed here would therefore be a method that appears to work and does nothing.
   *
   * Processing state lives in the job (BullMQ) and in crm_sync_runs, both of which are mutable by design.
   * The column stays on the table as the seam for a future owner-connection reconciler; if that reconciler
   * is built it belongs on the privileged path, next to the staff DLQ console.
   */

  /** Unprocessed events for a connection — index-backed by (connection, process_status, received_at). */
  async listPending(tx: Tx, connectionId: string, limit: number) {
    return tx
      .select({
        id: crmInboundEvents.id,
        crmObjectType: crmInboundEvents.crmObjectType,
        crmRecordId: crmInboundEvents.crmRecordId,
        objectType: crmInboundEvents.objectType,
        providerEventId: crmInboundEvents.providerEventId,
        receivedAt: crmInboundEvents.receivedAt,
      })
      .from(crmInboundEvents)
      .where(
        and(
          eq(crmInboundEvents.connectionId, connectionId),
          eq(crmInboundEvents.processStatus, "pending"),
        ),
      )
      .orderBy(crmInboundEvents.receivedAt)
      .limit(limit);
  },
};
