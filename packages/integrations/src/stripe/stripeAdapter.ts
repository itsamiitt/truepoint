// stripeAdapter.ts — the Stripe REST adapter that FULFILLS core's StripePort for the OUTBOUND purchase flows
// (M11 commercial, ADR-0041). It IMPLEMENTS the port core declares; core never imports this package (16 §5
// direction: integrations → core). Hand-rolled over the Stripe REST API (no SDK, consistent with the
// SDK-free inbound webhook, 07 §4): Bearer secret key, application/x-www-form-urlencoded bodies with Stripe's
// bracket-nested keys, an Idempotency-Key on writes, and a pinned Stripe-Version.
//
// `fetchStripe` is injectable so contract/unit tests run on RECORDED responses with ZERO live spend + no key
// (mirrors nlSearchAdapter). A missing secret key fails closed: every method throws StripeError("not_configured")
// — the adapter NEVER throws at construction and NEVER reads the key from anywhere but config.

import { env } from "@leadwolf/config";
import {
  type CheckoutSession,
  type CreateCheckoutInput,
  StripeError,
  type StripePort,
  type StripeSubscription,
} from "@leadwolf/core";

/** Injectable transport: one Stripe REST call. `form` is already flattened to Stripe's bracket keys. */
export type FetchStripe = (
  path: string,
  init: {
    method: "GET" | "POST" | "DELETE";
    apiKey: string;
    baseUrl: string;
    form?: Record<string, string>;
    idempotencyKey?: string;
  },
) => Promise<{ status: number; json: unknown }>;

// Stripe pins behavior to a dated API version; keep it explicit so upgrades are deliberate.
const STRIPE_VERSION = "2024-06-20";

/** Default transport: form-encode + POST/GET/DELETE to the Stripe REST API. Replaced by a fixture in tests. */
export const defaultFetchStripe: FetchStripe = async (path, init) => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${init.apiKey}`,
    "stripe-version": STRIPE_VERSION,
  };
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  let body: string | undefined;
  if (init.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  const res = await fetch(`${init.baseUrl}${path}`, { method: init.method, headers, body });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** Flatten a nested object into Stripe's bracket form keys: {a:{b:1}} → {"a[b]":"1"}; arrays use indices. */
function toForm(obj: Record<string, unknown>, prefix = "", out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object" && item !== null)
          toForm(item as Record<string, unknown>, `${key}[${i}]`, out);
        else out[`${key}[${i}]`] = String(item);
      });
    } else if (typeof v === "object") {
      toForm(v as Record<string, unknown>, key, out);
    } else {
      out[key] = String(v);
    }
  }
  return out;
}

export interface StripeAdapterOptions {
  fetchStripe?: FetchStripe;
  apiKey?: string;
  baseUrl?: string;
}

/** Normalize a Stripe subscription object into the port's view. */
function toSubscriptionView(json: unknown): StripeSubscription {
  const s = (json ?? {}) as {
    id?: unknown;
    status?: unknown;
    current_period_end?: unknown;
    cancel_at_period_end?: unknown;
  };
  return {
    id: typeof s.id === "string" ? s.id : "",
    status: typeof s.status === "string" ? s.status : "unknown",
    currentPeriodEnd: typeof s.current_period_end === "number" ? s.current_period_end : null,
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
  };
}

/**
 * Build the Stripe adapter (a StripePort). Reads the secret key + base URL from config; an absent key fails
 * closed at call time with StripeError("not_configured") — never throws here.
 */
export function stripeAdapter(options: StripeAdapterOptions = {}): StripePort {
  const fetchStripe = options.fetchStripe ?? defaultFetchStripe;
  const apiKey = options.apiKey ?? env.STRIPE_SECRET_KEY;
  const baseUrl = options.baseUrl ?? env.STRIPE_API_BASE;

  async function call(
    path: string,
    method: "GET" | "POST" | "DELETE",
    form?: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<unknown> {
    if (!apiKey) throw new StripeError("not_configured", "Stripe is not configured.");
    const { status, json } = await fetchStripe(path, {
      method,
      apiKey,
      baseUrl,
      form,
      idempotencyKey,
    });
    if (status >= 400) {
      const msg =
        (json as { error?: { message?: string } } | null)?.error?.message ??
        `Stripe request failed (${status}).`;
      throw new StripeError("stripe_error", msg);
    }
    return json;
  }

  return {
    async createCustomer(input): Promise<string> {
      const form = toForm({
        name: input.name ?? undefined,
        email: input.email ?? undefined,
        metadata: { tenant_id: input.tenantId },
      });
      const json = (await call("/v1/customers", "POST", form)) as { id?: string };
      if (!json?.id) throw new StripeError("stripe_error", "Stripe did not return a customer id.");
      return json.id;
    },

    async createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession> {
      const lineItem: Record<string, unknown> = { quantity: input.quantity ?? 1 };
      if (input.priceId) {
        lineItem.price = input.priceId;
      } else if (input.priceData) {
        lineItem.price_data = {
          currency: input.priceData.currency,
          unit_amount: input.priceData.amountCents,
          product_data: { name: input.priceData.productName },
        };
      } else {
        throw new StripeError("stripe_error", "Checkout needs a priceId or priceData.");
      }
      const payload: Record<string, unknown> = {
        mode: input.mode,
        customer: input.customerId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        line_items: [lineItem],
        metadata: input.metadata,
      };
      if (input.mode === "payment" && input.paymentIntentMetadata) {
        payload.payment_intent_data = { metadata: input.paymentIntentMetadata };
      }
      if (input.mode === "subscription") {
        payload.subscription_data = { metadata: input.metadata };
      }
      const json = (await call("/v1/checkout/sessions", "POST", toForm(payload))) as {
        id?: string;
        url?: string;
      };
      if (!json?.id || !json?.url)
        throw new StripeError("stripe_error", "Stripe did not return a checkout URL.");
      return { id: json.id, url: json.url };
    },

    async getSubscription(subscriptionId: string): Promise<StripeSubscription> {
      return toSubscriptionView(await call(`/v1/subscriptions/${subscriptionId}`, "GET"));
    },

    async cancelSubscription(
      subscriptionId: string,
      atPeriodEnd = true,
    ): Promise<StripeSubscription> {
      // At period end = a non-punitive cancel (ADR-0012); immediate = DELETE.
      if (atPeriodEnd) {
        return toSubscriptionView(
          await call(
            `/v1/subscriptions/${subscriptionId}`,
            "POST",
            toForm({ cancel_at_period_end: true }),
          ),
        );
      }
      return toSubscriptionView(await call(`/v1/subscriptions/${subscriptionId}`, "DELETE"));
    },

    async createBillingPortalSession(input): Promise<{ url: string }> {
      const json = (await call(
        "/v1/billing_portal/sessions",
        "POST",
        toForm({ customer: input.customerId, return_url: input.returnUrl }),
      )) as { url?: string };
      if (!json?.url)
        throw new StripeError("stripe_error", "Stripe did not return a billing-portal URL.");
      return { url: json.url };
    },
  };
}
