// ImportJobsHistoryPage.tsx — the durable import history dashboard (import-redesign 11 §2, S-U2). A workspace
// user sees their imports in a DataTable — file, live status badge, progress, row count, who ran it, when — and
// opens a row to a detail drawer (counts, strategy, timestamps, cancel). The list LIVE-UPDATES: useImportJobs
// polls while any loaded row is still running. Keyset "Load more" (never OFFSET). Elevated roles (owner/admin)
// see everyone's imports with attribution and can filter to their own. When the IMPORT_V2 dual gate is off the
// list endpoint 404s → an honest "not enabled yet" state, never a failure banner. All four async states render
// through StateSwitch. Monochrome; color only via StatusBadge / Progress tones. Public slice component.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { isWorkspaceAdmin, useSessionIdentity } from "@/lib/useSessionIdentity";
import { DataTable, EmptyState, Progress, StateSwitch, StatusBadge, TpButton } from "@leadwolf/ui";
import type { Column } from "@leadwolf/ui";
import type { ImportJobListItem } from "@leadwolf/types";
import { Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useImportJobs } from "../hooks/useImportJobs";
import { isTerminalV2, stateShortLabel, stateTone } from "./shared/stateCopy";
import { formatPercent, formatRelative } from "./format";
import { ImportJobDrawer } from "./ImportJobDrawer";
import styles from "./ImportJobsHistoryPage.module.css";

/** Attribution label for a job's creator, from the id alone (no name join yet — importV2 §createdBy). */
function attribution(createdByUserId: string | null, myUserId: string | null): string {
  if (createdByUserId == null) return "System";
  if (myUserId != null && createdByUserId === myUserId) return "You";
  return "Teammate";
}

export function ImportJobsHistoryPage() {
  const router = useRouter();
  const { userId, role } = useSessionIdentity();
  const elevated = isWorkspaceAdmin(role);
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { jobs, isLoading, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useImportJobs();

  const notEnabled = isError && Boolean((error as { notEnabled?: boolean } | null)?.notEnabled);
  const errMsg =
    isError && !notEnabled && jobs.length === 0
      ? error instanceof Error
        ? error.message
        : "Could not load imports"
      : undefined;

  // Elevated "mine" is a client-side filter over the LOADED pages (an honest S-U2 limitation — a server
  // ?scope=mine param is the full fix; drift-logged). Members already receive only their own jobs.
  const visible =
    elevated && scope === "mine" && userId != null
      ? jobs.filter((j) => j.createdBy.userId === userId)
      : jobs;

  const anyRunning = jobs.some((j) => !isTerminalV2(j.status));

  const columns: Column<ImportJobListItem>[] = [
    {
      key: "file",
      header: "File",
      cell: (j) => (
        <div>
          <div className={styles.fileCell}>{j.sourceFilename ?? j.sourceName}</div>
          {j.parentJobId ? <div className={styles.subFile}>Retry of an earlier import</div> : null}
        </div>
      ),
      sortValue: (j) => j.sourceFilename ?? j.sourceName,
    },
    {
      key: "status",
      header: "Status",
      cell: (j) => <StatusBadge tone={stateTone(j.status)}>{stateShortLabel(j.status)}</StatusBadge>,
      sortValue: (j) => j.status,
    },
    {
      key: "progress",
      header: "Progress",
      cell: (j) => (
        <div className={styles.progressCell}>
          <Progress
            value={j.percent}
            max={1}
            tone={j.status === "failed" ? "danger" : "ink"}
            label={`${j.sourceFilename ?? j.sourceName} progress`}
            className={styles.progressTrack}
          />
          <span className={styles.mono}>{formatPercent(j.percent)}</span>
        </div>
      ),
      sortValue: (j) => j.percent,
    },
    {
      key: "rows",
      header: "Rows",
      align: "right",
      cell: (j) => <span className={styles.mono}>{j.counts.total.toLocaleString()}</span>,
      sortValue: (j) => j.counts.total,
    },
    {
      key: "createdBy",
      header: "Run by",
      cell: (j) => <span className={styles.muted}>{attribution(j.createdBy.userId, userId)}</span>,
      sortValue: (j) => attribution(j.createdBy.userId, userId),
    },
    {
      key: "createdAt",
      header: "Started",
      cell: (j) => <span className={styles.muted}>{formatRelative(j.createdAt)}</span>,
      sortValue: (j) => j.createdAt,
    },
  ];

  return (
    <main className={styles.page}>
      <PageHeader
        title="Imports"
        subtitle="Your imports — status, progress, and results update live."
        actions={
          <div className={styles.headerTools}>
            {anyRunning ? <span className={styles.liveTag}>Live</span> : null}
            <TpButton variant="primary" type="button" onClick={() => router.push("/imports/new")}>
              New import
            </TpButton>
          </div>
        }
      />

      {elevated ? (
        <div className={styles.toolbar} role="group" aria-label="Whose imports to show">
          <TpButton
            variant={scope === "all" ? "secondary" : "ghost"}
            size="sm"
            type="button"
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            All imports
          </TpButton>
          <TpButton
            variant={scope === "mine" ? "secondary" : "ghost"}
            size="sm"
            type="button"
            aria-pressed={scope === "mine"}
            onClick={() => setScope("mine")}
          >
            Just mine
          </TpButton>
        </div>
      ) : null}

      <section className={styles.card}>
        <StateSwitch
          loading={isLoading}
          error={errMsg}
          empty={!isLoading && visible.length === 0}
          onRetry={() => void refetch()}
          emptyState={
            notEnabled ? (
              <EmptyState
                icon={<Upload size={20} aria-hidden />}
                title="Import history isn’t enabled yet"
                description="Once the durable import pipeline is turned on for your workspace, your past and running imports will appear here."
              />
            ) : (
              <EmptyState
                icon={<Upload size={20} aria-hidden />}
                title={scope === "mine" ? "You haven’t run any imports yet" : "No imports yet"}
                description="Start an import and it will appear here with its live status and results."
              />
            )
          }
        >
          <DataTable
            columns={columns}
            rows={visible}
            rowKey={(j) => j.jobId}
            onRowClick={(j) => setSelectedId(j.jobId)}
            isSelected={(j) => j.jobId === selectedId}
          />
          {hasNextPage && scope === "all" ? (
            <div className={styles.loadMore}>
              <TpButton
                variant="secondary"
                size="sm"
                type="button"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                Load more
              </TpButton>
            </div>
          ) : null}
        </StateSwitch>
      </section>

      <ImportJobDrawer
        jobId={selectedId}
        fallback={jobs.find((j) => j.jobId === selectedId) ?? null}
        open={selectedId != null}
        onClose={() => setSelectedId(null)}
      />
    </main>
  );
}
