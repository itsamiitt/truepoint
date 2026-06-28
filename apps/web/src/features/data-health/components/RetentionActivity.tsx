// RetentionActivity.tsx — the Retention tab: the per-tenant retention-engine run audit (the SHADOW evidence) as a
// DataTable of recent sweeps (data class · mode · candidates "would delete" · deleted · cutoff · last run), from
// GET /home/data-quality/retention-runs. Four async states via StateSwitch with a first-class EmptyState that
// explains the inert default. READ-ONLY evidence: shadow records what WOULD delete; nothing is purged until enforce.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  Icon,
  StateSwitch,
  StatusBadge,
  type StatusTone,
} from "@leadwolf/ui";
import { Archive } from "lucide-react";
import styles from "../data-health.module.css";
import type { RetentionRun } from "../types";

// Tone paired WITH the text label (never colour alone): shadow = a "would delete" heads-up (warning); enforce =
// rows actually purged (danger); disabled = the class is ignored (muted). No StatusBadge "neutral" tone exists.
const MODE_TONE: Record<RetentionRun["mode"], StatusTone> = {
  disabled: "muted",
  shadow: "warning",
  enforce: "danger",
};

const MODE_LABEL: Record<RetentionRun["mode"], string> = {
  disabled: "Disabled",
  shadow: "Shadow",
  enforce: "Enforce",
};

const fmtDateTime = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const fmtCutoff = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "—";

export function RetentionActivity({
  runs,
  loading,
  error,
  onRetry,
}: {
  runs: RetentionRun[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const list = runs ?? [];

  const columns: Column<RetentionRun>[] = [
    {
      key: "dataClass",
      header: "Data class",
      sortValue: (r) => r.dataClass,
      cell: (r) => r.dataClass,
    },
    {
      key: "mode",
      header: "Mode",
      sortValue: (r) => r.mode,
      cell: (r) => <StatusBadge tone={MODE_TONE[r.mode]}>{MODE_LABEL[r.mode]}</StatusBadge>,
    },
    {
      key: "candidates",
      header: "Candidates",
      align: "right",
      sortValue: (r) => r.candidateCount,
      cell: (r) => r.candidateCount.toLocaleString(),
    },
    {
      key: "deleted",
      header: "Deleted",
      align: "right",
      sortValue: (r) => r.deletedCount,
      cell: (r) => r.deletedCount.toLocaleString(),
    },
    {
      key: "cutoff",
      header: "Cutoff",
      sortValue: (r) => r.cutoff ?? "",
      cell: (r) => fmtCutoff(r.cutoff),
    },
    {
      key: "lastRun",
      header: "Last run",
      sortValue: (r) => r.runFinishedAt,
      cell: (r) => fmtDateTime(r.runFinishedAt),
    },
  ];

  return (
    <StateSwitch
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && list.length === 0}
      emptyState={
        <EmptyState
          icon={<Icon icon={Archive} size={28} />}
          title="No retention activity yet"
          description="The engine runs daily once enabled; shadow mode records what WOULD be deleted, deleting nothing."
        />
      }
    >
      <div className={styles.stack}>
        <div className={styles.tableBlock}>
          <h3 className={styles.subheading}>Recent runs</h3>
          <DataTable
            columns={columns}
            rows={list}
            rowKey={(r) => `${r.dataClass}-${r.runStartedAt}`}
          />
        </div>
        <p className={styles.footnote}>
          Shadow = candidates only, nothing is deleted (the "would delete" count). Enforce = rows
          actually purged (Deleted). Cutoff is the age boundary — rows older than it are eligible.
        </p>
      </div>
    </StateSwitch>
  );
}
