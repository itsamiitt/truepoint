// routes.ts — HTTP wiring for the billing domain (07, 09 §3.4): the Stripe webhook (signature-verified,
// no session auth — it is the ONLY place credits are granted) and the authenticated credits surface
// (balance + usage history for Settings ▸ Billing & Credits). Transport only; grant idempotency and the
// counter invariants live in core/db.

import { appOrigins, env } from "@leadwolf/config";
import {
  StripeError,
  grantFromStripe,
  parseCreditGrantEvent,
  verifyStripeSignature,
} from "@leadwolf/core";
import {
  creditPackRepository,
  creditRepository,
  planTemplateRepository,
  revealRepository,
  stripeCustomerRepository,
  tenantRepository,
  withPlatformReadTx,
} from "@leadwolf/db";
import {
  type CreditLedgerEntry,
  ForbiddenError,
  NotFoundError,
  type TenantPlanEnvelope,
  ValidationError,
  creditCheckoutSchema,
  usageQuerySchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { getStripePort } from "./stripePortProvider.ts";

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

creditsRoutes.get("/balance", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const balance = await creditRepository.getBalance({ tenantId: c.get("tenantId") });
  return c.json({ balance });
});

// The tenant's plan + credits + live seat/workspace usage — the web billing hub plan tiles (replaces the
// null-tolerant GET /tenants/me the web client used to probe). RLS-scoped read of the tenant's own row; the
// plan display NAME is resolved against the owner-only plan-template catalog (non-PII), incl. grandfathered keys.
creditsRoutes.get("/me", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const tenantId = c.get("tenantId");
  const profile = await tenantRepository.getBillingProfile(tenantId);
  if (!profile) throw new NotFoundError("Tenant not found.");
  const planName = await withPlatformReadTx(async (tx) => {
    const tpl = await planTemplateRepository.getByKey(tx, profile.plan);
    return tpl?.name ?? null;
  });
  const plan: TenantPlanEnvelope = {
    plan: profile.plan,
    planName,
    seatLimit: profile.seatLimit,
    seatsUsed: profile.seatsUsed,
    workspaceLimit: profile.workspaceLimit,
    workspacesUsed: profile.workspacesUsed,
    revealCreditBalance: profile.revealCreditBalance,
    features: profile.features,
  };
  return c.json({ plan });
});

// Paid top-up — start a Stripe Checkout Session for a credit pack (M11, ADR-0041). DARK: needs BOTH the flag
// AND a secret key; absent → 501 { available:false } so the web hub's existing "coming soon" degrade shows.
// The credits are granted ONLY by the existing payment_intent.succeeded webhook (metadata stamped here) —
// idempotent, never client-side. Workspace-admin gated (owner|admin).
creditsRoutes.post("/checkout", requireRole("owner", "admin"), async (c) => {
  if (!env.BILLING_CHECKOUT_ENABLED || !env.STRIPE_SECRET_KEY) {
    return c.json({ available: false }, 501);
  }
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to buy credits.");
  const parsed = creditCheckoutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const tenantId = c.get("tenantId");
  const scope = { tenantId, workspaceId };

  const pack = await withPlatformReadTx((tx) =>
    creditPackRepository.getActiveByKey(tx, parsed.data.pack),
  );
  if (!pack) throw new NotFoundError("Credit pack not found.");

  try {
    const stripe = getStripePort();
    // Reuse the tenant's Stripe customer across purchases; create + link on the first checkout.
    let customerId = await stripeCustomerRepository.getByTenant(scope);
    if (!customerId) {
      customerId = await stripe.createCustomer({ tenantId });
      await stripeCustomerRepository.link(scope, customerId);
    }
    const appOrigin = appOrigins()[0] ?? "";
    const session = await stripe.createCheckoutSession({
      mode: "payment",
      ...(pack.stripePriceId
        ? { priceId: pack.stripePriceId }
        : { priceData: { amountCents: pack.priceCents, currency: "usd", productName: pack.name } }),
      customerId,
      successUrl: `${appOrigin}/settings/billing?checkout=success`,
      cancelUrl: `${appOrigin}/settings/billing?checkout=cancelled`,
      metadata: { tenant_id: tenantId, credit_pack_key: pack.key },
      // Phase-1 reuse: stamp the PaymentIntent so the EXISTING payment_intent.succeeded webhook grants.
      paymentIntentMetadata: { tenant_id: tenantId, credits: String(pack.credits) },
    });
    return c.json({ available: true, checkoutUrl: session.url });
  } catch (err) {
    // Never leak the key or Stripe internals: a config gap degrades to "coming soon", else a 502.
    if (err instanceof StripeError)
      return c.json({ available: false }, err.reason === "not_configured" ? 501 : 502);
    throw err;
  }
});

// The customer's own credit history (M11, ADR-0029) — a keyset page of every ledger movement (grants, spends,
// adjustments, subscription resets), newest-first. Tenant-scoped: RLS-isolated under withTenantTx, so a caller
// only ever sees their own tenant's rows. The unified statement behind the billing hub's "Credit history"; for
// a pre-ledger tenant it covers movements from the ledger's introduction onward until the reconciliation
// backfill runs (the UI notes this). PII-free — amounts + reason only.
creditsRoutes.get("/ledger", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const cursor = c.req.query("cursor") || undefined;
  const rawLimit = Number(c.req.query("limit") ?? "30");
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 30;
  const page = await creditRepository.ledgerPage(
    { tenantId: c.get("tenantId") },
    { limit, cursor },
  );
  const entries: CreditLedgerEntry[] = page.rows.map((r) => ({
    id: r.id,
    entryType: r.entryType,
    delta: r.delta,
    balanceAfter: r.balanceAfter,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  }));
  return c.json({ entries, nextCursor: page.nextCursor });
});

const USAGE_CSV_HEADER = [
  "reveal_id",
  "contact_id",
  "reveal_type",
  "data_source",
  "credits",
  "revealed_at",
  "revealed_by",
] as const;

/** Escape a CSV field: quote on delimiter/quote/newline + neutralize a leading formula char (=,+,-,@) so an
 *  exported value can't execute in a spreadsheet (mirrors the admin economics/audit-log export guards). */
function csvField(value: string): string {
  let s = value;
  if (s && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Usage history: a keyset page (?cursor&limit&revealType?&dataSource?&from?&to?) or, with ?format=csv, the
// filtered set as a bounded CSV download. Workspace-scoped via RLS; PII-free (ids/type/source/cost/timestamp).
creditsRoutes.get("/usage", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to view usage.");
  const parsed = usageQuerySchema.safeParse({
    limit: c.req.query("limit"),
    cursor: c.req.query("cursor"),
    revealType: c.req.query("revealType"),
    dataSource: c.req.query("dataSource"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    format: c.req.query("format"),
  });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const q = parsed.data;
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  const filter = {
    revealType: q.revealType,
    dataSource: q.dataSource,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
  };

  if (q.format === "csv") {
    const rows = await revealRepository.listUsageForExport(scope, filter);
    const lines = [USAGE_CSV_HEADER.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r.id,
          r.contactId,
          csvField(r.revealType),
          csvField(r.dataSource),
          String(r.creditsConsumed),
          r.revealedAt.toISOString(),
          r.revealedByUserId,
        ].join(","),
      );
    }
    c.header("content-type", "text/csv; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="credit-usage.csv"');
    return c.body(lines.join("\r\n"));
  }

  const { rows, nextCursor } = await revealRepository.listUsagePage(scope, {
    ...filter,
    limit: q.limit,
    cursor: q.cursor,
  });
  return c.json({ reveals: rows, nextCursor });
});
