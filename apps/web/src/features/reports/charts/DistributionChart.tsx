// DistributionChart.tsx — a single horizontal 100%-stacked SVG bar showing how contacts split across email
// verification statuses (Data health). This is the ONE Reports chart that earns color: each segment uses its
// status tone (valid=success, risky/catch_all=warning, invalid=danger, unverified/unknown=muted) per the
// prospect glyph mapping (04 §1). Segments below a visible threshold are still drawn as a sliver. No chart lib;
// pure rect math. Presentational; PII-free counts in. The legend/exact figures live in the section's list.
"use client";

import type { StatusTone } from "@leadwolf/ui";
import styles from "./charts.module.css";

export interface DistributionSegment {
  key: string;
  label: string;
  value: number;
  tone: StatusTone;
}

const HEIGHT = 18;
const PAD_X = 1;

// Values are typed `string | undefined` because Next types CSS-module classes via an index signature; the
// className prop accepts that directly and every key here exists in charts.module.css.
const TONE_CLASS: Record<StatusTone, string | undefined> = {
  success: styles.toneSuccess,
  warning: styles.toneWarning,
  danger: styles.toneDanger,
  muted: styles.toneMuted,
};

export function DistributionChart({
  segments,
  width = 560,
  ariaLabel,
}: {
  segments: DistributionSegment[];
  width?: number;
  ariaLabel?: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const plotW = Math.max(width - PAD_X * 2, 1);
  let x = PAD_X;

  return (
    <svg
      className={`${styles.chart} ${styles.enter}`}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={ariaLabel}
    >
      <rect x={0} y={0} width={width} height={HEIGHT} rx={4} fill="var(--tp-surface-3)" />
      {total > 0
        ? segments.map((s) => {
            if (s.value <= 0) return null;
            const w = Math.max((s.value / total) * plotW, 1.5);
            const rect = (
              <rect
                key={s.key}
                className={TONE_CLASS[s.tone]}
                x={x}
                y={0}
                width={w}
                height={HEIGHT}
              >
                <title>{`${s.label}: ${s.value.toLocaleString()}`}</title>
              </rect>
            );
            x += w;
            return rect;
          })
        : null}
    </svg>
  );
}
