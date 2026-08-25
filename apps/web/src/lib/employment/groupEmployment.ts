// groupEmployment.ts — turn a flat list of employment stints into the LinkedIn-shaped view: one block per
// COMPANY, with the roles held there listed under it. Pure; no React, no I/O. [S-09] [S-13]
//
// WHY THIS EXISTS. `master_employment` is one row per (person, company, start), so a promotion is a second
// row at the same company — that is the correct grain and it is not changing. Every surface, though,
// rendered the rows flat, so someone promoted from Finance Manager to Finance Director at Acme read as two
// unrelated entries with the company name printed twice, and nothing said it was one continuous tenure. The
// data already knew; only the display did not.
//
// THREE THINGS THIS HAS TO GET RIGHT, all of them properties of the data rather than of the layout:
//
//   1. GROUP ON IDENTITY, NOT ON THE PRINTED NAME. `groupKey` is an opaque token the API derives from the
//      resolved company id (falling back to the normalized name for an unresolved employer). Grouping on the
//      display name instead would merge two different companies that happen to share a name, and split one
//      company written two ways — both silently.
//   2. TOLERATE PHANTOM STINTS. A source that refines "2018" to "2018-03" mints a SECOND row for the same
//      real role (the dedup key is (person, company, started_on)). Left alone that renders as a duplicate
//      promotion. `mergeRefinements` folds only the unambiguous case: same company, same title, overlapping
//      dates — keeping the more precise assertion.
//   3. DEGRADE TO ONE CLEAN LINE. The live import path mints a BARE edge — company, is_current, is_primary,
//      no title and no dates (planning doc 33 §A2). A group of one bare edge must read as a single company
//      line, not as a company heading above an empty role row.

import { type DateSpan, dateRange, duration, spansOverlap, startKey } from "./dates";

/** One employment stint, normalized from either wire contract (the two differ in case and in extras). */
export interface EmploymentStintInput {
  /** Opaque, stable company identity from the API. Absent ⇒ fall back to the normalized display name. */
  groupKey?: string | null;
  companyName: string | null;
  companyDomain?: string | null;
  title: string | null;
  department?: string | null;
  location?: string | null;
  isCurrent: boolean;
  isPrimary?: boolean;
  /** Null means "start unknown" — the '-infinity' sentinel, already mapped back by the repositories. */
  startedOn: string | null;
  endedOn: string | null;
  startPrecision?: string | null;
  endPrecision?: string | null;
  /** Provenance, shown where present [A-01]. */
  confidence?: number | null;
  sourceCount?: number | null;
}

/** One role within a company block. */
export interface EmploymentRole extends EmploymentStintInput {
  /** Stable within the grouped result — safe as a React key. */
  id: string;
  /** "Jun 2024 – Present" at the precision the source asserted, or null when it asserted no dates. */
  dateRange: string | null;
  /** "2y 2m" for this role alone, or null when the dates cannot support the claim. */
  duration: string | null;
}

/** One company, with every role held there. */
export interface CompanyGroup {
  /** Stable within the grouped result — safe as a React key. */
  id: string;
  companyName: string | null;
  companyDomain: string | null;
  /** True when ANY role in the group is current (concurrent affiliations are legal in this model). */
  isCurrent: boolean;
  /** Total time at the company across all roles, or null when the dates cannot support the claim. */
  totalDuration: string | null;
  /** Newest first: current roles, then by start date, unknown starts last. */
  roles: EmploymentRole[];
  /**
   * True when this group carries no role detail at all — a single stint with no title and no dates (the
   * bare edge the live import path mints). The UI renders one company line rather than an empty role row.
   */
  isBareEdge: boolean;
}

/** The identity a stint groups on. Prefer the API's opaque key; fall back to the folded display name. */
function keyOf(stint: EmploymentStintInput): string {
  if (stint.groupKey) return stint.groupKey;
  const name = stint.companyName?.trim().toLowerCase();
  // No key AND no name: every such stint is its own group. Folding them together would assert that two
  // unnamed employers are the same employer, which nothing in the record supports.
  return name ? `name:${name}` : "unknown";
}

/** Newest first within a company: current roles lead, then latest start, unknown starts last. */
function byRecency(a: EmploymentStintInput, b: EmploymentStintInput): number {
  if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
  const ak = startKey(a.startedOn);
  const bk = startKey(b.startedOn);
  if (ak === null && bk === null) return 0;
  if (ak === null) return 1; // unknown start sinks
  if (bk === null) return -1;
  return bk - ak;
}

