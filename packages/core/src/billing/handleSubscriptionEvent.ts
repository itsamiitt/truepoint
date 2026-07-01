// handleSubscriptionEvent.ts — apply a verified Stripe subscription webhook to the DB (M11 subscriptions,
// ADR-0041). Like grantFromStripe, the webhook is the SOURCE OF TRUTH: this runs on the owner connection (a
// SYSTEM write — no staff actor, so no platform_audit_log row) and only mirrors Stripe's state. Idempotent —
// upsert on the stripe id, openCycle on (subscription, period). The credits themselves are NOT granted here;
// the monthly-grant/reset worker grants the opened cycle.

import {
  billingCycleRepository,
  db,
  planTemplateRepository,
  platformAdminWriteRepository,
  subscriptionRepository,
} from "@leadwolf/db";
import type { SubscriptionEvent } from "./stripeWebhook.ts";

function toDate(unixSeconds: number | null): Date | null {
  return unixSeconds === null ? null : new Date(unixSeconds * 1000);
}

/** Apply a subscription lifecycle event on the owner path. Returns whether a subscription row was touched. */
export async function handleSubscriptionEvent(
  event: SubscriptionEvent,
): Promise<{ applied: boolean }> {
  return db.transaction(async (tx) => {
    // Dunning: a failed renewal → past_due, keyed by the stripe id (the invoice carries no tenant metadata).
    if (event.kind === "past_due") {
      await subscriptionRepository.setStatusByStripeId(tx, event.stripeSubscriptionId, "past_due");
      return { applied: true };
    }

    // created/updated/deleted all mirror the subscription row. On cancel we revert the tenant to the free
    // plan's entitlements; on active we apply the subscribed plan.
    const templateKey = event.kind === "deleted" ? "free" : (event.planTemplateKey ?? "free");
    const template = await planTemplateRepository.getByKey(tx, templateKey);

    const subId = await subscriptionRepository.upsertFromStripe(tx, {
      tenantId: event.tenantId,
      // The subscription row records what was subscribed to (history); a cancel keeps that key, status=canceled.
      planTemplateKey: event.planTemplateKey ?? templateKey,
      stripeSubscriptionId: event.stripeSubscriptionId,
      status: event.status,
      currentPeriodStart: toDate(event.currentPeriodStart),
      currentPeriodEnd: toDate(event.currentPeriodEnd),
      cancelAtPeriodEnd: event.cancelAtPeriodEnd,
    });

    // Entitlements follow the plan (seat/workspace caps + feature flags). Credits are NOT granted here — the
    // grant worker does that from the opened cycle. A missing template (e.g. no 'free' plan) leaves entitlements
    // untouched rather than clobbering them.
    if (template) {
      await platformAdminWriteRepository.applyPlan(tx, event.tenantId, {
        plan: template.key,
        seatLimit: template.seatLimit,
        workspaceLimit: template.workspaceLimit,
        features: template.features,
      });
    }

    // Auto-lift a DUNNING suspension (M11 subs, ADR-0041): payment resumed (status back to active) or the
    // subscription cancelled to free — either way the tenant is no longer delinquent. Only a 'dunning'
    // suspension is lifted; a staff suspension is left for a human (the repo WHERE-guards it).
    if (event.kind === "deleted" || event.status === "active") {
      await subscriptionRepository.reactivateFromDunning(tx, event.tenantId);
    }

    // An active subscription with a period → open the cycle so the grant worker can grant it (idempotent on
    // (subscription_id, period_start)). grant_credits snapshots the plan's monthly grant.
    if (
      event.kind === "upsert" &&
      event.currentPeriodStart !== null &&
      event.currentPeriodEnd !== null
    ) {
      await billingCycleRepository.openCycle(tx, {
        tenantId: event.tenantId,
        subscriptionId: subId,
        periodStart: toDate(event.currentPeriodStart) as Date,
        periodEnd: toDate(event.currentPeriodEnd) as Date,
        grantCredits: template?.monthlyCreditGrant ?? 0,
      });
    }

    return { applied: true };
  });
}
