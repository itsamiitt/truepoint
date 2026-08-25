// searchIntentScope.test.ts — the search filter surface may read `intent_signals`, but only for job changes.
//
// WHY THIS EXISTS. `intent_signals` is a tenant table whose CHECK admits nine signal types
// (`schema/intel.ts`). Exactly ONE of them has a producer: `job_change`, written by the [S-13] sweep
// (`core/src/data-health/recordJobChange.ts`, `workers/src/queues/jobChangeSweep.ts`) and by the
// source-landing employer-transition path. The other eight — among them `web_visit`,
// `content_engagement`, `keyword_search` — are the shape of THIRD-PARTY BEHAVIOURAL INTENT, which is
// [X-04], a deferred non-goal (`docs/strategy/04-opportunity-scores.md`;
// `docs/planning/market-intelligence/03-scope-and-constraints.md` §1-2).
//
// The 2026-08-25 ruling in `docs/strategy/decisions.md` (open-decision register, entry 8) is that our own
// job-change detection is S-13 rather than X-04, so the "Job change detected" range facet may read this
// table — SCOPED to `signal_type = 'job_change'`, and no wider. Read that entry before changing this file.
//
// Until now the whole of that ruling was held by a string literal inside one SQL template and a comment
// next to it asking the next reader not to widen it. Dropping the `AND s.signal_type = ...` is a
// one-token edit that turns an S-13 recency filter into a general intent-recency filter, changes no types,
// breaks no other test, and reads in review as a simplification. That is the defect this file catches.
//
// SCOPE, deliberately narrow: the FILTER surfaces only. `intentSignalRepository.recentForContact` reads
// every signal a contact has, and should — that is the record timeline DISPLAYING what exists, not a
// filter selecting people by behaviour. It is out of scope here on purpose.
//
// The client half of the same rule lives in `apps/web/src/features/prospect/filterScope.test.ts`
// ("the job-change filter is a job-change filter, not a signal filter"), which pins that no FACET is
// offered whose field names a signal or intent. The two are halves of one guard: that one stops the
// control appearing, this one stops the query widening underneath a control that already exists.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The eight `intent_signals` types with no producer — every one of them X-04-shaped. */
const NON_JOB_CHANGE_TYPES = [
  "new_hire",
  "funding_round",
  "tech_install",
  "web_visit",
  "content_engagement",
  "keyword_search",
  "linkedin_activity",
  "sales_nav_view",
] as const;

/**
 * Strip comments before scanning, so a prose mention of `intent_signals` can neither satisfy an assertion
 * nor trip one. Only whole-line `//` comments are removed (never a trailing one), because a trailing strip
 * would have to reason about `https://` and quoted slashes inside SQL — and every SQL template in these
 * files sits on its own lines, so the cheap rule is the correct one here.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function read(file: string): string {
  return codeOnly(readFileSync(join(import.meta.dir, "repositories", file), "utf8"));
}

/**
 * The enclosing `sql` template literal for a match — the actual statement, not a fixed-size window.
 * A character budget would either clip a reformatted subquery (a false pass) or run into the next one
 * (a false failure); the backticks are where the statement really ends.
 */
function enclosingSqlTemplate(code: string, matchIndex: number): string {
  const open = code.lastIndexOf("sql`", matchIndex);
  const close = code.indexOf("`", open + 4);
  if (open === -1 || close === -1) return code.slice(matchIndex, matchIndex + 400);
  return code.slice(open, close + 1);
}

const searchRepo = read("searchRepository.ts");
const accountSearchRepo = read("accountSearchRepository.ts");

describe("the X-04 boundary around intent_signals", () => {
  test("every intent_signals read in the people filter path is scoped to job_change", () => {
    const reads = [...searchRepo.matchAll(/\bfrom\s+intent_signals\b/gi)];
    // Not a cap on how many reads may exist — a second SCOPED read is harmless. The property is that no
    // read is unscoped, so each one is checked on its own.
    for (const match of reads) {
      const stmt = enclosingSqlTemplate(searchRepo, match.index ?? 0);
      expect(stmt).toMatch(/signal_type\s*=\s*'job_change'/);
    }
  });

  test("no filter clause names a signal type that has no producer", () => {
    // The widening `signal_type = 'job_change'` alone would NOT catch: adding `OR s.signal_type =
    // 'web_visit'` keeps the literal present while turning the filter into exactly the thing X-04 defers.
    // Checked across the whole module rather than per statement, because a type with no writer has no
    // legitimate use anywhere on this surface — a filter on it can only ever return nothing.
    // Collected rather than asserted one at a time so a failure names the offending type instead of
    // printing the whole module as the "received" value.
    const named = NON_JOB_CHANGE_TYPES.filter((type) => searchRepo.includes(`'${type}'`));
    expect(named).toEqual([]);
  });

  test("the account filter surface does not read intent_signals at all", () => {
    // The other filter repository, and the likelier shape of a quiet widening: an account-level "signals
    // recency" facet reads as firmographics rather than as intent, which is how it would get merged.
    expect(accountSearchRepo).not.toMatch(/\bintent_signals\b/i);
    expect(accountSearchRepo).not.toMatch(/\bintentSignals\b/);
  });

  test("neither filter repository imports the intentSignals table object", () => {
    // Both assertions above read raw SQL. A clause built through Drizzle — `.select().from(intentSignals)`
    // — would carry no `FROM intent_signals` text for them to find, so the ORM route has to be closed
    // separately or the guard is one refactor from being decorative.
    expect(searchRepo).not.toMatch(/\bintentSignals\b/);
    expect(accountSearchRepo).not.toMatch(/\bintentSignals\b/);
  });
});
