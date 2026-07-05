// ImportJobDrawer.tsx — the edge slide-over for one durable import job (import-redesign 11 §2, S-U2). Shows the
// status headline, a progress bar, the outcome breakdown, the merge strategy the run used, and the lifecycle
// timestamps; while the job is still cancellable it offers Cancel (a Dialog-confirmed mutation, never a bare
// button — design skill). It reads a FRESH per-job detail (GET /imports/:id, polled by useImportJob) and falls
// back to the clicked list row so the drawer opens instantly and never flashes empty. Server-truth: cancel
// invalidates the list + detail and the next poll re-reads the outcome. The artifact downloads + retry-failed
// action land here at S-U6. Public slice component.
"use client";

import { Drawer, Progress, Spinner, StatusBadge, TpButton, useToast } from "@leadwolf/ui";
import type { ImportJobListItem } from "@leadwolf/types";
import { useState } from "react";
import { useImportJob } from "../hooks/useImportJob";
import { useCancelImport } from "../hooks/useImportMutations";
import { ConfirmDialog } from "./shared/ConfirmDialog";
import {
  completionCounts,
  isCancellableV2,
  legacyStatusToV2,
  stateHeadline,
  stateShortLabel,
  stateTone,
} from "./shared/stateCopy";
import { formatDateTime } from "./format";
import styles from "./ImportJobsHistoryPage.module.css";

const MERGE_LABEL: Record<string, string> = {
  create_only: "Only add new records",
  update_only: "Only update existing records",
  create_and_update: "Add new and update existing",
};

/** A labelled value cell in the drawer's stat grid. */
function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

export function ImportJobDrawer({
  jobId,
  fallback,
  open,
  onClose,
}: {
  jobId: string | null;
  fallback: ImportJobListItem | null;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const cancel = useCancelImport();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Fresh detail preferred; the clicked row keeps the drawer populated while it loads.
  const { data: fresh } = useImportJob(open ? jobId : null);

  const status = fresh?.statusV2 ?? (fresh ? legacyStatusToV2(fresh.status) : fallback?.status ?? null);
  const counts = fresh?.counts ?? fallback?.counts ?? null;
  const percent = fresh?.percent ?? fallback?.percent ?? 0;
  const filename = fresh?.sourceFilename ?? fallback?.sourceFilename ?? "Import";
  const createdAt = fresh?.createdAt ?? fallback?.createdAt ?? null;
  const startedAt = fresh?.startedAt ?? fallback?.startedAt ?? null;
  const completedAt = fresh?.completedAt ?? fallback?.completedAt ?? null;

  const summary = counts ? completionCounts(counts) : null;
  const cancellable = status != null && isCancellableV2(status);

  function onConfirmCancel() {
    if (jobId == null) return;
    cancel.mutate(jobId, {
      onSuccess: () => {
        toast.success("Import cancelled", "Rows already imported were kept.");
        setConfirmOpen(false);
      },
      onError: (e) =>
        toast.error("Couldn’t cancel", e instanceof Error ? e.message : "Please try again."),
    });
  }

  return (
    <Drawer
      open={open && (fresh != null || fallback != null)}
      onClose={onClose}
      title={filename}
      footer={
        cancellable ? (
          <div className={styles.drawerActions}>
            <TpButton variant="danger" size="sm" type="button" onClick={() => setConfirmOpen(true)}>
              Cancel import
            </TpButton>
          </div>
        ) : undefined
      }
    >
      {status == null || counts == null ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
          <Spinner />
        </div>
      ) : (
        <div className={styles.drawerBody}>
          <div className={styles.drawerStatusRow}>
            <StatusBadge tone={stateTone(status)}>{stateShortLabel(status)}</StatusBadge>
          </div>

          <p className={styles.headline}>{stateHeadline(status, counts)}</p>

          <Progress
            value={percent}
            max={1}
            tone={status === "failed" ? "danger" : "ink"}
            label={`${filename} progress`}
          />

          {summary ? (
            <div>
              <span className={styles.sectionLabel}>Results</span>
              <div className={styles.statGrid} style={{ marginTop: 8 }}>
                <Stat label="Created" value={summary.created.toLocaleString()} />
                <Stat label="Updated" value={summary.updated.toLocaleString()} />
                <Stat label="Duplicates" value={summary.duplicates.toLocaleString()} />
                <Stat label="Skipped" value={summary.skipped.toLocaleString()} />
                <Stat label="Needs attention" value={summary.needsAttention.toLocaleString()} />
                <Stat label="Total rows" value={counts.total.toLocaleString()} />
              </div>
            </div>
          ) : null}

          {fresh?.mergeMode ? (
            <div>
              <span className={styles.sectionLabel}>Strategy</span>
              <div className={styles.statGrid} style={{ marginTop: 8 }}>
                <Stat label="Merge mode" value={MERGE_LABEL[fresh.mergeMode] ?? fresh.mergeMode} />
                <Stat
                  label="Existing values"
                  value={fresh.preservePopulated ? "Kept (fill blanks only)" : "Overwritten"}
                />
              </div>
            </div>
          ) : null}

          <div>
            <span className={styles.sectionLabel}>Timeline</span>
            <div className={styles.statGrid} style={{ marginTop: 8 }}>
              <Stat label="Started" value={formatDateTime(createdAt)} />
              <Stat label="Processing began" value={formatDateTime(startedAt)} />
              <Stat label="Finished" value={formatDateTime(completedAt)} />
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Cancel this import?"
        body="We’ll stop processing the remaining rows. Rows already imported are kept — cancelling doesn’t undo them."
        confirmLabel="Cancel import"
        cancelLabel="Keep running"
        destructive
        busy={cancel.isPending}
        onConfirm={onConfirmCancel}
      />
    </Drawer>
  );
}
