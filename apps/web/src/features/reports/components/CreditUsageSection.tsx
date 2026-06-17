// CreditUsageSection.tsx — the Credit usage dashboard: balance + trailing-7-day reveal/credit StatTiles, a
// sortable per-reveal-type DataTable, and the 14-day per-day bar list (pure CSS widths, no chart lib).
// StateSwitch handles loading/empty/error. Presentation only over the credit rollup.
"use client";

import { type Column, DataTable, EmptyState, Icon, StatTile, StateSwitch } from "@leadwolf/ui";
import { Coins } from "lucide-react";
import styles from "../reports.module.css";
import type { CreditRollup, CreditTypeRow } from "../types";

const TYPE_COLUMNS: Column<CreditTypeRow>[] = [
  {
    key: "label",
    header: "Reveal type",
    cell: (r) => r.label,
    sortValue: (r) => r.label,
  },
  {
    key: "reveals",
    header: "Reveals",
    align: "right",
    cell: (r) => r.reveals.toLocaleString(),
    sortValue: (r) => r.reveals,
  },
  {
    key: "credits",
    header: "Credits",
    align: "right",
    cell: (r) => r.credits.toLocaleString(),
    sortValue: (r) => r.credits,
  },
];

export function CreditUsageSection({
  balance,
  rollup,
  loading,
  error,
  onRetry,
}: {
  balance: number | null;
  rollup: CreditRollup | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const quiet = !rollup || rollup.days.every((d) => d.credits === 0);

  return (
    <StateSwitch
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && rollup != null && !rollup.hasSpend && balance === 0}
      emptyState={
        <EmptyState
          icon={<Icon icon={Coins} size={28} />}
          title="No credit activity yet"
          description="Reveal a contact and your spend — by day and by reveal type — shows up here."
        />
      }
    >
      {rollup ? (
        <>
          <div className={styles.tiles}>
            <StatTile
              label="Credit balance"
              value={(balance ?? 0).toLocaleString()}
              sublabel="Reveal credits available now"
            />
            <StatTile
              label="Reveals — last 7 days"
              value={rollup.revealsLast7.toLocaleString()}
              sublabel="Contacts revealed this week"
            />
            <StatTile
              label="Credits spent — last 7 days"
              value={rollup.creditsLast7.toLocaleString()}
              sublabel="Across all reveal types"
            />
          </div>

          <h3 className={styles.subheading}>Spend by reveal type</h3>
          <DataTable
            columns={TYPE_COLUMNS}
            rows={rollup.byType}
            rowKey={(r) => r.revealType}
            empty={
              <EmptyState
                title="No reveals in this range"
                description="Widen the date range or clear the member filter to see spend by reveal type."
              />
            }
          />

          <h3 className={styles.subheading}>Credits per day — last 14 days</h3>
          {quiet ? (
            <p className={styles.muted}>No credit spend in the last 14 days.</p>
          ) : (
            <ul className={styles.barList}>
              {rollup.days.map((d) => (
                <li key={d.key} className={styles.barRow}>
                  <span className={styles.barLabel}>{d.label}</span>
                  <span className={styles.barTrack}>
                    <span
                      className={styles.barFill}
                      style={{ width: `${(d.credits / rollup.maxCredits) * 100}%` }}
                    />
                  </span>
                  <span className={styles.barValue}>
                    {d.credits > 0
                      ? `${d.credits} cr · ${d.reveals} reveal${d.reveals === 1 ? "" : "s"}`
                      : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </StateSwitch>
  );
}
