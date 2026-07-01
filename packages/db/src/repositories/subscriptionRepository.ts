// subscriptionRepository.ts — data access for recurring billing (M11 subscriptions, ADR-0041). The Stripe
// webhook (owner path) upserts subscriptions + opens billing_cycles; the monthly-grant worker (owner path)
// grants due cycles; the billing hub reads the tenant's own subscription (RLS-scoped). Stripe is the source of
// truth for subscription STATE — these writes only mirror it.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { tenants } from "../schema/auth.ts";
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

  /** Set a subscription's status by its Stripe id (owner path) — the dunning `past_due` path + cancels. */
  async setStatusByStripeId(tx: Tx, stripeSubscriptionId: string, status: string): Promise<void> {
    await tx
      .update(subscriptions)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(subscriptions.stripeSubscriptionId, stripeSubscriptionId));
  },

  /** Subscriptions past_due whose period ended more than `graceDays` ago — the dunning sweep's delinquency
   *  signal (owner read across tenants). Stripe drives the actual retry/cancel; this only surfaces the ones a
   *  human may want to look at. Bounded; oldest-delinquent first. */
  async pastDueBeyondGrace(
    tx: Tx,
    graceDays: number,
    limit: number,
  ): Promise<Array<{ id: string; tenantId: string; currentPeriodEnd: Date | null }>> {
    return tx
      .select({
        id: subscriptions.id,
        tenantId: subscriptions.tenantId,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.status, "past_due"),
          sql`${subscriptions.currentPeriodEnd} IS NOT NULL`,
          sql`${subscriptions.currentPeriodEnd} < now() - make_interval(days => ${graceDays})`,
        ),
      )
      .orderBy(subscriptions.currentPeriodEnd)
      .limit(limit);
  },

  /** Suspend a tenant for DUNNING (M11 subs, ADR-0041) — ONLY if it is currently ACTIVE, so a staff suspension
   *  is never clobbered and an already-suspended tenant is untouched. Tagged suspension_reason='dunning' so it
   *  can be auto-lifted when payment resumes. Returns rows touched (0 = it wasn't active). */
  async suspendForDunning(tx: Tx, tenantId: string): Promise<number> {
    const updated = await tx
      .update(tenants)
      .set({ status: "suspended", suspensionReason: "dunning", updatedAt: new Date() })
      .where(and(eq(tenants.id, tenantId), eq(tenants.status, "active")))
      .returning({ id: tenants.id });
    return updated.length;
  },

  /** Lift a DUNNING suspension when payment resumes (or the subscription cancels to free) — ONLY a 'dunning'
   *  suspension is auto-lifted; a 'staff' (or legacy null) suspension is left for a human (M11 subs, ADR-0041).
   *  Returns rows touched (0 = it wasn't a dunning suspension). */
  async reactivateFromDunning(tx: Tx, tenantId: string): Promise<number> {
    const updated = await tx
      .update(tenants)
      .set({ status: "active", suspensionReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(tenants.id, tenantId),
          eq(tenants.status, "suspended"),
          eq(tenants.suspensionReason, "dunning"),
        ),
      )
      .returning({ id: tenants.id });
    return updated.length;
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
   *  un-granted (the immutability trigger blocks a re-grant). grantLedgerId may be null (a zero-grant cycle). */
  async markGranted(tx: Tx, cycleId: string, grantLedgerId: string | null): Promise<void> {
    await tx
      .update(billingCycles)
      .set({ grantedAt: sql`now()`, grantLedgerId, status: "granted" })
      .where(eq(billingCycles.id, cycleId));
  },
};
