// idempotencyRepository.ts — the stored-response replay store for money endpoints (07 §3, 09 §5). The
// server replays the first response for a seen (tenant, Idempotency-Key) so network retries don't re-run
// the handler; the DB uniques on the money tables remain the real double-charge guard underneath.

import { and, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, db, withTenantTx } from "../client.ts";
import { idempotencyKeys } from "../schema/billing.ts";

export interface StoredResponse {
  responseStatus: number;
  responseBody: unknown;
}

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
