// idempotencyRepository.ts — the stored-response replay store for money endpoints (07 §3, 09 §5). The
// server replays the first response for a seen (tenant, Idempotency-Key) so network retries don't re-run
// the handler; the DB uniques on the money tables remain the real double-charge guard underneath.

import { and, eq, lt, sql } from "drizzle-orm";
import { type TenantScope, type Tx, db, withTenantTx } from "../client.ts";
import { idempotencyKeys } from "../schema/billing.ts";

export interface StoredResponse {
  responseStatus: number;
  responseBody: unknown;
}

/** Sentinel status marking a CLAIMED, still-executing request (perf-audit P2.5). No real HTTP response
 *  carries status 0, and every row written before the claim flow existed carries ≥200 — so the sentinel is
 *  unambiguous, needs no schema change, and pre-existing rows replay exactly as before. */
export const IDEMPOTENCY_IN_FLIGHT_STATUS = 0;

/** The three answers a claim can come back with (see `claim`). */
export type IdempotencyClaim =
  | { outcome: "claimed" }
  | { outcome: "replay"; stored: StoredResponse }
  | { outcome: "in_flight"; ageMs: number };

export const idempotencyRepository = {
  async find(scope: TenantScope, key: string): Promise<StoredResponse | null> {
    return withTenantTx(scope, async (tx: Tx) => {
      const rows = await tx
        .select({
          responseStatus: idempotencyKeys.responseStatus,
          responseBody: idempotencyKeys.responseBody,
        })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.tenantId, scope.tenantId), eq(idempotencyKeys.key, key)))
        .limit(1);
      return rows[0] ?? null;
    });
  },

  /** Store the first response for a key; a concurrent duplicate insert is a silent no-op (unique index). */
  async store(scope: TenantScope, key: string, response: StoredResponse): Promise<void> {
    await withTenantTx(scope, async (tx: Tx) => {
      await tx
        .insert(idempotencyKeys)
        .values({
          tenantId: scope.tenantId,
          key,
          responseStatus: response.responseStatus,
          responseBody: response.responseBody,
        })
        .onConflictDoNothing();
    });
  },

  /**
   * CLAIM-then-execute (perf-audit P2.5): atomically stake this (tenant, key) before the handler runs, so a
   * CONCURRENT duplicate — two clicks, a proxy retry racing the original — gets `in_flight` instead of
   * executing the handler a second time. (The old find→execute→store shape only replayed COMPLETED requests;
   * two in-flight twins both ran, leaving the DB uniques as the only guard.) One transaction:
   *
   *  - INSERT the sentinel row (`ON CONFLICT DO NOTHING`): inserted ⇒ `claimed` — run the handler.
   *  - Conflict + stored response ⇒ `replay` with the first response.
   *  - Conflict + sentinel younger than `takeoverAfterMs` ⇒ `in_flight` — the caller answers 409-retry.
   *  - Conflict + sentinel OLDER ⇒ the claimant died mid-execution (crash between claim and
   *    finalize/release): re-stake it atomically — the UPDATE's WHERE re-checks sentinel + staleness, so of
   *    N concurrent takers exactly one wins `claimed`; the rest stay `in_flight`.
   *
   * Concurrency note: a racing INSERT blocks on the in-flight unique conflict until the rival commits, so
   * the follow-up SELECT always sees the committed row — no window where both claim.
   */
  async claim(scope: TenantScope, key: string, takeoverAfterMs: number): Promise<IdempotencyClaim> {
    return withTenantTx(scope, async (tx: Tx) => {
      const inserted = await tx
        .insert(idempotencyKeys)
        .values({
          tenantId: scope.tenantId,
          key,
          responseStatus: IDEMPOTENCY_IN_FLIGHT_STATUS,
          responseBody: {},
        })
        .onConflictDoNothing()
        .returning({ id: idempotencyKeys.id });
      if (inserted.length > 0) return { outcome: "claimed" };

      const [row] = await tx
        .select({
          responseStatus: idempotencyKeys.responseStatus,
          responseBody: idempotencyKeys.responseBody,
          createdAt: idempotencyKeys.createdAt,
        })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.tenantId, scope.tenantId), eq(idempotencyKeys.key, key)))
        .limit(1);
      // Conflicted yet gone: the retention sweep removed it between statements. Vanishingly rare —
      // treat as claimed; finalize's sentinel-guarded UPDATE simply no-ops and the DB uniques still hold.
      if (!row) return { outcome: "claimed" };

      if (row.responseStatus !== IDEMPOTENCY_IN_FLIGHT_STATUS) {
        return {
          outcome: "replay",
          stored: { responseStatus: row.responseStatus, responseBody: row.responseBody },
        };
      }
      const ageMs = Date.now() - row.createdAt.getTime();
      if (ageMs >= takeoverAfterMs) {
        const cutoff = new Date(Date.now() - takeoverAfterMs);
        const taken = await tx
          .update(idempotencyKeys)
          .set({ createdAt: new Date() })
          .where(
            and(
              eq(idempotencyKeys.tenantId, scope.tenantId),
              eq(idempotencyKeys.key, key),
              eq(idempotencyKeys.responseStatus, IDEMPOTENCY_IN_FLIGHT_STATUS),
              lt(idempotencyKeys.createdAt, cutoff),
            ),
          )
          .returning({ id: idempotencyKeys.id });
        if (taken.length > 0) return { outcome: "claimed" };
      }
      return { outcome: "in_flight", ageMs };
    });
  },

  /** Record the first response onto the CLAIMED row. Guarded on the sentinel: if a stale-takeover rival
   *  finalized first, the loser's late finalize no-ops and the winner's response is what replays. */
  async finalize(scope: TenantScope, key: string, response: StoredResponse): Promise<void> {
    await withTenantTx(scope, async (tx: Tx) => {
      await tx
        .update(idempotencyKeys)
        .set({ responseStatus: response.responseStatus, responseBody: response.responseBody })
        .where(
          and(
            eq(idempotencyKeys.tenantId, scope.tenantId),
            eq(idempotencyKeys.key, key),
            eq(idempotencyKeys.responseStatus, IDEMPOTENCY_IN_FLIGHT_STATUS),
          ),
        );
    });
  },

  /** Release a claim after a FAILED handler (failures are never replayed — a retry must re-execute,
   *  exactly the pre-claim semantics). Sentinel-guarded like finalize. */
  async release(scope: TenantScope, key: string): Promise<void> {
    await withTenantTx(scope, async (tx: Tx) => {
      await tx
        .delete(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.tenantId, scope.tenantId),
            eq(idempotencyKeys.key, key),
            eq(idempotencyKeys.responseStatus, IDEMPOTENCY_IN_FLIGHT_STATUS),
          ),
        );
    });
  },

  /**
   * PLATFORM (owner-connection) replay lookup — for the super-admin money endpoints, which run on the
   * BYPASSRLS owner path (withPlatformTx), NOT the tenant app role. Keyed by the TARGET tenant + key, and read
   * OUTSIDE any tx (a mere replay check writes nothing and needs no audit row). The owner mirror of `find`.
   */
  async findOwner(tenantId: string, key: string): Promise<StoredResponse | null> {
    const rows = await db
      .select({
        responseStatus: idempotencyKeys.responseStatus,
        responseBody: idempotencyKeys.responseBody,
      })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.tenantId, tenantId), eq(idempotencyKeys.key, key)))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * PLATFORM store — record the first response INSIDE the caller's withPlatformTx OWNER tx, so the key row
   * commits ATOMICALLY with the money mutation + its audit row (a rolled-back grant leaves no key behind). A
   * concurrent duplicate is a silent no-op (the unique (tenant, key) index). The owner mirror of `store`.
   */
  async storeOwner(tx: Tx, tenantId: string, key: string, response: StoredResponse): Promise<void> {
    await tx
      .insert(idempotencyKeys)
      .values({
        tenantId,
        key,
        responseStatus: response.responseStatus,
        responseBody: response.responseBody,
      })
      .onConflictDoNothing();
  },

  /**
   * Retention sweep (M12 P6): delete stored idempotency keys older than `olderThanDays`. SYSTEM path — runs
   * on the owner connection (cross-tenant), like the Stripe grant; the keys are a replay cache, safe to expire
   * once no client could still retry. Returns the number of rows reclaimed. Run leader-locked + batched.
   */
  async deleteExpired(olderThanDays: number, batchLimit = 5000): Promise<number> {
    const rows = (await db.execute(sql`
      DELETE FROM idempotency_keys
       WHERE id IN (
         SELECT id FROM idempotency_keys
          WHERE created_at < now() - (${olderThanDays} * interval '1 day')
          LIMIT ${batchLimit}
       )
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return rows.length;
  },
};
