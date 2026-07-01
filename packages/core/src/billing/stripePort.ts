// stripePort.ts — the provider-agnostic Stripe contract for the OUTBOUND purchase flows (M11 commercial,
// ADR-0041). core OWNS this port; the adapter in packages/integrations IMPLEMENTS it via the Stripe REST API
// (16 §5 direction: integrations → core; core NEVER imports integrations). Mirrors the AiPort seam
// (ai/aiPort.ts). The INBOUND webhook (the only place credits are granted) stays SDK-free in stripeWebhook.ts;
// this port is only the calls that need the SECRET key (create customer / checkout session / manage
// subscription). An adapter built without a secret key throws StripeError("not_configured") so the paid flow
// fails closed and stays dark until configured.

/** A hosted Checkout Session — the customer is redirected to `url` to pay. */
export interface CheckoutSession {
  id: string;
  url: string;
}

/** Input for a Checkout Session. `payment` = one-off (credit packs); `subscription` = recurring (plans). */
export interface CreateCheckoutInput {
  mode: "payment" | "subscription";
  /** A pre-created Stripe Price id (price_…). REQUIRED for subscriptions (a recurring Price). */
  priceId?: string;
  /** Inline one-off price for packs with NO pre-created Price — so packs work without any Stripe-dashboard
   *  setup. Ignored when `priceId` is set. `amountCents` in the smallest currency unit. */
  priceData?: { amountCents: number; currency: string; productName: string };
  quantity?: number;
  /** The tenant's Stripe customer id (cus_…). */
  customerId: string;
  successUrl: string;
  cancelUrl: string;
  /** Stamped on the Session. */
  metadata: Record<string, string>;
  /** payment mode ONLY: stamped on the resulting PaymentIntent so the EXISTING payment_intent.succeeded
   *  webhook attributes the grant (Phase-1 reuse — no new webhook event, no double-grant). */
  paymentIntentMetadata?: Record<string, string>;
}

/** A Stripe subscription's state, normalized. */
export interface StripeSubscription {
  id: string;
  status: string; // trialing | active | past_due | canceled | ...
  currentPeriodEnd: number | null; // unix seconds
  cancelAtPeriodEnd: boolean;
}

/** Raised by the adapter on any Stripe error, or when no secret key is configured. App maps to 503/502 —
 *  never leaks the key or raw Stripe internals. */
export class StripeError extends Error {
  readonly reason: "not_configured" | "stripe_error";
  constructor(reason: "not_configured" | "stripe_error", message: string) {
    super(message);
    this.name = "StripeError";
    this.reason = reason;
  }
}

/**
 * The Stripe seam (ADR-0041). Callers inject an adapter; they never embed Stripe calls. Every method needs the
 * secret key; an unconfigured adapter throws StripeError("not_configured").
 */
export interface StripePort {
  /** Idempotently create (or return) a Stripe customer for a tenant; returns the customer id (cus_…). */
  createCustomer(input: {
    tenantId: string;
    email?: string | null;
    name?: string | null;
  }): Promise<string>;
  /** Create a hosted Checkout Session (one-off or subscription). */
  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession>;
  /** Read a subscription's current state (status + period). */
  getSubscription(subscriptionId: string): Promise<StripeSubscription>;
  /** Cancel a subscription — at period end by default (ADR-0012: no punitive immediate cut-off). */
  cancelSubscription(subscriptionId: string, atPeriodEnd?: boolean): Promise<StripeSubscription>;
  /** Create a Stripe Billing Portal session (self-serve manage/cancel/payment method). */
  createBillingPortalSession(input: { customerId: string; returnUrl: string }): Promise<{
    url: string;
  }>;
}
