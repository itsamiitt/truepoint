// stateCopy.ts — the pinned state→copy + tone table for the unified 12-state import machine (import-redesign
// 11 §4.2, adopted verbatim from 09 §9.2) plus the completion-summary label mapping (§4.3). ONE source so the
// history table, detail drawer, and durable job page can never disagree on a status string or its tone. Tones
// are the shipped StatusTone set (success | warning | danger | muted) — the monochrome system has no `info`
// tone (§8.3 DS gap), so non-terminal activity is carried by the Progress bar + stage line, never badge color.

import type { ImportJobCounts, ImportJobStatus, ImportJobStatusV2 } from "@leadwolf/types";
import type { StatusTone } from "@leadwolf/ui";

const TONE: Record<ImportJobStatusV2, StatusTone> = {
  draft: "muted",
  uploading: "muted",
  queued: "muted",
  deferred: "muted",
  validating: "muted",
  staged: "muted",
  running: "muted",
  paused: "warning",
  completed: "success",
  partial: "warning",
  failed: "danger",
  cancelled: "muted",
};

/** The monochrome StatusBadge tone for a v2 status (color earns its place only on terminal/attention states). */
export function stateTone(status: ImportJobStatusV2): StatusTone {
  return TONE[status] ?? "muted";
}

const SHORT_LABEL: Record<ImportJobStatusV2, string> = {
  draft: "Draft",
  uploading: "Uploading",
  queued: "Waiting to start",
  deferred: "Queued",
  validating: "Preparing",
  staged: "Preparing",
  running: "Importing",
  paused: "Paused",
  completed: "Done",
  partial: "Needs attention",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A compact status label for dense surfaces (the history table cell). */
export function stateShortLabel(status: ImportJobStatusV2): string {
  return SHORT_LABEL[status] ?? status;
}

/** The full §4.2 headline with typed interpolations — used on the job page + drawer header. */
export function stateHeadline(
  status: ImportJobStatusV2,
  counts: ImportJobCounts,
  opts?: { reason?: string | null; running?: number | null },
): string {
  const processed = Math.max(0, counts.total - counts.unprocessed);
  switch (status) {
    case "draft":
      return "Draft — finish setting up your import";
    case "uploading":
      return "Uploading your file";
    case "queued":
      return "Waiting to start";
    case "deferred":
      return opts?.running != null
        ? `Queued — will start when a slot frees (${opts.running.toLocaleString()} running)`
        : "Queued — will start when a slot frees";
    case "validating":
    case "staged":
      return "Preparing your file";
    case "running":
      return `Importing — ${processed.toLocaleString()} of ${counts.total.toLocaleString()} rows`;
    case "paused":
      return "Paused by TruePoint support";
    case "completed":
      return "Done";
    case "partial":
      return `Done — ${(counts.rejected + counts.unprocessed).toLocaleString()} rows need attention`;
    case "failed":
      return opts?.reason ? `Failed — ${opts.reason}` : "Failed";
    case "cancelled":
      return "Cancelled — rows already imported were kept";
    default:
      return status;
  }
}

/** The pinned stop-remainder cancel-confirm body (11 §4.2 — carried verbatim; 08 §2.2 cancellation ≠ undo). */
export const CANCEL_CONFIRM_BODY =
  "Stops the remaining rows. Contacts already imported are kept — cancelling doesn’t undo them.";

/** Terminal = the poll should stop; the row will not change further. */
export function isTerminalV2(status: ImportJobStatusV2): boolean {
  return (
    status === "completed" ||
    status === "partial" ||
    status === "failed" ||
    status === "cancelled"
  );
}

/** True while a job may still be cancelled (08 §2.1 CANCELLABLE_STATES — mirrors the server verb gate). */
export function isCancellableV2(status: ImportJobStatusV2): boolean {
  return (
    status === "draft" ||
    status === "queued" ||
    status === "deferred" ||
    status === "validating" ||
    status === "staged" ||
    status === "running"
  );
}

/** True while a terminal job has failed/unprocessed rows worth a retry-failed child (08 §6.3). */
export function isRetryableV2(status: ImportJobStatusV2): boolean {
  return status === "partial" || status === "failed";
}

/** Bridge a legacy (gate-off / non-uuid) poll status onto the v2 vocabulary so one surface renders both.
 *  The legacy enum is queued | active | completed | failed | unknown (bulkImport predates the 12 states). */
export function legacyStatusToV2(status: ImportJobStatus): ImportJobStatusV2 {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "active":
      return "running";
    default:
      return "queued";
  }
}

/** The §4.3 completion-summary buckets, re-labelled off the honest seven-bucket identity (never re-computed). */
export interface CompletionCounts {
  created: number;
  updated: number;
  skipped: number;
  needsAttention: number;
  duplicates: number;
}

export function completionCounts(counts: ImportJobCounts): CompletionCounts {
  return {
    created: counts.created,
    updated: counts.matched,
    skipped: counts.skipped + counts.deduped,
    needsAttention: counts.rejected + counts.unprocessed,
    duplicates: counts.duplicate,
  };
}
