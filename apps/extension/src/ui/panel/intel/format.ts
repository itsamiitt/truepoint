// format.ts — PURE display helpers for the Profile Intelligence Panel. No React, no chrome, no I/O, so every
// rule here is unit-testable and stated once.
//
// Two of these encode facts about the DATA that are easy to get wrong and impossible to see in the UI:
//
//   • PARTIAL DATES. The source asserts "2018" or "2026-05"; `start_precision`/`end_precision` record which.
//     Rendering a year-precision date as a month ("Jan 2018") invents information the record does not carry,
//     and computing a tenure from it invents a number. Both are refused here rather than approximated.
//
//   • THE MISSING START. `master_employment.started_on` defaults to the '-infinity' sentinel meaning "start
//     unknown"; the server already maps it back to null, and a null start must stay "—", never a duration
//     measured from year zero.

/**
 * Join the parts we have, or null when we have none.
 *
 * `[a, b].filter(Boolean).join(" ")` returns the EMPTY STRING for an empty list, and `?? fallback` does not
 * catch an empty string — so the obvious one-liner renders a blank line where the "not on record" fallback
 * belongs. Every place the panel composes a name or a location goes through this instead.
 */
export function joined(parts: Array<string | null | undefined>, sep = " "): string | null {
  const out = parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);
  return out.length > 0 ? out : null;
}

/** Two-letter initials for the avatar. The person's photo is deliberately not available (raw-only). */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "?";
}

/** A single-letter monogram for a company square (we hold no per-position logos — they are unmapped). */
export function monogram(name: string | null | undefined): string {
  return (name ?? "").trim()[0]?.toUpperCase() ?? "?";
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Parse an ISO-ish date (`YYYY-MM-DD`) without timezone drift — these are calendar dates, not instants. */
function parts(iso: string | null | undefined): { y: number; m: number } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return Number.isFinite(year) && Number.isFinite(month) ? { y: year, m: month } : null;
}

/**
 * One end of a date range, at the precision the SOURCE asserted.
 * `year` precision renders "2018" — never "Jan 2018", which would be a month we were never told.
 */
export function datePoint(iso: string | null | undefined, precision: string | null): string | null {
  const p = parts(iso);
  if (!p) return null;
  if (precision === "year") return String(p.y);
  return `${MONTHS[p.m - 1] ?? ""} ${p.y}`.trim();
}

/**
 * "Jun 2024 – Present" · "2019 – 2021" · "dates not on record".
 * A missing start with a known end still renders the end; a stint with neither says so plainly.
 */
export function dateRange(stint: {
  startedOn: string | null;
  endedOn: string | null;
  startPrecision: string | null;
  endPrecision: string | null;
  isCurrent?: boolean;
}): string | null {
  const start = datePoint(stint.startedOn, stint.startPrecision);
  const end = datePoint(stint.endedOn, stint.endPrecision);
  if (!start && !end) return null;
  if (!start) return end;
  if (stint.isCurrent && !end) return `${start} – Present`;
  return end ? `${start} – ${end}` : start;
}

/**
 * Duration in "2y 2m" form, from a start date to `now`.
 *
 * Returns null — never a guess — when the start is unknown OR was asserted only to the year: "2018" could be
 * eleven months of difference, and a tenure is exactly the kind of number a rep repeats out loud.
 */
export function tenure(
  startedOn: string | null | undefined,
  precision: string | null,
  now: Date = new Date(),
): string | null {
  if (precision === "year") return null;
  const p = parts(startedOn);
  if (!p) return null;
  const months = (now.getFullYear() - p.y) * 12 + (now.getMonth() + 1 - p.m);
  if (months < 0) return null;
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0 && m === 0) return "<1m";
  return [y > 0 ? `${y}y` : null, m > 0 ? `${m}m` : null].filter(Boolean).join(" ");
}

/** Whole days since an ISO timestamp; null when absent or unparseable. Floors, never negative. */
export function ageDays(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86_400_000));
}

/** "Aug 2026" from a first-of-month ISO date — the headcount series' axis and `as_of` label. */
export function monthLabel(iso: string | null | undefined): string | null {
  const p = parts(iso);
  return p ? `${MONTHS[p.m - 1] ?? ""} ${p.y}`.trim() : null;
}

/**
 * The masked email shown before a reveal: `••••••••@domain`. The domain is non-PII (it is on the masked
 * contact already) and it is what tells a rep whether we hold a work address at all.
 */
export function maskEmail(domain: string | null | undefined): string | null {
  return domain ? `••••••••@${domain}` : null;
}

/** "1 email · no phone" — what we hold, stated before anything is spent. */
export function contactSummary(hasEmail: boolean, hasPhone: boolean): string {
  return `${hasEmail ? "1 email" : "no email"} · ${hasPhone ? "1 phone" : "no phone"}`;
}

/** Percent with an explicit sign, tabular-friendly: +194%, -12%, 0%. */
export function signedPct(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const rounded = Math.round(pct);
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}
