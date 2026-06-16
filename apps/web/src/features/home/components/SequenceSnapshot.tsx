// SequenceSnapshot.tsx — outreach at a glance for this workspace: active sequences, enrolled, sent, replied
// as a compact metric grid. Aggregate counts only (no PII). Pure presentation over HomeSummary.sequenceSnapshot.
"use client";

import { Card, Spinner } from "@leadwolf/ui";
import type { SequenceSnapshot as SequenceSnapshotData } from "../types";
import styles from "./HomePage.module.css";

const METRICS: Array<{ key: keyof SequenceSnapshotData; label: string }> = [
  { key: "activeSequences", label: "Active sequences" },
  { key: "enrolled", label: "Enrolled" },
  { key: "sent", label: "Sent" },
  { key: "replied", label: "Replied" },
];

export function SequenceSnapshot({
  snapshot,
  loading,
  error,
}: {
  snapshot: SequenceSnapshotData | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Sequences</h2>
      </div>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : loading || !snapshot ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading sequences…
        </div>
      ) : (
        <div className={styles.metricGrid}>
          {METRICS.map(({ key, label }) => (
            <div key={key} className={styles.metric}>
              <span className={styles.metricValue}>{snapshot[key].toLocaleString()}</span>
              <span className={styles.metricLabel}>{label}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
