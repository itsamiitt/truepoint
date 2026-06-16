// BurnSparkline.tsx — daily credit burn for THIS workspace as an inline-SVG area sparkline (no chart lib;
// pure ink-on-grey per 04 §2). Renders loading/empty/error calmly. The balance is the shared tenant pool;
// burn here is scoped to the current workspace, so the card says so explicitly.
"use client";

import { Card, Spinner } from "@leadwolf/ui";
import type { BurnPoint } from "../types";
import styles from "./HomePage.module.css";

const VIEW_W = 240;
const VIEW_H = 56;

/** Build the area + line path strings for the sparkline; null when there's nothing to plot. */
function buildPaths(burn: BurnPoint[]): { line: string; area: string } | null {
  if (burn.length === 0) return null;
  const max = Math.max(1, ...burn.map((p) => p.credits));
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
}: {
  burn: BurnPoint[];
  loading: boolean;
  error: string | null;
}) {
  const paths = buildPaths(burn);
  const total = burn.reduce((sum, p) => sum + p.credits, 0);

  return (
    <Card>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Credit burn</h2>
        <p className={styles.cardHint}>This workspace</p>
      </div>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading burn…
        </div>
      ) : !paths || total === 0 ? (
        <p className={styles.muted}>No credit burn in this workspace over the recent window.</p>
      ) : (
        <div className={styles.sparkWrap}>
          <svg
            className={styles.sparkSvg}
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Credit burn over the last ${burn.length} days`}
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
          <div className={styles.sparkFooter}>
            <span>Last {burn.length} days</span>
            <span className={styles.sparkTotal}>
              {total.toLocaleString()} credit{total === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
