// backfillTitleFunction.ts — the operator-invoked backfill migration 0136 promised and nobody wrote.
//
// 0136 materialised three derived person facets to make the Phase-1 filters index-backed. It backfilled the
// two employment dates in SQL, and deliberately did NOT backfill `title_function`:
//
//   "title_function is deliberately NOT backfilled here. The mapping lives in the core title taxonomy
//    (TypeScript), not in SQL, and duplicating it as a CASE expression would create a second implementation
//    that drifts from the first — the failure mode this codebase has already paid for elsewhere. It is
//    populated by the landing writer, and by masterPersonDerivedRepository.backfillTitleFunctionTx for the
//    existing rows (an operator-invoked bounded sweep, not a new queue)."
//
// `backfillTitleFunctionTx` does not exist. The migration names a method that was never written, so every
// master_person that predates the landing writer still has `title_function IS NULL` — invisible today because
// nothing reads the column yet, and silently wrong the moment the job-function filter ships, because a NULL
// never matches and those people would simply be absent from results.
//
// Found by the repository-call-site audit: `listForTitleFunctionBackfillTx` is built, and called by nothing.
//
// A SWEEP, NOT A QUEUE — the migration's words, and the right call. This is a one-time catch-up over an
// existing population, not recurring work: the landing writer keeps every row written after 0136 fresh. A
// scheduled job would run forever to do nothing.
//
// The mapping is `canonicalizeTitle(title)?.jobFunction ?? null` — the SAME call landSourcePayload makes, not
// a reimplementation. That is the entire reason this is TypeScript rather than SQL, so it must never become a
// local copy of the taxonomy.

import { masterPersonDerivedRepository, withErTx } from "@leadwolf/db";
import { canonicalizeTitle } from "../search/canonicalizeTitle.ts";

/** One page's worth of decisions — computed with no database in reach, so the mapping is unit-testable. */
export interface TitleFunctionDecision {
  id: string;
  jobTitle: string;
  /** The taxonomy's answer. NULL is a real outcome: an unresolvable title is a legitimate gap, not an error,
   *  and the filter simply never matches those rows (landSourcePayload documents the same rule). */
  jobFunction: string | null;
}

/**
 * Map a page of (id, jobTitle) rows to their derived function.
 *
 * Pure and exported precisely so the backfill's decisions can be asserted without Postgres — the risk in a
 * backfill is never the loop, it is writing the wrong value to a lot of rows at once.
 */
export function decideTitleFunctions(
  rows: ReadonlyArray<{ id: string; jobTitle: string }>,
): TitleFunctionDecision[] {
  return rows.map((row) => ({
    id: row.id,
    jobTitle: row.jobTitle,
    jobFunction: canonicalizeTitle(row.jobTitle)?.jobFunction ?? null,
  }));
}

export interface BackfillTitleFunctionOptions {
  /** Rows per transaction. Each page is its own tx so an interrupted run keeps everything it committed. */
  pageSize?: number;
  /** Stop after this many pages. A bound, so an operator can take a bite rather than commit to the whole set. */
  maxPages?: number;
  /** Resume point — the last id of the previous run, echoed in this one's result. */
  afterId?: string | null;
  /** Compute and count, write nothing. */
  dryRun?: boolean;
  /** Progress sink; defaults to silence so a library import prints nothing. */
  onProgress?: (progress: BackfillProgress) => void;
}

export interface BackfillProgress {
  pages: number;
  scanned: number;
  resolved: number;
  unresolved: number;
  lastId: string | null;
}

export interface BackfillTitleFunctionResult extends BackfillProgress {
  /** True when a page came back short — the population is exhausted, not merely the page budget. */
  complete: boolean;
}

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 200;

/**
 * Page through persons whose `title_function` is unset and derive it.
 *
 * Idempotent and resumable: the query returns only `title_function IS NULL AND job_title IS NOT NULL`, keyset
 * by id, and the cursor is the last id of the previous page — so a re-run after a crash resumes rather than
 * restarting. Each page commits in its OWN transaction; a single tx over hundreds of thousands of rows would
 * hold locks for the whole run and lose everything on failure.
 *
 * Rows whose title does not resolve are NOT written. Their derived value is NULL and the column is already
 * NULL, and `setTitleFunctionTx` guards with `IS DISTINCT FROM`, so the write is a round-trip that changes
 * nothing. They stay selectable, which means a FRESH run (no `afterId`) re-scans them — inherent to a
 * NULL-means-both-"unset"-and-"unresolvable" column, and harmless for a one-time sweep. It is also why the
 * cursor, not the column, is the resume mechanism: carry `lastId` forward between runs.
 */
export async function backfillTitleFunction(
  options: BackfillTitleFunctionOptions = {},
): Promise<BackfillTitleFunctionResult> {
  const pageSize = Math.max(1, Math.min(5000, options.pageSize ?? DEFAULT_PAGE_SIZE));
  const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);

  let cursor = options.afterId ?? null;
  let pages = 0;
  let scanned = 0;
  let resolved = 0;
  let unresolved = 0;
  let complete = false;

  while (pages < maxPages) {
    const rows = await withErTx((tx) =>
      masterPersonDerivedRepository.listForTitleFunctionBackfillTx(tx, cursor, pageSize),
    );
    if (rows.length === 0) {
      complete = true;
      break;
    }

    const decisions = decideTitleFunctions(rows);

    // Only the rows that actually resolved. Writing NULL over NULL is a no-op the repository already guards
    // against (`IS DISTINCT FROM`), so sending them costs a round-trip per row to change nothing — on a page
    // of 500 mostly-unresolvable titles that is the whole cost of the page.
    const writes = decisions.filter((d) => d.jobFunction !== null);

    if (!options.dryRun && writes.length > 0) {
      // One transaction per page, not per row: the writes are independent, and a per-row tx would multiply
      // round-trips by pageSize for no isolation benefit.
      await withErTx(async (tx) => {
        for (const decision of writes) {
          await masterPersonDerivedRepository.setTitleFunctionTx(
            tx,
            decision.id,
            decision.jobFunction,
          );
        }
      });
    }

    pages += 1;
    scanned += decisions.length;
    resolved += decisions.filter((d) => d.jobFunction !== null).length;
    unresolved += decisions.filter((d) => d.jobFunction === null).length;
    cursor = decisions[decisions.length - 1]?.id ?? cursor;

    options.onProgress?.({ pages, scanned, resolved, unresolved, lastId: cursor });

    // A short page means the population is exhausted. Checked AFTER the write so the last partial page is
    // still committed.
    if (rows.length < pageSize) {
      complete = true;
      break;
    }
  }

  return { pages, scanned, resolved, unresolved, lastId: cursor, complete };
}
