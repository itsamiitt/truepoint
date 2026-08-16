// partialDate.ts — normalization for source-asserted PARTIAL dates ("2018", "2026-05", null).
//
// LinkedIn-style sources assert dates at year or month precision; Layer-0 edge tables
// (master_employment/master_education) store real Postgres `date`s because the '-infinity' "start unknown"
// sentinel and the stint-dedup uniques are load-bearing (masterGraph.ts uniq_employment_stint). This module
// is the ONE place a partial date becomes a (date, precision) pair — the same single-implementation rule as
// the company-name normalizer (two implementations WILL drift, and drifted dates silently split stints).
//
// Convention (0112): 'year' → normalized to Jan 1; 'month' → to the 1st. A null/unparseable input returns
// null and the caller stores the '-infinity' sentinel with NULL precision ("unknown").
//
// ACCEPTED LIMIT (stated, not glossed): a source that later refines "2018" to "2018-03" produces a different
// normalized date and therefore a different stint identity. Within one source the asserted format is stable
// per stint; cross-source variance is ER's job, and source_records keeps the evidence to re-resolve.

export type PartialDatePrecision = "year" | "month" | "day";

export interface NormalizedPartialDate {
  /** ISO date string (YYYY-MM-DD), safe to bind to a Postgres `date` column. */
  isoDate: string;
  precision: PartialDatePrecision;
}

const YEAR_RE = /^(\d{4})$/;
const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;
const FULL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a source-asserted partial date into a (date, precision) pair.
 * Returns null for null/empty/garbage input — the caller maps that to the '-infinity' sentinel.
 */
export function parsePartialDate(input: string | null | undefined): NormalizedPartialDate | null {
  if (input == null) return null;
  const raw = input.trim();
  if (raw === "") return null;

  const yearOnly = YEAR_RE.exec(raw);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    if (year < 1000 || year > 2100) return null;
    return { isoDate: `${yearOnly[1]}-01-01`, precision: "year" };
  }

  const yearMonth = YEAR_MONTH_RE.exec(raw);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    if (year < 1000 || year > 2100 || month < 1 || month > 12) return null;
    return { isoDate: `${yearMonth[1]}-${yearMonth[2]}-01`, precision: "month" };
  }

  const fullDate = FULL_DATE_RE.exec(raw);
  if (fullDate) {
    const year = Number(fullDate[1]);
    const month = Number(fullDate[2]);
    const day = Number(fullDate[3]);
    if (year < 1000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { isoDate: raw, precision: "day" };
  }

  return null;
}
