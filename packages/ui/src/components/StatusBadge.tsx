// StatusBadge.tsx — a small status pill (dot + label) whose only job is to render one of four semantic
// tones in the monochrome system; color is the single intentional accent (e.g. email-status). Presentational.
import type { CSSProperties, ReactNode } from "react";

export type StatusTone = "success" | "warning" | "danger" | "muted";

const TONE_VAR: Record<StatusTone, string> = {
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  muted: "var(--tp-ink-4)",
};

export function StatusBadge({
  tone = "muted",
  children,
  style,
}: {
  tone?: StatusTone;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  const color = TONE_VAR[tone];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        border: "1px solid var(--tp-hairline-2)",
        background: "var(--tp-surface)",
        color: "var(--tp-ink-2)",
        fontSize: 12,
        lineHeight: 1.4,
        fontWeight: 500,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: 999, background: color, flex: "0 0 auto" }}
      />
      {children}
    </span>
  );
}
