// ImportJobPage.tsx — the durable, full-page status view for ONE import (import-redesign 11 §4, S-U3). Reached
// by URL (/imports/:jobId) so the handle IS the URL: refresh or navigate-away-and-back resumes cleanly, and the
// poll NEVER gives up (useImportJob follows the 09 §4.3 cadence, no ~2-min abort — the G11 fix). Works for BOTH
// shapes GET /imports/:jobId returns: the additive v2 detail (counts, when the IMPORT_V2 gate is on) and the
// legacy poll response (status + summary, gate-off) — the sync import navigates here on submit either way. Shows
// the §4.2 status headline, a progress bar, the completion summary bar, a rejected-rows download (legacy), and
// Cancel while the job is still cancellable. Artifact downloads + retry-failed land at S-U6. Public slice component.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { EmptyState, Progress, Spinner, StateSwitch, StatusBadge, TpButton } from "@leadwolf/ui";
import type { ImportJobCounts } from "@leadwolf/types";
import { ArrowLeft, Upload } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useImportJob } from "../hooks/useImportJob";
import { useCancelImport } from "../hooks/useImportMutations";
import type { ImportJobDetail } from "../apiV2";
import { rejectedRowsToCsv } from "../rejectedRowsCsv";
import { ConfirmDialog } from "./shared/ConfirmDialog";
import {
  completionCounts,
  isCancellableV2,
  isTerminalV2,
  legacyStatusToV2,
  stateHeadline,
  stateShortLabel,
  stateTone,
} from "./shared/stateCopy";
import styles from "./ImportJobsHistoryPage.module.css";

/** Trigger a client-side CSV download (the legacy rejected-rows artifact is already in the poll response). */
function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Unify the two response shapes onto ImportJobCounts: v2 carries `counts` directly; the legacy `summary`
 *  (present only once the job settles) is synthesized into the same seven-bucket shape so one render path
 *  serves both. `null` while a legacy job is still running (no summary yet). */
function toCounts(detail: ImportJobDetail | undefined): ImportJobCounts | null {
  if (detail?.counts) return detail.counts;
  const s = detail?.summary;
  if (!s) return null;
  return {
    total: s.total,
    created: s.created,
    matched: s.matched,
    duplicate: s.duplicates,
    skipped: s.skipped,
    rejected: s.rejected,
    deduped: 0,
    unprocessed: 0,
  };
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

export function ImportJobPage({ jobId }: { jobId: string }) {
  const { data: detail, isLoading, isError, error } = useImportJob(jobId);
  const cancel = useCancelImport();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // GET /imports/:jobId works gate-off (the legacy poll shape) and gate-on (adds the v2 members), so the only
  // failure here is a genuinely unknown/aged job → an error, never a "not enabled" empty (that is the LIST's
  // signal, doc 16 drift). Show the error only when we have nothing to render.
  const errMsg =
    isError && !detail
      ? error instanceof Error
        ? error.message
        : "Could not load this import"
      : undefined;

  const status = detail
    ? detail.statusV2 ?? legacyStatusToV2(detail.status)
    : null;
  const counts = toCounts(detail);
  const percent =
    detail?.percent ??
    (status != null && isTerminalV2(status)
      ? 1
      : counts && counts.total > 0
        ? (counts.total - counts.unprocessed) / counts.total
        : 0);
  const filename = detail?.sourceFilename ?? "Import";
  const summary = counts ? completionCounts(counts) : null;
  const terminal = status != null && isTerminalV2(status);
  const cancellable = status != null && isCancellableV2(status);
  const legacyRejected = detail?.summary?.rejectedRows ?? [];

  function onConfirmCancel() {
    cancel.mutate(jobId, {
      onSuccess: () => setConfirmOpen(false),
      onError: () => setConfirmOpen(false),
    });
  }

  function onDownloadRejected() {
    if (legacyRejected.length === 0) return;
    const base = filename.replace(/\.(csv|xlsx?)$/i, "");
    downloadCsv(rejectedRowsToCsv(legacyRejected), `${base}-rejected.csv`);
  }

  return (
    <main className={styles.page}>
      <PageHeader
        title={filename}
        subtitle={
          <Link
            href="/imports"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: "var(--tp-ink-3)",
            }}
          >
            <ArrowLeft size={14} aria-hidden /> All imports
          </Link>
        }
        actions={
          cancellable ? (
            <TpButton variant="danger" size="sm" type="button" onClick={() => setConfirmOpen(true)}>
              Cancel import
            </TpButton>
          ) : undefined
        }
      />

      <section className={styles.card}>
        <StateSwitch
          loading={isLoading && !detail}
          error={errMsg}
          empty={false}
          emptyState={
            <EmptyState
              icon={<Upload size={20} aria-hidden />}
              title="This import isn’t available"
              description="It may have finished and aged out."
            />
          }
        >
          {status == null ? (
            <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
              <Spinner />
            </div>
          ) : (
            <div className={styles.drawerBody} style={{ padding: 12 }}>
              <div className={styles.drawerStatusRow}>
                <StatusBadge tone={stateTone(status)}>{stateShortLabel(status)}</StatusBadge>
              </div>

              <p className={styles.headline}>
                {counts ? stateHeadline(status, counts) : "Importing your file…"}
              </p>

              {!terminal ? (
                <Progress
                  value={percent}
                  max={1}
                  tone={status === "failed" ? "danger" : "ink"}
                  label={`${filename} progress`}
                />
              ) : null}

              {summary ? (
                <div>
                  <span className={styles.sectionLabel}>Results</span>
                  <div className={styles.statGrid} style={{ marginTop: 8 }}>
                    <Stat label="Created" value={summary.created.toLocaleString()} />
                    <Stat label="Updated" value={summary.updated.toLocaleString()} />
                    <Stat label="Duplicates" value={summary.duplicates.toLocaleString()} />
                    <Stat label="Skipped" value={summary.skipped.toLocaleString()} />
                    <Stat label="Needs attention" value={summary.needsAttention.toLocaleString()} />
                    {counts ? <Stat label="Total rows" value={counts.total.toLocaleString()} /> : null}
                  </div>
                </div>
              ) : null}

              {terminal && legacyRejected.length > 0 ? (
                <div className={styles.drawerActions}>
                  <TpButton variant="secondary" size="sm" type="button" onClick={onDownloadRejected}>
                    Download rejected rows ({legacyRejected.length.toLocaleString()})
                  </TpButton>
                </div>
              ) : null}
            </div>
          )}
        </StateSwitch>
      </section>

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
    </main>
  );
}
