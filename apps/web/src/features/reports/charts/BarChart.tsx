// BarChart.tsx — a lightweight, token-driven horizontal SVG bar chart for the Reports dashboards (replaces the
// bare CSS .barRow bars). Each datum is a labelled row with a proportional bar + a trailing value caption.
// Monochrome ink by default; an optional per-bar `accent`/`muted` flag promotes/demotes a series. No chart lib.
// Purely presentational; the parent passes already-rolled-up, PII-free numbers. The SVG is exposed as
// role="img" with an aria-label; the exact figures also live in the caller's surrounding table/list.
"use client";

import styles from "./charts.module.css";

export interface BarDatum {
  /** Stable React key + row label. */
  key: string;
  label: string;
  value: number;
  /** Right-aligned caption (e.g. "12 cr · 3 reveals" or "42 · 18%"); falls back to the value. */
  caption?: string;
  /** Promote this bar to the cobalt accent (use sparingly — one series at most). */
  accent?: boolean;
  /** Demote this bar to the muted ink (e.g. funnel off-ramps). */
  muted?: boolean;
}

const ROW_H = 26;
const BAR_H = 10;
const LABEL_W = 116;
const VALUE_W = 92;
const GAP = 12;
const PAD_X = 4;

export function BarChart({
  data,
  max,
  width = 560,
  ariaLabel,
}: {
  data: BarDatum[];
  /** Shared denominator so multiple charts/series stay comparable (≥ 1 to avoid divide-by-zero). */
  max: number;
  width?: number;
  ariaLabel?: string;
}) {
  const safeMax = Math.max(max, 1);
  const height = Math.max(data.length * ROW_H, ROW_H);
  const trackX = PAD_X + LABEL_W + GAP;
  const trackW = Math.max(width - trackX - GAP - VALUE_W - PAD_X, 1);

  return (
    <svg
      className={`${styles.chart} ${styles.enter}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
    >
      {data.map((d, i) => {
        const cy = i * ROW_H + ROW_H / 2;
        const barW = Math.max((d.value / safeMax) * trackW, d.value > 0 ? 2 : 0);
        const fill = d.accent ? styles.barAccent : d.muted ? styles.barMuted : styles.bar;
        return (
          <g key={d.key}>
            <text
              className={styles.axisLabel}
              x={PAD_X}
              y={cy}
              dominantBaseline="central"
              textAnchor="start"
            >
              {d.label}
            </text>
            <rect
              x={trackX}
              y={cy - BAR_H / 2}
              width={trackW}
              height={BAR_H}
              rx={3}
              fill="var(--tp-surface-3)"
            />
            <rect
              className={fill}
              x={trackX}
              y={cy - BAR_H / 2}
              width={barW}
              height={BAR_H}
              rx={3}
            />
            <text
              className={styles.valueLabel}
              x={width - PAD_X}
              y={cy}
              dominantBaseline="central"
              textAnchor="end"
            >
              {d.caption ?? d.value.toLocaleString()}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
