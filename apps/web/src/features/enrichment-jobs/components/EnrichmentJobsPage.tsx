// EnrichmentJobsPage.tsx — the customer-visible enrichment job-status surface (G-ENR-4; 06 §4.1, 31 §8). A
// workspace user sees their enrichment jobs in a DataTable — file name, live status badge, a progress bar with
// matched/enriched counts, and when it landed — and opens a row to a detail drawer (counts, credits, timestamps,
// failure reason). The list LIVE-UPDATES: useEnrichmentJobs polls while any job is in flight. READ-only — no
// mutation here. All four async states render through the State Kit. Monochrome; color only via StatusBadge /
// Progress tones. Public slice component.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { DataTable, EmptyState, Progress, StateSwitch, StatusBadge, TpButton } from "@leadwolf/ui";
import type { Column } from "@leadwolf/ui";
import { Database, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useEnrichmentJobDetail } from "../hooks/useEnrichmentJobDetail";
import { useEnrichmentJobs } from "../hooks/useEnrichmentJobs";
import type { EnrichmentJobSummary } from "../types";
import styles from "./EnrichmentJobsPage.module.css";
import { JobDetailDrawer } from "./JobDetailDrawer";
import { formatPercent, formatRelative, statusLabel, statusTone } from "./format";

export function EnrichmentJobsPage() {
  const { jobs, error, loading, reload, polling } = useEnrichmentJobs();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The drawer prefers a fresh per-job detail read (GET /jobs/:jobId); while it loads, fall back to the list
  // row so the drawer opens instantly and never flashes empty.
  const fresh = useEnrichmentJobDetail(selectedId);
  const fromList = jobs.find((j) => j.jobId === selectedId) ?? null;
  const selected = fresh ?? fromList;

  const columns: Column<EnrichmentJobSummary>[] = [
    {
      key: "sourceName",
      header: "File",
      cell: (j) => <span className={styles.fileCell}>{j.sourceName}</span>,
      sortValue: (j) => j.sourceName,
    },
    {
      key: "status",
      header: "Status",
      cell: (j) => <StatusBadge tone={statusTone(j.status)}>{statusLabel(j.status)}</StatusBadge>,
      sortValue: (j) => j.status,
    },
    {
      key: "progress",
      header: "Progress",
      cell: (j) => (
        <div className={styles.progressCell}>
          <Progress
            value={j.progress}
            max={1}
            tone={j.status === "failed" ? "danger" : "ink"}
            label={`${j.sourceName} progress`}
            className={styles.progressTrack}
          />
          <span className={styles.mono}>{formatPercent(j.progress)}</span>
        </div>
      ),
      sortValue: (j) => j.progress,
    },
    {
      key: "matched",
      header: "Matched",
      align: "right",
      cell: (j) => <span className={styles.mono}>{j.counts.matched.toLocaleString()}</span>,
      sortValue: (j) => j.counts.matched,
    },
    {
      key: "enriched",
      header: "Enriched",
      align: "right",
      cell: (j) => <span className={styles.mono}>{j.counts.enriched.toLocaleString()}</span>,
      sortValue: (j) => j.counts.enriched,
    },
    {
      key: "failed",
      header: "Failed",
      align: "right",
      cell: (j) => <span className={styles.mono}>{j.counts.failed.toLocaleString()}</span>,
      sortValue: (j) => j.counts.failed,
    },
    {
      key: "createdAt",
      header: "Created",
      cell: (j) => <span className={styles.muted}>{formatRelative(j.createdAt)}</span>,
      sortValue: (j) => j.createdAt,
    },
  ];

  return (
    <main className={styles.page}>
      <PageHeader
        title="Enrichment jobs"
        subtitle="Track your bulk enrichment runs — status, progress, and results update live."
        actions={
          <div className={styles.refresh}>
            {polling ? <span className={styles.liveTag}>Live</span> : null}
            <TpButton
              variant="secondary"
              size="sm"
              leftIcon={<RefreshCw size={14} />}
              loading={loading}
              onClick={() => void reload()}
            >
              Refresh
            </TpButton>
          </div>
        }
      />

      <section className={styles.card}>
        <StateSwitch
          loading={loading}
          error={error && jobs.length === 0 ? error : undefined}
          empty={!loading && jobs.length === 0}
          onRetry={reload}
          emptyState={
            <EmptyState
              icon={<Database size={20} />}
              title="No enrichment jobs yet"
              description="When you run a bulk enrichment, each job appears here with its live status and results."
            />
          }
        >
          <DataTable
            columns={columns}
            rows={jobs}
            rowKey={(j) => j.jobId}
            onRowClick={(j) => setSelectedId(j.jobId)}
            isSelected={(j) => j.jobId === selectedId}
          />
        </StateSwitch>
      </section>

      <JobDetailDrawer
        job={selected}
        open={selectedId != null}
        onClose={() => setSelectedId(null)}
      />
    </main>
  );
}
