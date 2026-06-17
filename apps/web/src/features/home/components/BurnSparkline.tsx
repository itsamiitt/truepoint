// BurnSparkline.tsx — daily credit burn for THIS workspace as an inline-SVG area sparkline (no chart lib;
// pure ink-on-grey per 04 §2) plus a thin Progress bar marking the peak day against the busiest. The balance
// is the shared tenant pool; burn here is scoped to the current workspace, so the card says so. All four
// async states render through the shared WidgetCard → StateSwitch. Public slice component.
"use client";

import { Progress, Skeleton } from "@leadwolf/ui";
import { Activity } from "lucide-react";
import type { BurnPoint } from "../types";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

const VIEW_W = 240;
const VIEW_H = 56;

/** Build the area + line path strings for the sparkline; null when there's nothing to plot. */
function buildPaths(burn: BurnPoint[], max: number): { line: string; area: string } | null {
  if (burn.length === 0) return null;
  const stepX = burn.length === 1 ? 0 : VIEW_W / (burn.length - 1);
  const points = burn.map((p, i) => {
    const x = burn.length === 1 ? VIEW_W / 2 : i * stepX;
    const y = VIEW_H - (p.credits / max) * (VIEW_H - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${points.join(" L")}`;
  const area = `${line} L${VIEW_W},${VIEW_H} L0,${VIEW_H} Z`;
  return { line, area };
}

export function BurnSparkline({
  burn,
  loading,
  error,
  onRetry,
}: {
  burn: BurnPoint[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  const max = Math.max(1, ...burn.map((p) => p.credits));
  const paths = buildPaths(burn, max);
  const total = burn.reduce((sum, p) => sum + p.credits, 0);
  const peak = burn.reduce((hi, p) => Math.max(hi, p.credits), 0);

  return (
    <WidgetCard
      title="Credit burn"
      icon={Activity}
      hint="This workspace"
      loading={loading}
      error={error}
      empty={!paths || total === 0}
      onRetry={onRetry}
      emptyIcon={Activity}
      emptyTitle="No burn in this window"
      emptyDescription="Once you start revealing in this workspace, daily credit usage charts here."
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
          aria-label={`Credit burn over the last ${burn.length} days`}
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
        <div className={styles.sparkPeak}>
          <div className={styles.sparkPeakLabel}>
            <span>Peak day</span>
            <span className={styles.sparkTotal}>
              {peak.toLocaleString()} credit{peak === 1 ? "" : "s"}
            </span>
          </div>
          <Progress value={peak} max={max} label="Peak day's credit burn" />
        </div>
        <div className={styles.sparkFooter}>
          <span>Last {burn.length} days</span>
          <span className={styles.sparkTotal}>
            {total.toLocaleString()} total credit{total === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </WidgetCard>
  );
}
