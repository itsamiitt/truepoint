// FunnelSection.tsx — report section 2: contacts per outreach status as labeled rows with proportional
// CSS bars; the journey stages lead and the off-ramp statuses sit in a muted secondary block. Pure
// presentation over the funnel rollup.
"use client";

import styles from "../reports.module.css";
import type { FunnelRollup, FunnelStage } from "../types";

function StageRow({ stage, max, muted }: { stage: FunnelStage; max: number; muted?: boolean }) {
  return (
    <li className={styles.barRow}>
      <span className={styles.barLabel}>{stage.label}</span>
      <span className={styles.barTrack}>
        <span
          className={muted ? `${styles.barFill} ${styles.barFillMuted}` : styles.barFill}
          style={{ width: `${(stage.count / max) * 100}%` }}
        />
      </span>
      <span className={styles.barValue}>{stage.count.toLocaleString()}</span>
    </li>
  );
}

export function FunnelSection({ rollup }: { rollup: FunnelRollup }) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Pipeline</h2>
        <p className={styles.cardHint}>
          {rollup.total.toLocaleString()} contact{rollup.total === 1 ? "" : "s"} by outreach status
        </p>
      </div>

      {rollup.total === 0 ? (
        <p className={styles.muted}>
          No contacts yet — import a CSV or prospect to start filling the funnel.
        </p>
      ) : (
        <>
          <ul className={styles.barList}>
            {rollup.primary.map((stage) => (
              <StageRow key={stage.status} stage={stage} max={rollup.maxCount} />
            ))}
          </ul>

          <div className={styles.secondaryBlock}>
            <p className={styles.secondaryLabel}>Out of the funnel</p>
            <ul className={styles.barList}>
              {rollup.secondary.map((stage) => (
                <StageRow key={stage.status} stage={stage} max={rollup.maxCount} muted />
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
