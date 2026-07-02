// eventOutboxRepository.ts — the append + drain surface for the domain-event outbox (reveal-experience
// Phase 4, ADR-0027). `append` is composed INSIDE a writer's withTenantTx (workspace RLS WITH CHECK passes).
// `claimBatch`/`markPublished`/`markFailed` are the RELAY primitives, run on the OWNER connection (RLS is
// ENABLE-not-FORCE, so the owner drains across all workspaces): `FOR UPDATE SKIP LOCKED` lets multiple relay
// instances share the drain without double-publishing.

import { inArray, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { eventOutbox } from "../schema/eventOutbox.ts";

export interface OutboxEventInput {
  tenantId: string;
  workspaceId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface OutboxEventRow {
  id: string;
  tenantId: string;
  workspaceId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export const eventOutboxRepository = {
  /** Append an event IN the caller's state-change tx (crash-safe: commit ⇒ event enqueued). PII-free payload. */
  async append(tx: Tx, input: OutboxEventInput): Promise<void> {
    await tx.insert(eventOutbox).values({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      eventType: input.eventType,
      payload: input.payload,
    });
  },

  /** Claim up to `limit` pending events (owner tx). FOR UPDATE SKIP LOCKED → relay instances don't collide. */
  async claimBatch(tx: Tx, limit: number): Promise<OutboxEventRow[]> {
    const capped = Math.max(1, Math.min(1000, Math.trunc(limit)));
    return (await tx.execute(sql`
      SELECT id, tenant_id AS "tenantId", workspace_id AS "workspaceId", event_type AS "eventType", payload
      FROM event_outbox
      WHERE status = 'pending'
      ORDER BY occurred_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${capped}
    `)) as unknown as OutboxEventRow[];
  },

  /** Mark the successfully-published events (owner tx, inside the same claim tx). */
  async markPublished(tx: Tx, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(eventOutbox)
      .set({ status: "published", publishedAt: sql`now()` })
      .where(inArray(eventOutbox.id, ids));
  },

  /** Bump the attempt count + record the error; flip to `failed` (dead) once attempts exhaust `maxAttempts`. */
  async markFailed(tx: Tx, id: string, error: string, maxAttempts = 5): Promise<void> {
    await tx.execute(sql`
      UPDATE event_outbox
      SET attempts = attempts + 1,
          last_error = ${error.slice(0, 500)},
          status = CASE WHEN attempts + 1 >= ${maxAttempts} THEN 'failed' ELSE 'pending' END
      WHERE id = ${id}
    `);
  },

  /** Prune old published rows (retention). Returns the count deleted. Owner tx. */
  async prunePublished(tx: Tx, olderThan: Date): Promise<number> {
    const rows = (await tx.execute(sql`
      DELETE FROM event_outbox WHERE status = 'published' AND published_at < ${olderThan} RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows.length;
  },
};
