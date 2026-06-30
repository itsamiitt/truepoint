// billing.ts — platform-admin billing / revenue-ops endpoints (13a Area 4, 13 §3.4, 07 §9). Mounted under
// /api/v1/admin/billing, so the parent router already applied authn + platformAdmin. Billing oversight is the
// finance team's surface → super_admin OR billing_ops. The economics read runs through the audited
// withPlatformTx (cross-tenant owner read) and returns aggregates only — never per-tenant PII or row dumps.

import { platformBillingReadRepository, withPlatformTx } from "@leadwolf/db";
import {
  type EconomicsSummary,
  type TenantEconomicsRow,
  ValidationError,
  economicsQuerySchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

export const billingRoutes = new Hono<{ Variables: ApiVariables }>();

// billing:read = super_admin + billing_ops (13a F3 — capability gate, not a hard-coded role list).
billingRoutes.use("*", requireCapability("billing:read"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

/** Credit economics over a trailing window: gross credits sold vs consumed, revenue vs metered provider spend,
 *  cost-per-reveal, and margin (07 §9). cost_micros → cents is /10_000 (matches the provider-config rollup). */
billingRoutes.get("/economics", async (c) => {
  const parsed = economicsQuerySchema.safeParse({ sinceDays: c.req.query("sinceDays") });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { sinceDays } = parsed.data;
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const agg = await withPlatformTx(actorOf(c), "admin.billing_economics", (tx) =>
    platformBillingReadRepository.economicsSummary(tx, since),
  );

  const providerSpendCents = Math.round(agg.providerSpendMicros / 10_000);
  const costPerRevealCents =
    agg.chargedReveals > 0
      ? Math.round((agg.providerSpendMicros / 10_000 / agg.chargedReveals) * 100) / 100
      : 0;

  const summary: EconomicsSummary = {
    sinceDays,
    creditsSold: agg.creditsSold,
    revenueCents: agg.revenueCents,
    refundedCents: agg.refundedCents,
    creditsConsumed: agg.creditsConsumed,
    reveals: agg.reveals,
    chargedReveals: agg.chargedReveals,
    providerSpendCents,
    costPerRevealCents,
    marginCents: agg.revenueCents - providerSpendCents,
  };
  return c.json({ summary });
});

// Top tenants by provider spend over the window — the drill-down behind the rollup (which orgs drive revenue
// and the metered cost). Same audited owner read; bounded server-side. Aggregates only — never per-tenant PII.
const TENANT_ECONOMICS_LIMIT = 50;

billingRoutes.get("/economics/by-tenant", async (c) => {
  const parsed = economicsQuerySchema.safeParse({ sinceDays: c.req.query("sinceDays") });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const since = new Date(Date.now() - parsed.data.sinceDays * 86_400_000);

  const rows = await withPlatformTx(actorOf(c), "admin.billing_economics_by_tenant", (tx) =>
    platformBillingReadRepository.economicsByTenant(tx, since, TENANT_ECONOMICS_LIMIT),
  );

  const tenants: TenantEconomicsRow[] = rows.map((r) => {
    const providerSpendCents = Math.round(r.providerSpendMicros / 10_000);
    return {
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      revenueCents: r.revenueCents,
      creditsSold: r.creditsSold,
      reveals: r.reveals,
      chargedReveals: r.chargedReveals,
      providerSpendCents,
      marginCents: r.revenueCents - providerSpendCents,
    };
  });
  return c.json({ tenants });
});

// CSV export of the per-tenant economics for the window — finance pulls it into a sheet. Itself audited
// ("admin.billing_economics_export", with the window in metadata). Higher row cap than the on-screen table.
const ECONOMICS_EXPORT_CAP = 1000;
const ECONOMICS_CSV_HEADER = [
  "tenant",
  "tenantId",
  "revenueUsd",
  "providerSpendUsd",
  "marginUsd",
  "reveals",
  "chargedReveals",
  "creditsSold",
] as const;

/** Escape a CSV field: quote on delimiter/quote/newline + neutralize a leading formula char (=,+,-,@) so an
 *  exported tenant name can't execute in a spreadsheet (mirrors the audit-log export guard). */
function csvField(value: string): string {
  let s = value;
  if (s && /^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

billingRoutes.get("/economics/by-tenant/export", async (c) => {
  const parsed = economicsQuerySchema.safeParse({ sinceDays: c.req.query("sinceDays") });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { sinceDays } = parsed.data;
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const rows = await withPlatformTx(
    actorOf(c),
    "admin.billing_economics_export",
    (tx) => platformBillingReadRepository.economicsByTenant(tx, since, ECONOMICS_EXPORT_CAP),
    { metadata: { sinceDays } },
  );

  const usd = (cents: number) => (cents / 100).toFixed(2);
  const lines = [ECONOMICS_CSV_HEADER.join(",")];
  for (const r of rows) {
    const providerSpendCents = Math.round(r.providerSpendMicros / 10_000);
    lines.push(
      [
        csvField(r.tenantName),
        r.tenantId,
        usd(r.revenueCents),
        usd(providerSpendCents),
        usd(r.revenueCents - providerSpendCents),
        String(r.reveals),
        String(r.chargedReveals),
        String(r.creditsSold),
      ].join(","),
    );
  }
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", 'attachment; filename="billing-economics-by-tenant.csv"');
  return c.body(lines.join("\r\n"));
});
