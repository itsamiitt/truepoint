// TenantEconomics.tsx — the per-tenant economics drill-down on a tenant's detail (13a Area 4, 07 §9): the
// windowed + lifetime money picture (revenue, provider spend, margin, cost-per-reveal, credits sold/consumed,
// balance, last top-up) over a selectable window. Visible only to billing:read (the api enforces it too); the
// numbers are realized spend — packs-not-subscriptions, so there is NO MRR/ARR (OD-1 decision-gated). Renders
// async state through the State Kit.
"use client";

import { useStaffMe } from "@/lib/staffMe";
import type { EconomicsTrendPoint, TenantEconomicsDetail } from "@leadwolf/types";
import { StatTile, StateSwitch, TpSelect } from "@leadwolf/ui";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { fetchTenantEconomics, fetchTenantEconomicsTrend } from "../api";
import { shortDate } from "../format";

function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

const SPARK_W = 320;
const SPARK_H = 48;

/** Area + line path strings for the consumption sparkline; null when there's nothing to plot. */
function buildSparkPaths(values: number[], max: number): { line: string; area: string } | null {
  if (values.length === 0) return null;
  const stepX = values.length === 1 ? 0 : SPARK_W / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? SPARK_W / 2 : i * stepX;
    const y = SPARK_H - (v / max) * (SPARK_H - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${pts.join(" L")}`;
  return { line, area: `${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z` };
}

const PERIODS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "365 days" },
];

const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
  gap: 12,
};

export function TenantEconomics({ tenantId }: { tenantId: string }) {
  const { canMaybe, loaded } = useStaffMe();
  const canView = canMaybe("billing:read");

  const [sinceDays, setSinceDays] = useState(30);
  const [data, setData] = useState<TenantEconomicsDetail | null>(null);
  const [trend, setTrend] = useState<EconomicsTrendPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, tr] = await Promise.all([
        fetchTenantEconomics(tenantId, sinceDays),
        fetchTenantEconomicsTrend(tenantId, sinceDays),
      ]);
      setData(detail);
      setTrend(tr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load economics");
    } finally {
      setLoading(false);
    }
  }, [tenantId, sinceDays]);

  useEffect(() => {
    if (canView) void reload();
  }, [canView, reload]);

  // Hide the whole section once we know the caller can't view billing (the api also enforces it).
  if (loaded && !canView) return null;

  // Consumption sparkline: the account-level health signal (usage ramping vs going dormant → churn risk).
  const consumed = trend.map((p) => p.creditsConsumed);
  const totalConsumed = consumed.reduce((sum, v) => sum + v, 0);
  const totalReveals = trend.reduce((sum, p) => sum + p.reveals, 0);
  const sparkPaths = buildSparkPaths(consumed, Math.max(1, ...consumed));
  const hasSpark = totalConsumed > 0 && sparkPaths !== null;

  return (
    <div style={{ marginTop: 28 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h3 className="tp-section-title" style={{ margin: 0 }}>
          Economics
        </h3>
        <TpSelect
          aria-label="Economics window"
          value={String(sinceDays)}
          onChange={(e) => setSinceDays(Number(e.target.value))}
        >
          {PERIODS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </TpSelect>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {data ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={GRID}>
              <StatTile
                label={`Revenue · ${sinceDays}d`}
                value={money(data.revenueCents)}
                sublabel={`${data.creditsSold.toLocaleString()} credits sold`}
              />
              <StatTile
                label="Provider spend"
                value={money(data.providerSpendCents)}
                sublabel={`margin ${money(data.marginCents)}`}
              />
              <StatTile
                label="Cost / reveal"
                value={money(data.costPerRevealCents)}
                sublabel={`${data.chargedReveals.toLocaleString()} charged of ${data.reveals.toLocaleString()}`}
              />
              <StatTile
                label="Credits consumed"
                value={data.creditsConsumed.toLocaleString()}
                sublabel={`balance ${data.revealCreditBalance.toLocaleString()}`}
              />
            </div>
            <div style={GRID}>
              <StatTile
                label="Lifetime revenue"
                value={money(data.lifetimeRevenueCents)}
                sublabel={`${data.lifetimeCreditsSold.toLocaleString()} credits sold`}
              />
              <StatTile
                label="Lifetime consumed"
                value={data.lifetimeCreditsConsumed.toLocaleString()}
                sublabel="all-time reveal spend"
              />
              <StatTile
                label="Refunded (lifetime)"
                value={money(data.lifetimeRefundedCents)}
                sublabel={`${money(data.refundedCents)} in window`}
              />
              <StatTile
                label="Last top-up"
                value={data.lastPurchaseAt ? shortDate(data.lastPurchaseAt) : "—"}
                sublabel={`plan ${data.plan}`}
              />
            </div>
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 12,
                  marginBottom: 6,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--tp-ink-2)" }}>
                  Daily consumption
                </span>
                <span className="app-muted" style={{ fontSize: 12 }}>
                  {totalConsumed.toLocaleString()} credits · {totalReveals.toLocaleString()} reveals
                  · {sinceDays}d
                </span>
              </div>
              {hasSpark && sparkPaths ? (
                <svg
                  viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={`Daily credit consumption over the last ${trend.length} days`}
                  style={{ width: "100%", height: 48, display: "block" }}
                >
                  <path d={sparkPaths.area} fill="var(--tp-surface-3)" />
                  <path
                    d={sparkPaths.line}
                    fill="none"
                    stroke="var(--tp-ink-2)"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              ) : (
                <p className="app-muted" style={{ fontSize: 13 }}>
                  No credit consumption in this window.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </StateSwitch>
    </div>
  );
}
