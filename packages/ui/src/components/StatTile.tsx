// StatTile.tsx — a single KPI tile (muted label · big value · optional sublabel/trend) for dashboards.
// Hierarchy comes from weight + size, never color (04 §2). Pure presentation; the parent supplies the data.
import type { CSSProperties, ReactNode } from "react";

export function StatTile({
  label,
  value,
  sublabel,
  trend,
  style,
}: {
  label: ReactNode;
  value: ReactNode;
  sublabel?: ReactNode;
  /** Optional trailing accessory (e.g. a StatusBadge or trend chip). */
  trend?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--tp-space-2)",
        background: "var(--tp-surface-2)",
        border: "1px solid var(--tp-hairline-2)",
        borderRadius: "var(--radius)",
        padding: "var(--tp-space-5)",
        minWidth: 0,
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "var(--tp-space-3)",
          color: "var(--tp-ink-3)",
          fontSize: "var(--tp-text-body)",
          fontWeight: 500,
        }}
      >
        <span>{label}</span>
        {trend != null ? <span style={{ flex: "0 0 auto" }}>{trend}</span> : null}
      </div>
      <div
        style={{
          color: "var(--tp-ink)",
          fontSize: 30,
          fontWeight: 600,
          lineHeight: 1.1,
          letterSpacing: "-0.01em",
        }}
      >
        {value}
      </div>
      {sublabel != null ? (
        <div style={{ color: "var(--tp-ink-4)", fontSize: "var(--tp-text-body)", lineHeight: 1.4 }}>
          {sublabel}
        </div>
      ) : null}
    </div>
  );
}
