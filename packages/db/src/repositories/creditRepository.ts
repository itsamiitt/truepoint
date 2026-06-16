// creditRepository.ts — data access for the tenant credit counter + Stripe purchases (billing domain,
// 07 §2/§4, ADR-0007). The counter mutations are tx-aware (composed inside the reveal tx / webhook tx);
// the FOR UPDATE lock + the DB CHECK (reveal_credit_balance >= 0) are the double-spend/overdraft guards.

import { sql } from "drizzle-orm";
import { type TenantScope, type Tx, db, withTenantTx } from "../client.ts";
import { contactReveals, purchases } from "../schema/billing.ts";

/** One day of credit burn for the Home sparkline (07 §2). */
export interface BurnByDayRow {
  day: string; // YYYY-MM-DD
  credits: number;
}

export interface GrantInput {
  tenantId: string;
  stripeEventId: string;
  stripePaymentIntentId?: string | null;
  credits: number;
  amountCents?: number | null;
}

export interface GrantResult {
  granted: boolean; // false when the event was already processed (duplicate webhook)
  balanceAfter: number;
}

export const creditRepository = {
  /** Serialize concurrent reveals for one tenant: SELECT … FOR UPDATE on the counter row (07 §3). */
  async lockBalance(tx: Tx, tenantId: string): Promise<number> {
    const rows = (await tx.execute(
      sql`SELECT reveal_credit_balance AS balance FROM tenants WHERE id = ${tenantId} FOR UPDATE`,
    )) as unknown as Array<{ balance: number }>;
    if (rows.length === 0) throw new Error("tenant row not visible in scoped transaction");
    return Number(rows[0]!.balance);
  },

  /** Decrement under the lock taken by lockBalance. The CHECK constraint makes overdraft impossible. */
  async decrement(tx: Tx, tenantId: string, cost: number): Promise<void> {
    await tx.execute(
      sql`UPDATE tenants SET reveal_credit_balance = reveal_credit_balance - ${cost} WHERE id = ${tenantId}`,
    );
  },

  /** Read the balance without locking (free re-reveal path + GET /credits/balance). */
  async currentBalance(tx: Tx, tenantId: string): Promise<number> {
    const rows = (await tx.execute(
      sql`SELECT reveal_credit_balance AS balance FROM tenants WHERE id = ${tenantId}`,
    )) as unknown as Array<{ balance: number }>;
    return rows.length > 0 ? Number(rows[0]!.balance) : 0;
  },

  async getBalance(scope: TenantScope): Promise<number> {
    return withTenantTx(scope, (tx) => creditRepository.currentBalance(tx, scope.tenantId));
  },

  /**
   * Per-day credit burn over the last `days` days for the Home sparkline (07 §2): SUM(credits_consumed)
   * grouped by the reveal day, ascending. Workspace-scoped via RLS — only this workspace's reveals.
   */
  async burnByDay(scope: TenantScope, days = 30): Promise<BurnByDayRow[]> {
    const since = new Date(Date.now() - days * 86_400_000);
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          day: sql<string>`to_char(date_trunc('day', ${contactReveals.revealedAt}), 'YYYY-MM-DD')`,
          credits: sql<number>`coalesce(sum(${contactReveals.creditsConsumed}), 0)::int`,
        })
        .from(contactReveals)
        .where(sql`${contactReveals.revealedAt} >= ${since}`)
        .groupBy(sql`date_trunc('day', ${contactReveals.revealedAt})`)
        .orderBy(sql`date_trunc('day', ${contactReveals.revealedAt}) asc`);
      return rows.map((r) => ({ day: r.day, credits: Number(r.credits) }));
    });
  },

  /**
   * Idempotent Stripe grant (07 §4): credits land ONLY when the purchases insert wins; a duplicate
   * `stripe_event_id` is a no-op. SYSTEM path — runs on the base connection (no tenant GUC: the webhook
   * carries no session), trusted because the event signature was verified at the route.
   */
  async grantFromEvent(input: GrantInput): Promise<GrantResult> {
    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(purchases)
        .values({
          tenantId: input.tenantId,
          stripeEventId: input.stripeEventId,
          stripePaymentIntentId: input.stripePaymentIntentId ?? null,
          credits: input.credits,
          amountCents: input.amountCents ?? null,
        })
        .onConflictDoNothing({ target: purchases.stripeEventId })
        .returning({ id: purchases.id });
      const granted = inserted.length > 0;
      if (granted) {
        await tx.execute(
          sql`UPDATE tenants SET reveal_credit_balance = reveal_credit_balance + ${input.credits}
              WHERE id = ${input.tenantId}`,
        );
      }
      const rows = (await tx.execute(
        sql`SELECT reveal_credit_balance AS balance FROM tenants WHERE id = ${input.tenantId}`,
      )) as unknown as Array<{ balance: number }>;
      return { granted, balanceAfter: rows.length > 0 ? Number(rows[0]!.balance) : 0 };
    });
  },
};
