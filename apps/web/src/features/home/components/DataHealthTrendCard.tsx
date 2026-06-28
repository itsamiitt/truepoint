// DataHealthTrendCard.tsx — the per-workspace FRESHNESS trend over time (10 §5 / 22): the share of contacts
// verified within SLA across the daily Data Health snapshots, as an inline-SVG area sparkline (no chart lib,
// ink-on-grey per 04 §2). Consumes GET /home/data-quality/history. All four async states render through the
// shared WidgetCard → StateSwitch. Mirrors BurnSparkline. Public slice component.
"use client";

import { Skeleton } from "@leadwolf/ui";
import { TrendingUp } from "lucide-react";
import type { DataQualityTrendPoint } from "../types";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

const VIEW_W = 240;
const VIEW_H = 56;

/** fresh / total per snapshot, OLDEST first (the API returns newest first). 0 when a snapshot has no contacts. */
function freshSeries(trend: DataQualityTrendPoint[]): number[] {
  return trend.map((p) => (p.metrics.total > 0 ? p.metrics.fresh / p.metrics.total : 0)).reverse();
}

/** Build the area + line path strings for the 0–1 rate series; null when there's nothing to plot. */
function buildPaths(series: number[]): { line: string; area: string } | null {
  if (series.length === 0) return null;
  const stepX = series.length === 1 ? 0 : VIEW_W / (series.length - 1);
  const points = series.map((r, i) => {
    const x = series.length === 1 ? VIEW_W / 2 : i * stepX;
    const y = VIEW_H - r * (VIEW_H - 4) - 2; // r is already 0–1
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${points.join(" L")}`;
  const area = `${line} L${VIEW_W},${VIEW_H} L0,${VIEW_H} Z`;
  return { line, area };
}

export function DataHealthTrendCard({
  trend,
  loading,
  error,
  onRetry,
}: {
  trend: DataQualityTrendPoint[] | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  const series = trend ? freshSeries(trend) : [];
  const paths = buildPaths(series);
  const latest = series.length > 0 ? series[series.length - 1]! : 0;

  return (
    <WidgetCard
      title="Freshness trend"
      icon={TrendingUp}
      hint="Verified within SLA"
      loading={loading}
      error={error}
      empty={!paths}
      onRetry={onRetry}
      emptyIcon={TrendingUp}
      emptyTitle="No history yet"
      emptyDescription="A daily snapshot captures your data health; the freshness trend charts here within a few days."
      skeleton={
        <div className={styles.sparkWrap}>
          <Skeleton height={56} radius="var(--radius)" />
          <Skeleton width="40%" height={11} />
        </div>
      }
    >
      <div className={styles.sparkWrap}>
        <svg
          className={styles.sparkSvg}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Freshness over the last ${series.length} snapshots`}
        >
          {paths ? (
            <>
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
            </>
          ) : null}
        </svg>
        <div className={styles.sparkFooter}>
          <span>
            Last {series.length} snapshot{series.length === 1 ? "" : "s"}
          </span>
          <span className={styles.sparkTotal}>{Math.round(latest * 100)}% fresh</span>
        </div>
      </div>
    </WidgetCard>
  );
}
