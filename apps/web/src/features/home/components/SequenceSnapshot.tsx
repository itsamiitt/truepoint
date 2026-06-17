// SequenceSnapshot.tsx — outreach at a glance for this workspace: active sequences, enrolled, sent, replied
// as a compact metric grid, plus a reply-rate Progress bar. Aggregate counts only (no PII). Pure
// presentation over HomeSummary.sequenceSnapshot; all four async states render through the shared WidgetCard
// → StateSwitch (empty when there's no outreach activity at all). Public slice component.
"use client";

import { Progress, Skeleton } from "@leadwolf/ui";
import { Send } from "lucide-react";
import type { SequenceSnapshot as SequenceSnapshotData } from "../types";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

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
  onRetry,
}: {
  snapshot: SequenceSnapshotData | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  const isEmpty =
    snapshot != null &&
    snapshot.activeSequences === 0 &&
    snapshot.enrolled === 0 &&
    snapshot.sent === 0 &&
    snapshot.replied === 0;
  const replyRate = snapshot && snapshot.sent > 0 ? (snapshot.replied / snapshot.sent) * 100 : 0;

  return (
    <WidgetCard
      title="Sequences"
      icon={Send}
      loading={loading || !snapshot}
      error={error}
      empty={isEmpty}
      onRetry={onRetry}
      emptyIcon={Send}
      emptyTitle="No outreach yet"
      emptyDescription="Enroll leads into a sequence and your send and reply activity tracks here."
      skeleton={
        <div className={styles.metricGrid}>
          {METRICS.map((m) => (
            <div key={m.key} className={styles.metric}>
              <Skeleton width="50%" height={24} />
              <Skeleton width="70%" height={10} />
            </div>
          ))}
        </div>
      }
    >
      {snapshot ? (
        <>
          <div className={styles.metricGrid}>
            {METRICS.map(({ key, label }) => (
              <div key={key} className={styles.metric}>
                <span className={styles.metricValue}>{snapshot[key].toLocaleString()}</span>
                <span className={styles.metricLabel}>{label}</span>
              </div>
            ))}
          </div>
          {snapshot.sent > 0 ? (
            <div className={styles.replyRate}>
              <div className={styles.replyRateLabel}>
                <span>Reply rate</span>
                <span className={styles.replyRateValue}>{replyRate.toFixed(1)}%</span>
              </div>
              <Progress value={snapshot.replied} max={snapshot.sent} label="Sequence reply rate" />
            </div>
          ) : null}
        </>
      ) : null}
    </WidgetCard>
  );
}
