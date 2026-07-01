// stripePortProvider.ts — the COMPOSITION layer that wires the Stripe adapter (integrations) into core's
// StripePort (M11 commercial, ADR-0041). This is the ONLY place the app couples the concrete provider to the
// port — core declares the port and never imports integrations (16 §5); the app injects the implementation
// here, so the boundary check (lint:boundaries) stays green. Mirrors aiPortProvider.ts.
//
// The adapter fails closed when STRIPE_SECRET_KEY is unset; callers additionally gate on the per-flow feature
// flag (BILLING_CHECKOUT_ENABLED / BILLING_SUBSCRIPTIONS_ENABLED) before reaching here, so the paid flow stays
// dark until both the key and the flag are set.

import type { StripePort } from "@leadwolf/core";
import { stripeAdapter } from "@leadwolf/integrations";

/** The injected Stripe adapter. Reads its secret key + base URL from config; fails closed if the key is unset. */
export function getStripePort(): StripePort {
  return stripeAdapter();
}
