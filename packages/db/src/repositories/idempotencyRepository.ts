// idempotencyRepository.ts — the stored-response replay store for money endpoints (07 §3, 09 §5). The
// server replays the first response for a seen (tenant, Idempotency-Key) so network retries don't re-run
// the handler; the DB uniques on the money tables remain the real double-charge guard underneath.

import { and, eq } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
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
};
