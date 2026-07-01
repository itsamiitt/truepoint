// stripeAdapter.test.ts — contract tests for the Stripe adapter on RECORDED responses (injected fetchStripe),
// zero live spend, no real key. Proves: fails closed without a key, form-encodes Stripe's bracket keys
// (metadata[...], line_items[0][price_data][...], payment_intent_data[metadata][...]), and maps 4xx to StripeError.

import { describe, expect, test } from "bun:test";
import { type FetchStripe, stripeAdapter } from "./stripeAdapter.ts";

function capture(responses: Record<string, { status: number; json: unknown }>) {
  const calls: Array<{ path: string; method: string; form?: Record<string, string> }> = [];
  const fetchStripe: FetchStripe = async (path, init) => {
    calls.push({ path, method: init.method, form: init.form });
    return responses[path] ?? { status: 200, json: {} };
  };
  return { calls, fetchStripe };
}

describe("stripeAdapter", () => {
  test("fails closed with no secret key (never reaches the network)", async () => {
    let called = false;
    const fetchStripe: FetchStripe = async () => {
      called = true;
      return { status: 200, json: {} };
    };
    const a = stripeAdapter({ apiKey: undefined, fetchStripe });
    await expect(a.createCustomer({ tenantId: "t1" })).rejects.toMatchObject({
      name: "StripeError",
      reason: "not_configured",
    });
    expect(called).toBe(false);
  });

  test("createCustomer stamps metadata[tenant_id] + returns the id", async () => {
    const { calls, fetchStripe } = capture({
      "/v1/customers": { status: 200, json: { id: "cus_1" } },
    });
    const a = stripeAdapter({ apiKey: "sk_test", baseUrl: "https://stripe.test", fetchStripe });
    const id = await a.createCustomer({ tenantId: "t1", email: "a@b.co" });
    expect(id).toBe("cus_1");
    expect(calls[0]?.form?.["metadata[tenant_id]"]).toBe("t1");
    expect(calls[0]?.form?.email).toBe("a@b.co");
  });

  test("pack checkout: inline price_data + payment_intent metadata (Phase-1 reuse) → returns url", async () => {
    const { calls, fetchStripe } = capture({
      "/v1/checkout/sessions": { status: 200, json: { id: "cs_1", url: "https://pay.stripe" } },
    });
    const a = stripeAdapter({ apiKey: "sk_test", baseUrl: "https://stripe.test", fetchStripe });
    const s = await a.createCheckoutSession({
      mode: "payment",
      priceData: { amountCents: 500, currency: "usd", productName: "Pack 500" },
      customerId: "cus_1",
      successUrl: "https://ok",
      cancelUrl: "https://no",
      metadata: { tenant_id: "t1" },
      paymentIntentMetadata: { tenant_id: "t1", credits: "500" },
    });
    expect(s.url).toBe("https://pay.stripe");
    const form = calls[0]?.form ?? {};
    expect(form.mode).toBe("payment");
    expect(form.customer).toBe("cus_1");
    expect(form["line_items[0][price_data][unit_amount]"]).toBe("500");
    expect(form["line_items[0][price_data][currency]"]).toBe("usd");
    expect(form["payment_intent_data[metadata][credits]"]).toBe("500");
  });

  test("subscription checkout stamps subscription_data metadata + uses the priceId", async () => {
    const { calls, fetchStripe } = capture({
      "/v1/checkout/sessions": { status: 200, json: { id: "cs_2", url: "https://sub.stripe" } },
    });
    const a = stripeAdapter({ apiKey: "sk_test", baseUrl: "https://stripe.test", fetchStripe });
    await a.createCheckoutSession({
      mode: "subscription",
      priceId: "price_pro",
      customerId: "cus_1",
      successUrl: "https://ok",
      cancelUrl: "https://no",
      metadata: { tenant_id: "t1", plan_template_key: "pro" },
    });
    const form = calls[0]?.form ?? {};
    expect(form["line_items[0][price]"]).toBe("price_pro");
    expect(form["subscription_data[metadata][plan_template_key]"]).toBe("pro");
  });

  test("maps a 4xx to StripeError(stripe_error) with the Stripe message", async () => {
    const { fetchStripe } = capture({
      "/v1/checkout/sessions": { status: 400, json: { error: { message: "No such price" } } },
    });
    const a = stripeAdapter({ apiKey: "sk_test", fetchStripe });
    await expect(
      a.createCheckoutSession({
        mode: "payment",
        priceData: { amountCents: 1, currency: "usd", productName: "x" },
        customerId: "c",
        successUrl: "s",
        cancelUrl: "n",
        metadata: {},
      }),
    ).rejects.toMatchObject({ name: "StripeError", reason: "stripe_error" });
  });
});
