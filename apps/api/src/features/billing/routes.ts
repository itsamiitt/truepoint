// routes.ts — HTTP wiring for the billing domain (07, 09 §3.4): the Stripe webhook (signature-verified,
// no session auth — it is the ONLY place credits are granted) and the authenticated credits surface
// (balance + usage history for Settings ▸ Billing & Credits). Transport only; grant idempotency and the
// counter invariants live in core/db.

import { env } from "@leadwolf/config";
import { grantFromStripe, parseCreditGrantEvent, verifyStripeSignature } from "@leadwolf/core";
import { creditRepository, revealRepository } from "@leadwolf/db";
import { ForbiddenError, ValidationError } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

// ── /api/v1/billing — the webhook (unauthenticated; signature is the trust boundary) ───────────────────
export const billingRoutes = new Hono();

billingRoutes.post("/webhook", async (c) => {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret)
    throw new ForbiddenError("webhook_not_configured", "Stripe webhook secret is not configured.");

  const payload = await c.req.text();
  if (!verifyStripeSignature(payload, c.req.header("stripe-signature"), secret)) {
    throw new ValidationError("Invalid Stripe signature.");
  }

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    throw new ValidationError("Webhook payload is not JSON.");
  }

  const grant = parseCreditGrantEvent(event);
  if (!grant) return c.json({ received: true, granted: false }); // ignored event type → 200 so Stripe stops retrying

  const result = await grantFromStripe(grant);
  return c.json({ received: true, granted: result.granted });
});

// ── /api/v1/credits — authenticated balance + usage (the top-bar pill + Settings ▸ Billing) ────────────
export const creditsRoutes = new Hono<{ Variables: TenancyVariables }>();

creditsRoutes.use("*", authn);
creditsRoutes.use("*", tenancy);

creditsRoutes.get("/balance", async (c) => {
  const balance = await creditRepository.getBalance({ tenantId: c.get("tenantId") });
  return c.json({ balance });
});

creditsRoutes.get("/usage", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to view usage.");
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const reveals = await revealRepository.listByWorkspace(
    { tenantId: c.get("tenantId"), workspaceId },
    limit,
  );
  return c.json({ reveals });
});
