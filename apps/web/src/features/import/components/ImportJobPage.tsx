// ImportJobPage.tsx — the durable, full-page status view for ONE import (import-redesign 11 §4, S-U3). Reached
// by URL (/imports/:jobId) so the handle IS the URL: refresh or navigate-away-and-back resumes cleanly, and the
// poll NEVER gives up (useImportJob follows the 09 §4.3 cadence, no ~2-min abort — the G11 fix). Works for BOTH
// shapes GET /imports/:jobId returns: the additive v2 detail (counts, when the IMPORT_V2 gate is on) and the
// legacy poll response (status + summary, gate-off) — the sync import navigates here on submit either way. Shows
// the §4.2 status headline, a progress bar, the completion summary bar, a rejected-rows download (legacy), and
// Cancel while the job is still cancellable. Artifact downloads + retry-failed land at S-U6. Public slice component.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { EmptyState, Progress, Spinner, StateSwitch, StatusBadge, TpButton, useToast } from "@leadwolf/ui";
import type { ImportJobCounts } from "@leadwolf/types";
import { ArrowLeft, Download, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useImportJob } from "../hooks/useImportJob";
import { useCancelImport, useRetryFailed } from "../hooks/useImportMutations";
import { type ArtifactKind, type ImportJobDetail, downloadArtifact } from "../apiV2";
import { rejectedRowsToCsv } from "../rejectedRowsCsv";
import { ConfirmDialog } from "./shared/ConfirmDialog";
import {
  completionCounts,
  isCancellableV2,
  isRetryableV2,
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
  const router = useRouter();
  const toast = useToast();
  const { data: detail, isLoading, isError, error } = useImportJob(jobId);
  const cancel = useCancelImport();
  const retry = useRetryFailed();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [retryOpen, setRetryOpen] = useState(false);
  const [downloading, setDownloading] = useState<ArtifactKind | null>(null);

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
  const retryable = status != null && isRetryableV2(status);
  const legacyRejected = detail?.summary?.rejectedRows ?? [];
  // v2 (gate-on) jobs carry `counts` + a `rejectHistogram`; legacy jobs carry only `summary`. The v2 artifact
  // pair + retry-failed verb only exist for v2 jobs; legacy keeps its client-side rejected-rows download.
  const isV2 = detail?.counts != null;
  const histogram = Object.entries(
    detail?.rejectHistogram ?? detail?.summary?.rejectHistogram ?? {},
  ).sort((a, b) => b[1] - a[1]);
  const rejectedCount = counts?.rejected ?? 0;

  function onConfirmCancel() {
    cancel.mutate(jobId, {
      onSuccess: () => setConfirmOpen(false),
      onError: () => setConfirmOpen(false),
    });
  }

  function onConfirmRetry() {
    retry.mutate(jobId, {
      onSuccess: (child) => {
        setRetryOpen(false);
        toast.success("Retrying failed rows", "We opened the retry import.");
        router.push(`/imports/${child.jobId}`); // the retry-failed CHILD job's durable page
      },
      onError: (e) => {
        setRetryOpen(false);
        toast.error("Couldn’t retry", e instanceof Error ? e.message : "Please try again.");
      },
    });
  }

  async function onDownloadArtifact(kind: ArtifactKind) {
    setDownloading(kind);
    try {
      await downloadArtifact(jobId, kind);
    } catch (e) {
      toast.error("Couldn’t download the file", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setDownloading(null);
    }
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

              {terminal && histogram.length > 0 ? (
                <div>
                  <span className={styles.sectionLabel}>Why rows need attention</span>
                  <ul className={styles.mono} style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                    {histogram.map(([label, count]) => (
                      <li key={label}>
                        {label}: {count.toLocaleString()}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {terminal && isV2 && rejectedCount > 0 ? (
                <p className={styles.muted} style={{ margin: 0, fontSize: 13 }}>
                  These files contain the affected rows’ contact data — handle and share them securely.
                </p>
              ) : null}

              {terminal && (rejectedCount > 0 || retryable || legacyRejected.length > 0) ? (
                <div className={styles.drawerActions}>
                  {/* v2 (gate-on) jobs: the PII-bearing artifact pair via the proxied+audited endpoint. */}
                  {isV2 && rejectedCount > 0 ? (
                    <>
                      <TpButton
                        variant="secondary"
                        size="sm"
                        type="button"
                        leftIcon={<Download size={14} />}
                        loading={downloading === "repair"}
                        onClick={() => void onDownloadArtifact("repair")}
                      >
                        Download rows to fix
                      </TpButton>
                      <TpButton
                        variant="secondary"
                        size="sm"
                        type="button"
                        leftIcon={<Download size={14} />}
                        loading={downloading === "errors"}
                        onClick={() => void onDownloadArtifact("errors")}
                      >
                        Download error report
                      </TpButton>
                    </>
                  ) : null}
                  {/* Legacy jobs keep the client-side rejected-rows CSV (no server artifact). */}
                  {!isV2 && legacyRejected.length > 0 ? (
                    <TpButton variant="secondary" size="sm" type="button" onClick={onDownloadRejected}>
                      Download rejected rows ({legacyRejected.length.toLocaleString()})
                    </TpButton>
                  ) : null}
                  {isV2 && retryable ? (
                    <TpButton
                      variant="primary"
                      size="sm"
                      type="button"
                      loading={retry.isPending}
                      onClick={() => setRetryOpen(true)}
                    >
                      Retry failed rows
                    </TpButton>
                  ) : null}
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

      <ConfirmDialog
        open={retryOpen}
        onClose={() => setRetryOpen(false)}
        title="Retry the failed rows?"
        body="We’ll start a new import with just the rows that didn’t land, using the same mapping and settings. Rows that already imported are untouched."
        confirmLabel="Retry failed rows"
        cancelLabel="Not now"
        busy={retry.isPending}
        onConfirm={onConfirmRetry}
      />
    </main>
  );
}
