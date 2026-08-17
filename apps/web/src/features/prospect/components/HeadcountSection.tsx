// HeadcountSection.tsx — the company's monthly headcount series (0114) in the account drawer.
//
// A 12-bar mini chart + latest count + 1m/1y deltas, ALL derived client-side from the raw series (the
// no-rollup rule — the server ships points, never growth numbers). Pure CSS bars, no chart library: 12
// values with a title attribute per bar is a sparkline, not a visualization problem. Self-hides into an
// EmptyState until the linkedin_api landing populates the series.
"use client";

import { EmptyState, StateSwitch } from "@leadwolf/ui";
import { Users } from "lucide-react";
import { useAccountHeadcount } from "../hooks/useAccountHeadcount";
import styles from "../prospect.module.css";

function deltaLabel(pct: number | null, window: string): string | null {
  if (pct === null) return null;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}% ${window}`;
}

export function HeadcountSection({ accountId }: { accountId: string }) {
  const { series, deltas, resolved, loading, error, reload } = useAccountHeadcount(accountId);
  // Newest-first on the wire; the bars read left→right oldest→newest over the last 12 points.
  const bars = series.slice(0, 12).reverse();
  const max = Math.max(...bars.map((b) => b.employee_count), 1);
  const parts = [deltaLabel(deltas.oneMonthPct, "1m"), deltaLabel(deltas.oneYearPct, "1y")].filter(
    Boolean,
  );

  return (
    <StateSwitch
      loading={loading}
      error={error}
      empty={!loading && series.length === 0}
      onRetry={reload}
      emptyState={
        <EmptyState
          icon={<Users size={24} />}
          title={resolved ? "No headcount series yet" : "Not matched to the graph yet"}
          description={
            resolved
              ? "Headcount history appears after a company refresh."
              : "Headcount appears once this account is matched to the shared graph."
          }
        />
      }
    >
      <div className={styles.fieldGrid}>
        <div>
          <div className={styles.fieldLabel}>Employees</div>
          <div className={styles.fieldValue}>
            {deltas.latest?.toLocaleString() ?? "—"}
            {parts.length > 0 ? (
              <span className={styles.fieldLabel}> · {parts.join(" · ")}</span>
            ) : null}
          </div>
        </div>
      </div>
      <div className={styles.headcountBars} aria-label="Monthly headcount, last 12 months">
        {bars.map((b) => (
          <div
            key={b.month}
            className={styles.headcountBar}
            style={{ height: `${Math.max(8, Math.round((b.employee_count / max) * 100))}%` }}
            title={`${b.month.slice(0, 7)}: ${b.employee_count.toLocaleString()}`}
          />
        ))}
      </div>
    </StateSwitch>
  );
}
