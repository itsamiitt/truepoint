// UsageSparkline.tsx — daily API calls as an inline-SVG area sparkline. No chart library: the repo has none
// and this is ~40 lines of path math, so adding one to draw a single line would be a dependency the whole
// bundle pays for one card. Same approach the Home credit-burn sparkline already takes.
//
// The SVG carries role="img" and an aria-label with the real numbers, because a screen reader gets nothing
// from a path. The exact figures also live in the card's summary line beside it — the chart is the shape,
// the text is the data.
"use client";

import styles from "../api-usage.module.css";

const VIEW_W = 240;
const VIEW_H = 48;

export interface UsagePoint {
  day: string;
  calls: number;
}

/** Area + line path strings; null when there is nothing to plot. */
function buildPaths(points: UsagePoint[], max: number): { line: string; area: string } | null {
  if (points.length === 0 || max <= 0) return null;
  const stepX = points.length === 1 ? 0 : VIEW_W / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = points.length === 1 ? VIEW_W / 2 : i * stepX;
    // Inset 2px top and bottom so a peak day's stroke is not clipped by the viewBox edge.
    const y = VIEW_H - (p.calls / max) * (VIEW_H - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${coords.join(" L")}`;
  const area = `${line} L${VIEW_W},${VIEW_H} L0,${VIEW_H} Z`;
  return { line, area };
}

export function UsageSparkline({ points }: { points: UsagePoint[] }) {
  const max = Math.max(...points.map((p) => p.calls), 0);
  const paths = buildPaths(points, max);
  if (!paths) return null;

  const total = points.reduce((sum, p) => sum + p.calls, 0);
  return (
    <svg
      className={styles.sparkSvg}
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${total.toLocaleString()} API calls over ${points.length} days, peaking at ${max.toLocaleString()} in a day`}
    >
      <path d={paths.area} className={styles.sparkArea} />
      <path d={paths.line} className={styles.sparkLine} />
    </svg>
  );
}
