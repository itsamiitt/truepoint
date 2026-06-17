// LeadScoreSection.tsx — the Lead score & intent dashboard. Versioned lead scores (icpFit · intent ·
// engagement · composite — intel.ts scoreRow, ADR-0008) are not exposed on the masked contact list and have no
// reporting endpoint yet, so the score distribution renders a first-class empty state; the intent half is the
// co-located IntentSection. Lead score (prospect quality) is DISTINCT from email_status — never conflated.
"use client";

import { EmptyState, Icon } from "@leadwolf/ui";
import { Gauge } from "lucide-react";
import styles from "../reports.module.css";
import { IntentSection } from "./IntentSection";

const SCORE_BANDS = ["A · 80–100", "B · 60–79", "C · 40–59", "D · 0–39"];

export function LeadScoreSection() {
  return (
    <div className={styles.scoreGrid}>
      <div className={styles.subPanel}>
        <h3 className={styles.subheading}>Score distribution</h3>
        <ul className={styles.barList} aria-hidden>
          {SCORE_BANDS.map((band) => (
            <li key={band} className={styles.barRow}>
              <span className={styles.barLabel}>{band}</span>
              <span className={styles.barTrack}>
                <span className={styles.barFill} style={{ width: "0%" }} />
              </span>
              <span className={styles.barValue}>—</span>
            </li>
          ))}
        </ul>
        <EmptyState
          icon={<Icon icon={Gauge} size={28} />}
          title="No lead scores yet"
          description="ICP fit, intent, and engagement combine into a composite score per contact once the scoring engine runs. The score distribution and grade bands appear here. Scoring reports ship post-MVP."
        />
      </div>

      <IntentSection />
    </div>
  );
}
