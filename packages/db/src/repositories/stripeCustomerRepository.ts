// stripeCustomerRepository.ts — the tenant ↔ Stripe customer linkage (M11 checkout, ADR-0041). One row per
// tenant (tenant_id PK). Written on the tenant's first checkout (the customer object is created via the
// StripePort, then linked here); read to reuse the same customer on later purchases + subscriptions. Runs
// under the caller's tenant-scoped tx — stripe_customers is ENABLE-RLS on app.current_tenant_id (billing.sql).

import { eq } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { stripeCustomers } from "../schema/billing.ts";

export const stripeCustomerRepository = {
  /** The tenant's linked Stripe customer id (cus_…), or null. */
  async getByTenant(scope: TenantScope, tx?: Tx): Promise<string | null> {
    const run = async (t: Tx): Promise<string | null> => {
      const rows = await t
        .select({ id: stripeCustomers.stripeCustomerId })
        .from(stripeCustomers)
        .where(eq(stripeCustomers.tenantId, scope.tenantId))
        .limit(1);
      return rows[0]?.id ?? null;
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },

  /** Link a tenant to its Stripe customer (idempotent on tenant_id — a concurrent create is a no-op). */
  async link(scope: TenantScope, stripeCustomerId: string, tx?: Tx): Promise<void> {
    const run = async (t: Tx): Promise<void> => {
      await t
        .insert(stripeCustomers)
        .values({ tenantId: scope.tenantId, stripeCustomerId })
        .onConflictDoNothing({ target: stripeCustomers.tenantId });
    };
    if (tx) return run(tx);
    await withTenantTx(scope, run);
  },
};
