// subscriptionRepository.ts — data access for recurring billing (M11 subscriptions, ADR-0041). The Stripe
// webhook (owner path) upserts subscriptions + opens billing_cycles; the monthly-grant worker (owner path)
// grants due cycles; the billing hub reads the tenant's own subscription (RLS-scoped). Stripe is the source of
// truth for subscription STATE — these writes only mirror it.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { billingCycles, subscriptions } from "../schema/subscriptions.ts";

export interface SubscriptionRow {
  id: string;
  planTemplateKey: string;
  status: string;
  term: string;
  autoRenew: boolean;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface UpsertSubscriptionInput {
  tenantId: string;
  planTemplateKey: string;
  stripeSubscriptionId: string;
  status: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export const subscriptionRepository = {
  /** The tenant's active-ish subscription for the billing hub (RLS-scoped read), or null. */
  async getForTenant(scope: TenantScope, tx?: Tx): Promise<SubscriptionRow | null> {
    const run = async (t: Tx): Promise<SubscriptionRow | null> => {
      const [row] = await t
        .select({
          id: subscriptions.id,
          planTemplateKey: subscriptions.planTemplateKey,
          status: subscriptions.status,
          term: subscriptions.term,
          autoRenew: subscriptions.autoRenew,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
        })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.tenantId, scope.tenantId),
            sql`${subscriptions.status} IN ('trialing','active','past_due','paused')`,
          ),
        )
        .orderBy(desc(subscriptions.createdAt))
        .limit(1);
      return row ?? null;
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },

  /** Upsert a subscription from a Stripe webhook (owner path), keyed on stripe_subscription_id. Returns the id. */
  async upsertFromStripe(tx: Tx, input: UpsertSubscriptionInput): Promise<string> {
    const [row] = await tx
      .insert(subscriptions)
      .values({
        tenantId: input.tenantId,
        planTemplateKey: input.planTemplateKey,
        stripeSubscriptionId: input.stripeSubscriptionId,
        status: input.status,
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
      })
      .onConflictDoUpdate({
        target: subscriptions.stripeSubscriptionId,
        set: {
          status: input.status,
          planTemplateKey: input.planTemplateKey,
          currentPeriodStart: input.currentPeriodStart,
          currentPeriodEnd: input.currentPeriodEnd,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: subscriptions.id });
    return row!.id;
  },
};

/** One billing cycle the monthly-grant worker still owes a grant. */
export interface DueCycleRow {
  id: string;
  tenantId: string;
  subscriptionId: string;
  grantCredits: number;
}

export const billingCycleRepository = {
  /** Open a billing cycle for a period (idempotent on (subscription_id, period_start)) — the webhook calls this
   *  on subscription creation + each renewal. grant_credits is the plan's monthly grant snapshot. */
  async openCycle(
    tx: Tx,
    input: {
      tenantId: string;
      subscriptionId: string;
      periodStart: Date;
      periodEnd: Date;
      grantCredits: number;
    },
  ): Promise<void> {
    await tx
      .insert(billingCycles)
      .values({
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        grantCredits: input.grantCredits,
      })
      .onConflictDoNothing({ target: [billingCycles.subscriptionId, billingCycles.periodStart] });
  },

  /** Open cycles whose period has started but aren't granted yet — the monthly-grant/reset worker's sweep. */
  async dueForGrant(tx: Tx, limit: number): Promise<DueCycleRow[]> {
    return tx
      .select({
        id: billingCycles.id,
        tenantId: billingCycles.tenantId,
        subscriptionId: billingCycles.subscriptionId,
        grantCredits: billingCycles.grantCredits,
      })
      .from(billingCycles)
      .where(
        and(
          isNull(billingCycles.grantedAt),
          eq(billingCycles.status, "open"),
          sql`${billingCycles.periodStart} <= now()`,
        ),
      )
      .orderBy(billingCycles.periodStart)
      .limit(limit);
  },

  /** Mark a cycle granted (worker) — set granted_at + the grant ledger link + status. Allowed only while
   *  un-granted (the immutability trigger blocks a re-grant). */
  async markGranted(tx: Tx, cycleId: string, grantLedgerId: string): Promise<void> {
    await tx
      .update(billingCycles)
      .set({ grantedAt: sql`now()`, grantLedgerId, status: "granted" })
      .where(eq(billingCycles.id, cycleId));
  },
};
