// Progress.tsx — a thin determinate progress bar (warm-up %, import progress, send throttle, data-health bars).
// Monochrome by default; tones are reserved for genuine status. Presentation only.
import type { CSSProperties } from "react";
import { cn } from "../cn.ts";

export function Progress({
  value,
  max = 100,
  tone = "ink",
  className,
  style,
  label,
}: {
  value: number;
  max?: number;
  tone?: "ink" | "cobalt" | "success" | "warning" | "danger";
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      className={cn("tp-ui-progress", tone !== "ink" && `tp-ui-progress--${tone}`, className)}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
      style={style}
    >
      <div className="tp-ui-progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}
