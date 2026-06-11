// CreditUsageSection.tsx — report section 1: balance + trailing-7-day reveal/credit StatTiles and the
// 14-day per-day bar list (pure CSS widths, no chart lib). Pure presentation over the credit rollup.
"use client";

import { StatTile } from "@leadwolf/ui";
import styles from "../reports.module.css";
import type { CreditRollup } from "../types";

export function CreditUsageSection({
  balance,
  rollup,
}: {
  balance: number;
  rollup: CreditRollup;
}) {
  const quiet = rollup.days.every((d) => d.credits === 0);

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Credit usage</h2>
      </div>

      <div className={styles.tiles}>
        <StatTile
          label="Credit balance"
          value={balance.toLocaleString()}
          sublabel="Reveal credits available now"
        />
        <StatTile
          label="Reveals — last 7 days"
          value={rollup.revealsLast7}
          sublabel="Contacts revealed this week"
        />
        <StatTile
          label="Credits spent — last 7 days"
          value={rollup.creditsLast7}
          sublabel="Across all reveal types"
        />
      </div>

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
    </section>
  );
}
