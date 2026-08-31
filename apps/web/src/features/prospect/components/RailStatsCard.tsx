// RailStatsCard.tsx — the two-number stat card at the top of a Search filter rail (user call 2026-08-31,
// replaced the results-area headline): MATCHING = everyone the applied filters reach across both engines,
// SAVED = the workspace's own share. Values arrive pre-formatted (floors carry a trailing "+"). Shared by
// the People and Accounts rails so the two tabs read the same way.
"use client";

import styles from "../prospect.module.css";

export interface RailStats {
  /** Everyone the applied filters match, both engines (saved + database). */
  total: string;
  /** How many of them are already saved in this workspace. */
  saved: string;
}

export function RailStatsCard({ stats }: { stats: RailStats }) {
  return (
    <div className={styles.railStats}>
      <div className={styles.railStat}>
        <span className={styles.railStatNum}>{stats.total}</span>
        <span className={styles.railStatLabel}>Matching</span>
      </div>
      <div className={styles.railStat}>
        <span className={styles.railStatNum}>{stats.saved}</span>
        <span className={styles.railStatLabel}>Saved</span>
      </div>
    </div>
  );
}
