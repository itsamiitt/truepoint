// FunnelChart.tsx — a token-driven SVG funnel for the Pipeline journey (new → in_sequence → replied →
// meeting_booked). Each stage is a centered band whose width is proportional to its count vs. the widest stage;
// successive bands taper, reading as a funnel. Monochrome ink, hairline connectors, stage label + count +
// conversion caption beside each band. No chart lib; pure trapezoid math. Presentational; PII-free counts in.
"use client";

import styles from "./charts.module.css";

export interface FunnelDatum {
  key: string;
  label: string;
  count: number;
  /** Conversion-from-top percentage, shown in the caption. */
  conversionPct: number;
}

const BAND_H = 30;
const GAP = 10;
const PAD = 6;
const CAPTION_W = 150;

export function FunnelChart({
  data,
  max,
  width = 560,
  ariaLabel,
}: {
  data: FunnelDatum[];
  /** The widest stage count (≥ 1) — the full-width reference. */
  max: number;
  width?: number;
  ariaLabel?: string;
}) {
  const safeMax = Math.max(max, 1);
  const height = Math.max(data.length * (BAND_H + GAP) - GAP, BAND_H);
  const plotW = Math.max(width - CAPTION_W - PAD * 2, 1);
  const centerX = PAD + plotW / 2;

  // Half-width of each band; clamp tiny non-zero stages to a visible sliver.
  const halfW = (count: number): number => {
    const w = (count / safeMax) * plotW;
    return Math.max(w, count > 0 ? 3 : 0.6) / 2;
  };

  return (
    <svg
      className={`${styles.chart} ${styles.enter}`}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
    >
      {data.map((d, i) => {
        const top = i * (BAND_H + GAP);
        const bottom = top + BAND_H;
        const hwTop = halfW(d.count);
        // Taper toward the next stage's width so the shape reads as a funnel; last band stays straight.
        const next = data[i + 1];
        const hwBottom = next ? halfW(next.count) : hwTop;
        const points = [
          `${centerX - hwTop},${top}`,
          `${centerX + hwTop},${top}`,
          `${centerX + hwBottom},${bottom}`,
          `${centerX - hwBottom},${bottom}`,
        ].join(" ");
        const midY = top + BAND_H / 2;
        return (
          <g key={d.key}>
            <polygon className={styles.funnelBand} points={points} />
            <text
              className={styles.valueLabel}
              x={width - PAD}
              y={midY}
              dominantBaseline="central"
              textAnchor="end"
            >
              {`${d.label} · ${d.count.toLocaleString()} · ${d.conversionPct}%`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
