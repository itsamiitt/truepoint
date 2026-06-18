// LineChart.tsx — a compact, token-driven SVG line + area chart (the 14-day credit-spend trend / sparkline).
// Ink stroke over a faint cobalt-tinted area, hairline baseline, muted endpoint ticks. No chart lib; pure SVG
// path math. Presentational only — the parent supplies pre-bucketed, PII-free day points. Decorative → role=img
// with an aria-label; the precise per-day numbers stay available in the section's accompanying table.
"use client";

import styles from "./charts.module.css";

export interface LinePoint {
  key: string;
  /** X-axis caption (only the first + last are drawn, to stay uncluttered). */
  label: string;
  value: number;
}

const PAD_X = 6;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;

export function LineChart({
  data,
  width = 560,
  height = 120,
  ariaLabel,
}: {
  data: LinePoint[];
  width?: number;
  height?: number;
  ariaLabel?: string;
}) {
  const plotW = Math.max(width - PAD_X * 2, 1);
  const plotH = Math.max(height - PAD_TOP - PAD_BOTTOM, 1);
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length;

  // X spreads points evenly; a single point sits centered. Y inverts so larger values rise.
  const x = (i: number): number => (n <= 1 ? width / 2 : PAD_X + (i / (n - 1)) * plotW);
  const y = (v: number): number => PAD_TOP + (1 - v / max) * plotH;

  const linePts = data.map((d, i) => `${x(i)},${y(d.value)}`);
  const polyBody = linePts.join(" L"); // joined once, reused by both the line and the area path
  const linePath = linePts.length > 0 ? `M${polyBody}` : "";
  const baseline = PAD_TOP + plotH;
  const areaPath =
    linePts.length > 0 ? `M${x(0)},${baseline} L${polyBody} L${x(n - 1)},${baseline} Z` : "";

  const first = data[0];
  const last = data[n - 1];

  return (
    <svg
      className={`${styles.chart} ${styles.enter}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
    >
      <line className={styles.axis} x1={PAD_X} y1={baseline} x2={width - PAD_X} y2={baseline} />
      {areaPath ? <path className={styles.area} d={areaPath} /> : null}
      {linePath ? <path className={styles.line} d={linePath} /> : null}
      {data.map((d, i) => (
        <circle
          key={d.key}
          className={styles.dot}
          cx={x(i)}
          cy={y(d.value)}
          r={d.value > 0 ? 2 : 0}
        />
      ))}
      {first ? (
        <text className={styles.tick} x={PAD_X} y={height - 4} textAnchor="start">
          {first.label}
        </text>
      ) : null}
      {last && n > 1 ? (
        <text className={styles.tick} x={width - PAD_X} y={height - 4} textAnchor="end">
          {last.label}
        </text>
      ) : null}
    </svg>
  );
}
