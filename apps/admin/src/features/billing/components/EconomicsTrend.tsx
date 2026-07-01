// EconomicsTrend.tsx — the daily revenue trend for the window as an inline-SVG area sparkline (no chart lib;
// pure ink-on-grey, mirroring the customer home BurnSparkline). Cross-tenant, read-only; data comes from
// useEconomics (GET /admin/billing/economics/trend). Packs revenue is lumpy (spikes on purchase days), so the
// spikes ARE the signal. Empty when there's no revenue in the window (the reveal counts live in the StatTiles).
"use client";

import type { EconomicsTrendPoint } from "../types";

const VIEW_W = 480;
const VIEW_H = 64;

/** Build the area + line path strings for the sparkline; null when there's nothing to plot. */
function buildPaths(values: number[], max: number): { line: string; area: string } | null {
  if (values.length === 0) return null;
  const stepX = values.length === 1 ? 0 : VIEW_W / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? VIEW_W / 2 : i * stepX;
    const y = VIEW_H - (v / max) * (VIEW_H - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${VIEW_W},${VIEW_H} L0,${VIEW_H} Z`;
  return { line, area };
}

function money(cents: number): string {
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

export function EconomicsTrend({ trend }: { trend: EconomicsTrendPoint[] }) {
  const revenue = trend.map((p) => p.revenueCents);
  const totalRevenue = revenue.reduce((sum, v) => sum + v, 0);
  const max = Math.max(1, ...revenue);
  const paths = buildPaths(revenue, max);
  const hasData = totalRevenue > 0 && paths !== null;

  return (
    <div style={{ marginTop: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 8,
        }}
      >
        <h3 className="tp-section-title" style={{ margin: 0 }}>
          Revenue trend
        </h3>
        <span className="app-muted" style={{ fontSize: 12 }}>
          {money(totalRevenue)} over {trend.length} day{trend.length === 1 ? "" : "s"}
        </span>
      </div>
      {hasData ? (
        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Daily revenue over the last ${trend.length} days`}
          style={{ width: "100%", height: 64, display: "block" }}
        >
          <path d={paths.area} fill="var(--tp-surface-3)" />
          <path
            d={paths.line}
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
          No revenue in this window.
        </p>
      )}
    </div>
  );
}