/** How much a stint actually asserts — used to keep the better of two refinements of one role. */
function specificity(stint: EmploymentStintInput): number {
  let score = 0;
  if (stint.startPrecision && stint.startPrecision !== "year") score += 2;
  if (stint.startedOn) score += 1;
  if (stint.endedOn) score += 1;
  if (stint.department) score += 1;
  if (stint.location) score += 1;
  score += stint.sourceCount ?? 0;
  return score;
}

/**
 * Fold stints that are the same real role asserted at different precisions. Deliberately conservative:
 * identical (case-folded) title AND overlapping dates. A genuine re-hire at the same company into the same
 * title years later does NOT overlap, so it survives as its own role.
 */
function mergeRefinements(stints: EmploymentStintInput[]): EmploymentStintInput[] {
  const kept: EmploymentStintInput[] = [];
  for (const stint of stints) {
    const title = stint.title?.trim().toLowerCase() ?? null;
    const twinIndex = kept.findIndex((k) => {
      const kTitle = k.title?.trim().toLowerCase() ?? null;
      if (kTitle !== title) return false;
      // Two untitled stints at one company are not provably the same role, so they are never folded.
      if (title === null) return false;
      return spansOverlap(asSpan(k), asSpan(stint));
    });
    if (twinIndex === -1) {
      kept.push(stint);
      continue;
    }
    const twin = kept[twinIndex] as EmploymentStintInput;
    kept[twinIndex] = specificity(stint) > specificity(twin) ? stint : twin;
  }
  return kept;
}

function asSpan(stint: EmploymentStintInput): DateSpan {
  return {
    startedOn: stint.startedOn,
    endedOn: stint.endedOn,
    startPrecision: stint.startPrecision ?? null,
    endPrecision: stint.endPrecision ?? null,
    isCurrent: stint.isCurrent,
  };
}

/** The company-wide span: earliest known start to the latest end (or now, if any role is current). */
function totalSpan(roles: EmploymentStintInput[]): DateSpan | null {
  const withStart = roles.filter((r) => startKey(r.startedOn) !== null);
  if (withStart.length === 0) return null;
  const earliest = withStart.reduce((acc, r) =>
    (startKey(r.startedOn) as number) < (startKey(acc.startedOn) as number) ? r : acc,
  );
  const anyCurrent = roles.some((r) => r.isCurrent);
  // A single open-ended role among closed ones still means "to now" for the company total.
  const latestEnd = anyCurrent
    ? null
    : roles.reduce<string | null>((acc, r) => {
        if (!r.endedOn) return acc;
        return acc === null || r.endedOn > acc ? r.endedOn : acc;
      }, null);
  return {
    startedOn: earliest.startedOn,
    endedOn: latestEnd,
    startPrecision: earliest.startPrecision ?? null,
    endPrecision: null,
    isCurrent: anyCurrent,
  };
}

/**
 * Group stints by company, newest company first.
 *
 * Input order is not trusted — the two read repositories order differently (one leads with is_current, the
 * other with is_primary), and a grouped view must not inherit that difference.
 */
export function groupStints(
  stints: readonly EmploymentStintInput[],
  now: Date = new Date(),
): CompanyGroup[] {
  const byCompany = new Map<string, EmploymentStintInput[]>();
  for (const stint of stints) {
    const key = keyOf(stint);
    const bucket = byCompany.get(key);
    if (bucket) bucket.push(stint);
    else byCompany.set(key, [stint]);
  }

  const groups: CompanyGroup[] = [];
  for (const [key, bucket] of byCompany) {
    const ordered = mergeRefinements([...bucket].sort(byRecency)).sort(byRecency);
    const span = totalSpan(ordered);
    const first = ordered[0] as EmploymentStintInput;
    const isBareEdge = ordered.length === 1 && !first.title && !first.startedOn && !first.endedOn;

    groups.push({
      id: key,
      // The display name comes from the most specific stint that has one — an unresolved employer can
      // carry the raw name on one row and nothing on another.
      companyName: ordered.find((s) => s.companyName)?.companyName ?? null,
      companyDomain: ordered.find((s) => s.companyDomain)?.companyDomain ?? null,
      isCurrent: ordered.some((s) => s.isCurrent),
      totalDuration: span ? duration(span, now) : null,
      isBareEdge,
      roles: ordered.map((stint, i) => ({
        ...stint,
        id: `${key}:${stint.startedOn ?? "?"}:${stint.title ?? "?"}:${i}`,
        dateRange: dateRange(asSpan(stint)),
        duration: duration(asSpan(stint), now),
      })),
    });
  }

  // Companies in the same order their best role would have appeared in the flat list, so the grouped view
  // reads as a reordering of the old one rather than a different dataset.
  return groups.sort((a, b) =>
    byRecency(a.roles[0] as EmploymentRole, b.roles[0] as EmploymentRole),
  );
}
