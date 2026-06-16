// format.ts — small shared formatters for the home cockpit cards (date + relative time). Presentation-only
// helpers kept in one place so each widget stays under the size cap and formats dates consistently.

const dateFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Format an ISO timestamp as a short absolute date, or an em dash when unparseable. */
export function formatDate(iso: string): string {
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
export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  for (const { limit, div, unit } of RELATIVE_STEPS) {
    if (abs < limit) return relativeFmt.format(Math.round(diff / div), unit);
  }
  return formatDate(iso);
}
