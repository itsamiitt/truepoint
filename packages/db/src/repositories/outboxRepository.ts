// outboxRepository.ts — data access for the transactional outbox (ADR-0027; worker-platform plan 15 §5 —
// Phase 3). Two sides, two connections:
//   WRITE  — enqueueInTx runs inside the CALLER's withTenantTx (leadwolf_app, RLS WITH CHECK): the publish
//            intent commits ATOMICALLY with the business transition ("DB commit ⇒ event published").
//   DRAIN  — claim/settle run on the base OWNER connection (`db`, the notificationRepository precedent):
//            the relay is a cross-tenant SYSTEM path. claimPendingBatch uses FOR UPDATE SKIP LOCKED so N
//            relay replicas drain in parallel with no leader and no contention (re-audit F1 — leaderless,
//            continuous; only the SKIP LOCKED drain idea is shared with projectorRepository, never its
//            leader lock or daily cadence, F2).
// Delivery contract: AT-LEAST-ONCE. A claimed row stays `pending` until markPublished, so a crash between
// publish and settle re-publishes on a later claim — consumers dedupe by stable BullMQ jobId. `attempts`
// increments at claim time; a row claimed MAX_PUBLISH_ATTEMPTS times without settling is marked `failed`
// (poison containment) and surfaces via the oldest-pending/failed metrics.

import { asc, eq, inArray, sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { workerOutbox } from "../schema/workerOutbox.ts";

/** A publish intent, written in the same tenant tx as the business transition that requires it. */
export interface OutboxEnqueue {
  tenantId: string;
  workspaceId: string;
  topic: string;
  /** The queue DTO to publish verbatim — PII-free by contract (jobId + scope, never rows). */
  payload: unknown;
}

/** A claimed pending row the relay must publish then settle. */
export interface ClaimedOutboxRow {
  id: string;
  topic: string;
  payload: unknown;
}

/** Claims after which an unsettled row is poison — marked failed instead of spinning forever. */
export const MAX_PUBLISH_ATTEMPTS = 10;

export const outboxRepository = {
  /** Insert the publish intent inside the CALLER's tenant tx — the ADR-0027 atomic coupling point. */
  async enqueueInTx(tx: Tx, row: OutboxEnqueue): Promise<void> {
    await tx.insert(workerOutbox).values({
      tenantId: row.tenantId,
      workspaceId: row.workspaceId,
      topic: row.topic,
      payload: row.payload,
    });
  },

  /**
   * Claim up to `limit` oldest pending rows (owner connection). FOR UPDATE SKIP LOCKED → concurrent relay
   * replicas each claim disjoint rows. Claiming increments `attempts` and fails-out rows that have already
   * been claimed MAX_PUBLISH_ATTEMPTS times (returned rows are the live ones to publish). Rows stay
   * `pending` until markPublished — see the at-least-once contract in the header.
   */
  async claimPendingBatch(limit: number): Promise<ClaimedOutboxRow[]> {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: workerOutbox.id,
          topic: workerOutbox.topic,
          payload: workerOutbox.payload,
          attempts: workerOutbox.attempts,
        })
        .from(workerOutbox)
        .where(eq(workerOutbox.status, "pending"))
        .orderBy(asc(workerOutbox.enqueuedAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (rows.length === 0) return [];

      const poison = rows.filter((r) => r.attempts >= MAX_PUBLISH_ATTEMPTS);
      const live = rows.filter((r) => r.attempts < MAX_PUBLISH_ATTEMPTS);
      if (poison.length > 0) {
        await tx
          .update(workerOutbox)
          .set({
            status: "failed",
            lastError: `publish attempts exhausted (${MAX_PUBLISH_ATTEMPTS})`,
          })
          .where(
            inArray(
              workerOutbox.id,
              poison.map((r) => r.id),
            ),
          );
      }
      if (live.length > 0) {
        await tx
          .update(workerOutbox)
          .set({ attempts: sql`${workerOutbox.attempts} + 1` })
          .where(
            inArray(
              workerOutbox.id,
              live.map((r) => r.id),
            ),
          );
      }
      return live.map(({ id, topic, payload }) => ({ id, topic, payload }));
    });
  },

  /** Settle a published row (owner connection). */
  async markPublished(id: string): Promise<void> {
    await db
      .update(workerOutbox)
      .set({ status: "published", publishedAt: new Date(), lastError: null })
      .where(eq(workerOutbox.id, id));
  },

  /** Terminally fail a row the relay can never publish (unknown topic, malformed payload). */
  async markFailed(id: string, error: string): Promise<void> {
    await db
      .update(workerOutbox)
      .set({ status: "failed", lastError: error.slice(0, 500) })
      .where(eq(workerOutbox.id, id));
  },

  /** Relay-lag signal (Phase 4 / re-audit F1): age of the oldest unpublished row, or null when drained. */
  async oldestPendingAgeSeconds(): Promise<number | null> {
    const [row] = await db
      .select({
        age: sql<number | null>`extract(epoch from now() - min(${workerOutbox.enqueuedAt}))`,
      })
      .from(workerOutbox)
      .where(eq(workerOutbox.status, "pending"));
    return row?.age == null ? null : Number(row.age);
  },
};
