// Spinner.tsx — a quiet, monochrome loading indicator (a thin rotating ring in the ink-3 grey). Calm, not
// neon (04 §1). Presentation only; keyframes are injected once via a scoped <style> so it needs no CSS pipeline.
import type { CSSProperties } from "react";

const KEYFRAMES = "@keyframes tp-spin{to{transform:rotate(360deg)}}";

export function Spinner({
  size = 16,
  label = "Loading",
  style,
}: {
  size?: number;
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <output aria-label={label} style={{ display: "inline-flex", alignItems: "center", ...style }}>
      <style>{KEYFRAMES}</style>
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: `${Math.max(1.5, size / 9)}px solid var(--tp-hairline-2)`,
          borderTopColor: "var(--tp-ink-3)",
          animation: "tp-spin 0.7s linear infinite",
          boxSizing: "border-box",
        }}
      />
    </output>
  );
}
