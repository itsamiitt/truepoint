// JobDetailDrawer.tsx — the edge slide-over showing one enrichment job's full status: lifecycle badge, a
// progress bar, the matched/enriched/charged + failed counts, credit estimate vs spend, the lifecycle
// timestamps, and the failure reason when the job failed. Pure presentation over an EnrichmentJobSummary
// (the parent already polls the list, so the open drawer reflects the latest tick). Public slice component.
"use client";

import { Drawer, Progress, StatusBadge } from "@leadwolf/ui";
import type { EnrichmentJobSummary } from "../types";
import styles from "./EnrichmentJobsPage.module.css";
import { formatDateTime, formatPercent, statusLabel, statusTone } from "./format";

/** A labelled count/value cell in the drawer's stat grid. */
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

/** Micros → a credits figure (1 credit = 1,000,000 micros), or an em dash when null. */
function credits(micros: number | null): string {
  if (micros == null) return "—";
  return (micros / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function JobDetailDrawer({
  job,
  open,
  onClose,
}: {
  job: EnrichmentJobSummary | null;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open && job != null}
      onClose={onClose}
      title={job?.sourceName ?? "Enrichment job"}
    >
      {job != null ? (
        <div className={styles.drawerBody}>
          <div className={styles.drawerStatusRow}>
            <StatusBadge tone={statusTone(job.status)}>{statusLabel(job.status)}</StatusBadge>
            <span className={styles.mono}>{formatPercent(job.progress)}</span>
          </div>

          <Progress
            value={job.progress}
            max={1}
            tone={job.status === "failed" ? "danger" : "ink"}
            label={`${job.sourceName} progress`}
          />

          <div className={styles.statGrid}>
            <Stat label="Total rows" value={job.counts.total.toLocaleString()} />
            <Stat label="Processed" value={job.counts.processed.toLocaleString()} />
            <Stat label="Matched" value={job.counts.matched.toLocaleString()} />
            <Stat label="Enriched" value={job.counts.enriched.toLocaleString()} />
            <Stat label="Charged" value={job.counts.charged.toLocaleString()} />
            <Stat label="Failed" value={job.counts.failed.toLocaleString()} />
          </div>

          <div className={styles.statGrid}>
            <Stat label="Credits estimated" value={credits(job.creditEstimateMicros)} />
            <Stat label="Credits spent" value={credits(job.creditSpentMicros)} />
          </div>

          <div className={styles.statGrid}>
            <Stat label="Created" value={formatDateTime(job.createdAt)} />
            <Stat label="Started" value={formatDateTime(job.startedAt)} />
            <Stat label="Completed" value={formatDateTime(job.completedAt)} />
          </div>

          {job.status === "failed" && job.failedReason ? (
            <div className={styles.failure} role="alert">
              <span className={styles.failureLabel}>Failure reason</span>
              <span className={styles.failureText}>{job.failedReason}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}
