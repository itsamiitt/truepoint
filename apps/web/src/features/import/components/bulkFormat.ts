// bulkFormat.ts — presentation-only helpers for the bulk-import progress surface: a lifecycle label + StatusBadge
// tone per status, the seven row-accounting buckets to render, and a 0–1 → whole-percent formatter. Kept local to
// the slice (mirrors enrichment-jobs/format.ts) so the component stays small and self-contained — no cross-slice
// imports, no domain logic. The status enum is the @leadwolf/types contract (bulkImport.ts).

import type { BulkImportJobStatus, ImportJobCounts } from "@leadwolf/types";
import type { StatusTone } from "@leadwolf/ui";

const STATUS_LABEL: Record<BulkImportJobStatus, string> = {
  queued: "Queued",
  validating: "Validating",
  staged: "Staged",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  partial: "Completed with errors",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Human-readable label for a bulk-import lifecycle status. */
export function bulkStatusLabel(status: BulkImportJobStatus): string {
  return STATUS_LABEL[status] ?? status;
}

const STATUS_TONE: Record<BulkImportJobStatus, StatusTone> = {
  queued: "muted",
  validating: "muted",
  staged: "muted",
  running: "success",
  paused: "warning",
  completed: "success",
  partial: "warning",
  failed: "danger",
  cancelled: "muted",
};

/** The monochrome-system StatusBadge tone for a status (color earns its place only on the badge). */
export function bulkStatusTone(status: BulkImportJobStatus): StatusTone {
  return STATUS_TONE[status] ?? "muted";
}

/** The seven row-accounting buckets to break down (total is the denominator, shown separately). */
export const COUNT_FIELDS: { key: keyof ImportJobCounts; label: string }[] = [
  { key: "created", label: "Created" },
  { key: "matched", label: "Matched" },
  { key: "duplicate", label: "Duplicate" },
  { key: "skipped", label: "Skipped" },
  { key: "rejected", label: "Rejected" },
  { key: "deduped", label: "Deduped" },
  { key: "unprocessed", label: "Unprocessed" },
];

/** A 0–1 progress fraction as a clamped, whole-number percent. */
export function bulkPercent(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, progress)) * 100);
}
