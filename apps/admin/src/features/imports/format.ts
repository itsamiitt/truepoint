// format.ts — small pure presentation helpers for the Imports monitor (status/av-scan → badge tone, dates,
// numbers). Pure + DOM-free so they are unit-testable and shared across the slice. Tones map the import_jobs /
// av_scan_status closed enums (schema/importJobs.ts) to the monochrome StatusBadge palette.
import type { StatusTone } from "@leadwolf/ui";

/** Map an import_jobs.status value to a badge tone (terminal outcomes carry the strongest signal). */
export function jobStatusTone(status: string): StatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "partial":
    case "paused":
      return "warning";
    case "failed":
      return "danger";
    case "cancelled":
      return "muted";
    default:
      // queued / validating / staged / running — in-flight, no outcome yet.
      return "muted";
  }
}

/** Map an import_jobs.av_scan_status value to a badge tone (infected is the one to surface loudly). */
export function avScanTone(status: string): StatusTone {
  switch (status) {
    case "clean":
      return "success";
    case "infected":
      return "danger";
    case "skipped":
      return "warning";
    default:
      return "muted"; // pending
  }
}

/** A compact, locale-stable date (YYYY-MM-DD) from an ISO string; "—" when absent/invalid. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

/** Thousands-separated integer. */
export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}
