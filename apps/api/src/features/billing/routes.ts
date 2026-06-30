// routes.ts — HTTP wiring for the billing domain (07, 09 §3.4): the Stripe webhook (signature-verified,
// no session auth — it is the ONLY place credits are granted) and the authenticated credits surface
// (balance + usage history for Settings ▸ Billing & Credits). Transport only; grant idempotency and the
// counter invariants live in core/db.

import { env } from "@leadwolf/config";
import { grantFromStripe, parseCreditGrantEvent, verifyStripeSignature } from "@leadwolf/core";
import {
  creditRepository,
  planTemplateRepository,
  revealRepository,
  tenantRepository,
  withPlatformReadTx,
} from "@leadwolf/db";
import {
  ForbiddenError,
  NotFoundError,
  type TenantPlanEnvelope,
  ValidationError,
  usageQuerySchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
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
