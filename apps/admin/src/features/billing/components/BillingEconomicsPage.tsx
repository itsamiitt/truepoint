// BillingEconomicsPage.tsx — the credit-economics dashboard (13a Area 4, 13 §3.4, 07 §9): gross credits sold
// vs consumed, revenue vs metered provider spend, cost-per-reveal and margin, over a selectable trailing
// window. Read-only cross-tenant aggregates from the audited api. Renders async state through the State Kit.
"use client";

import { type Column, DataTable, StatTile, StateSwitch, TpSelect } from "@leadwolf/ui";
import { useEconomics } from "../hooks/useEconomics";
import type { TenantEconomicsRow } from "../types";

const PERIODS = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
  { value: 365, label: "Last 12 months" },
];

/** Integer cents → "$1,234.56". */
function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}
function count(n: number): string {
  return n.toLocaleString();
}

const tenantColumns: Column<TenantEconomicsRow>[] = [
  {
    key: "tenant",
    header: "Tenant",
    sortValue: (t) => t.tenantName,
    cell: (t) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{t.tenantName}</span>,
  },
  {
    key: "revenue",
    header: "Revenue",
    align: "right",
    sortValue: (t) => t.revenueCents,
    cell: (t) => money(t.revenueCents),
  },
  {
    key: "spend",
    header: "Provider spend",
    align: "right",
    sortValue: (t) => t.providerSpendCents,
    cell: (t) => money(t.providerSpendCents),
  },
  {
    key: "margin",
    header: "Margin",
    align: "right",
    sortValue: (t) => t.marginCents,
    cell: (t) => money(t.marginCents),
  },
  {
    key: "reveals",
    header: "Reveals",
    align: "right",
    sortValue: (t) => t.reveals,
    cell: (t) => `${count(t.reveals)} · ${count(t.chargedReveals)} charged`,
  },
  {
    key: "credits",
    header: "Credits sold",
    align: "right",
    sortValue: (t) => t.creditsSold,
    cell: (t) => count(t.creditsSold),
  },
];

export function BillingEconomicsPage() {
  const { summary, tenants, sinceDays, loading, error, setPeriod, reload } = useEconomics();

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Billing economics</h2>
          <p className="tp-page-sub">
            Gross credits sold vs consumed, revenue vs metered provider spend, cost-per-reveal and
            margin — across all tenants.
          </p>
        </div>
        <TpSelect
          aria-label="Period"
          value={String(sinceDays)}
          onChange={(e) => setPeriod(Number(e.currentTarget.value))}
        >
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </TpSelect>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {summary ? (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: 12,
              }}
            >
              <StatTile
                label="Revenue"
                value={money(summary.revenueCents)}
                sublabel={
                  summary.refundedCents > 0 ? `${money(summary.refundedCents)} refunded` : undefined
                }
              />
              <StatTile label="Provider spend" value={money(summary.providerSpendCents)} />
              <StatTile
                label="Gross margin"
                value={money(summary.marginCents)}
                sublabel="revenue − provider spend"
              />
              <StatTile
                label="Cost per reveal"
                value={`$${(summary.costPerRevealCents / 100).toFixed(4)}`}
                sublabel="provider spend ÷ charged reveals"
              />
              <StatTile
                label="Credits sold"
                value={count(summary.creditsSold)}
                sublabel={`${count(summary.creditsConsumed)} consumed`}
              />
              <StatTile
                label="Reveals"
                value={count(summary.reveals)}
                sublabel={`${count(summary.chargedReveals)} charged`}
              />
            </div>
            {tenants && tenants.length > 0 ? (
              <div style={{ marginTop: 24 }}>
                <h3 className="tp-section-title">Top tenants by provider spend</h3>
                <DataTable columns={tenantColumns} rows={tenants} rowKey={(t) => t.tenantId} />
              </div>
            ) : null}
          </>
        ) : null}
      </StateSwitch>
    </div>
  );
}
