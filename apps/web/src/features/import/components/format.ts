// format.ts — presentation-only date/number helpers for the durable import history surface (S-U2). Kept local
// to the slice (no cross-slice imports) so each component stays under the size cap. Status labels + tones live
// in shared/stateCopy.ts (the pinned 12-state table); this file is dates + percent only.

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
