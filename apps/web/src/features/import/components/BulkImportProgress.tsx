// BulkImportProgress.tsx — the live status surface for ONE bulk import (backlog #2; GET /imports/bulk/:jobId). It
// polls the job via useBulkImport until it settles, rendering all four async states through the State Kit PLUS a
// distinct "not enabled" state for the dark-gated 403 (bulk_import_disabled) — never a generic failure. The ready
// view shows the progress bar, the row-accounting breakdown (created/matched/duplicate/skipped/rejected/deduped/
// unprocessed of total), a status badge, and — once terminal with rejects — the server-signed rejected-rows link.
// READ-only; the import runs server-side in apps/workers. Self-contained surface, so the /imports/[jobId] route
// just mounts it (mirrors EnrichmentJobsPage). Monochrome; color only via the StatusBadge / Progress tones.
"use client";

import { PageHeader } from "@/components/PageHeader";
import type { BulkImportJobStatusResponse } from "@leadwolf/types";
import { EmptyState, Progress, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { Inbox, Upload } from "lucide-react";
import { useBulkImport } from "../hooks/useBulkImport";
import styles from "./BulkImportProgress.module.css";
import { COUNT_FIELDS, bulkPercent, bulkStatusLabel, bulkStatusTone } from "./bulkFormat";

/** The settled/ in-flight job view: progress + the seven-bucket breakdown + the rejected-rows download. */
function Ready({ job }: { job: BulkImportJobStatusResponse }) {
  const pct = bulkPercent(job.progress);
  return (
    <div className={styles.body}>
      <div className={styles.statusRow}>
        <StatusBadge tone={bulkStatusTone(job.status)}>{bulkStatusLabel(job.status)}</StatusBadge>
        <span className={styles.mono}>{pct}%</span>
      </div>

      <Progress
        value={pct}
        tone={job.status === "failed" ? "danger" : "ink"}
        label="Import progress"
      />

      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Total rows</span>
          <span className={styles.statValue}>{job.counts.total.toLocaleString()}</span>
        </div>
        {COUNT_FIELDS.map((f) => (
          <div key={f.key} className={styles.stat}>
            <span className={styles.statLabel}>{f.label}</span>
            <span className={styles.statValue}>{job.counts[f.key].toLocaleString()}</span>
          </div>
        ))}
      </div>

      {job.rejectedRowsUrl ? (
        <a className={styles.downloadLink} href={job.rejectedRowsUrl} download>
          Download rejected rows ({job.counts.rejected.toLocaleString()})
        </a>
      ) : null}

      {job.status === "failed" && job.failedReason ? (
        <div className={styles.failure} role="alert">
          <span className={styles.failureLabel}>Failure reason</span>
          <span className={styles.failureText}>{job.failedReason}</span>
        </div>
      ) : null}
    </div>
  );
}

export function BulkImportProgress({ jobId }: { jobId: string }) {
  const { job, error, loading, disabled } = useBulkImport(jobId);

  return (
    <main className={styles.page}>
      <PageHeader
        title="Bulk import"
        subtitle="Your import runs in the background — status, progress, and results update live."
      />

      <section className={styles.card}>
        {disabled ? (
          <EmptyState
            icon={<Upload size={20} />}
            title="Bulk import isn’t enabled"
            description="Bulk import isn’t enabled for your workspace yet. Use a standard import, or contact your administrator."
          />
        ) : (
          <StateSwitch
            loading={loading && job == null}
            error={error && job == null ? error : undefined}
            empty={!loading && !error && job == null}
            emptyState={
              <EmptyState
                icon={<Inbox size={20} />}
                title="No import job found"
                description="This import job doesn’t exist or has expired."
              />
            }
          >
            {job ? <Ready job={job} /> : null}
          </StateSwitch>
        )}
      </section>
    </main>
  );
}
