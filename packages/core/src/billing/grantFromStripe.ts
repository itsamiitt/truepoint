// grantFromStripe.ts — apply a verified Stripe credit grant to the tenant counter, exactly once per
// stripe_event_id (07 §4): the purchases unique insert is the idempotency guard, so duplicate/replayed
// webhooks grant nothing. System path: trusts the route's signature verification, not a user session.

import { type GrantResult, creditRepository } from "@leadwolf/db";
import type { CreditGrantEvent } from "./stripeWebhook.ts";

export async function grantFromStripe(event: CreditGrantEvent): Promise<GrantResult> {
  return creditRepository.grantFromEvent({
    tenantId: event.tenantId,
    stripeEventId: event.stripeEventId,
    stripePaymentIntentId: event.stripePaymentIntentId,
    credits: event.credits,
    amountCents: event.amountCents,
  });
}
