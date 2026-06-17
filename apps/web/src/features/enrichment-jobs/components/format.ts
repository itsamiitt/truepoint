// format.ts — presentation-only helpers for the enrichment-jobs surface: a relative-time formatter, a
// human label + StatusBadge tone per lifecycle status, and a percent formatter. Kept local to the slice so it
// stays self-contained (no cross-slice imports) and each component stays under the size cap.

import type { StatusTone } from "@leadwolf/ui";
import type { EnrichmentJobStatus } from "../types";

const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Format an ISO timestamp as a short absolute date+time, or an em dash when null/unparseable. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}

const RELATIVE_STEPS: Array<{ limit: number; div: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { limit: 60_000, div: 1000, unit: "second" },
  { limit: 3_600_000, div: 60_000, unit: "minute" },
  { limit: 86_400_000, div: 3_600_000, unit: "hour" },
  { limit: 604_800_000, div: 86_400_000, unit: "day" },
];

const relativeFmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** Format an ISO timestamp as a compact relative time (falls back to an absolute date past a week). */
export function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  for (const { limit, div, unit } of RELATIVE_STEPS) {
    if (abs < limit) return relativeFmt.format(Math.round(diff / div), unit);
  }
  return formatDateTime(iso);
}

/** A 0–1 fraction as a whole-number percent string. */
export function formatPercent(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

const STATUS_LABEL: Record<EnrichmentJobStatus, string> = {
  queued: "Queued",
  estimating: "Estimating",
  awaiting_confirmation: "Awaiting confirmation",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Human-readable label for a lifecycle status. */
export function statusLabel(status: EnrichmentJobStatus): string {
  return STATUS_LABEL[status] ?? status;
}

const STATUS_TONE: Record<EnrichmentJobStatus, StatusTone> = {
  queued: "muted",
  estimating: "muted",
  awaiting_confirmation: "warning",
  running: "success",
  paused: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "muted",
};

/** The monochrome-system StatusBadge tone for a lifecycle status (color earns its place only on the badge). */
export function statusTone(status: EnrichmentJobStatus): StatusTone {
  return STATUS_TONE[status] ?? "muted";
}
