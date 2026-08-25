#!/usr/bin/env node
// lint-outcome-tags.mjs — rule 1: a commit that changes behaviour names the outcome it advances.
//
// CLAUDE.md rule 1, verbatim: "Every feature, commit, and PR names the outcome ID(s) it advances: [S-xx],
// [C-xx], [A-xx]. Work that serves no listed outcome gets flagged, not built." It is the first binding rule
// in the file and the only one of the seven that a machine can check, and nothing checked it.
//
// The rule exists to force a question at the moment it is cheap: which of the target outcomes does this
// advance? A commit that cannot answer is either mislabelled or is work that should have been flagged instead
// of built. Retrofitting the answer at review time is worth much less — by then the code exists and the
// tag becomes a formality chosen to fit.
//
// WHAT IT CHECKS, and why the scope is narrow:
//   • Only `feat` / `fix` / `refactor` / `perf` commits. `docs`, `style`, `chore`, `test`, `build` and `ci`
//     are exempt: an architecture-map regen or a formatting sweep advances no outcome, and demanding a tag
//     there would train people to paste one in — which is worse than not asking, because it makes every tag
//     noise.
//   • Only the commits in the RANGE given (default `origin/main..HEAD`), never history. THE MEASUREMENT SAYS
//     WHY (non-merge commits on main, 2026-08-25): of the last 300, 157 are behavioural and 6 lack a tag —
//     96% compliant. Widen to the last 1000 and it is 601 behavioural with 380 untagged — 36%. The practice
//     is RECENT. A gate that judged history would be red on arrival by a mile and would be switched off
//     rather than fixed; a gate scoped to the commits under review holds the line where the line is already
//     being held.
//   • Ranges here are not intuitive and a number quoted without one is worthless: `main~400..main` follows
//     FIRST-PARENT 400 times and then includes every commit from every branch merged in between — thousands,
//     spanning the `cascade` sub-project, which uses its own conventions. An early draft of this header
//     quoted a figure from that range and it disagreed with a `git log -400` count by an order of magnitude.
//     Both numbers were "right"; they described different populations.
//   • Merge commits are skipped: a merge advances whatever its parents advanced, and GitHub writes the
//     subject.
//
// Escape hatch, in the commit body — a reason, not a checkbox:
//   no-outcome: <why this changes behaviour yet advances no listed outcome>
//
// Run: `node scripts/lint-outcome-tags.mjs [range]` (wired as `bun run lint:outcome-tags`).
// In CI the range is the PR's own commits.

import { execFileSync } from "node:child_process";

const range = process.argv[2] ?? "origin/main..HEAD";

/** Conventional-commit types that change how the product behaves. */
const BEHAVIOURAL = /^(feat|fix|refactor|perf)(\([^)]*\))?!?:/;
/** [S-xx] / [C-xx] / [A-xx] — the outcome ids in docs/strategy/04-opportunity-scores.md. X- is a non-goal. */
const OUTCOME_TAG = /\[(S|C|A|X)-\d+\]/;
const ALLOW = /^\s*no-outcome:\s*\S/m;

/** `%H\x1f%s\x1f%b\x1e` — unit separators inside a record, record separator between, so a commit BODY
 *  containing newlines (they all do) cannot be mistaken for the next commit. Splitting on newlines here was
 *  the obvious first version and it reported a multi-paragraph body as several untagged commits. */
let raw;
try {
  raw = execFileSync("git", ["log", "--no-merges", "--format=%H\x1f%s\x1f%b\x1e", range], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (err) {
  const detail =
    String(err?.stderr ?? err?.message ?? err)
      .trim()
      .split("\n")[0] ?? "";
  process.stdout.write(
    `could not read the commit range ${range}: ${detail}\n\nThis is UNAVAILABLE, not clean — a range that cannot be read has told you nothing about the commits in it.\nIn CI, fetch the base branch before this step; locally, ensure origin/main exists.\n`,
  );
  process.exit(1);
}

const records = raw
  .split("\x1e")
  .map((r) => r.replace(/^\n/, ""))
  .filter((r) => r.trim().length > 0);

const offenders = [];
let behavioural = 0;
let exempted = 0;

for (const record of records) {
  const [hash = "", subject = "", body = ""] = record.split("\x1f");
  if (!BEHAVIOURAL.test(subject)) continue;
  behavioural += 1;
  if (OUTCOME_TAG.test(subject) || OUTCOME_TAG.test(body)) continue;
  if (ALLOW.test(body)) {
    exempted += 1;
    continue;
  }
  offenders.push(`${hash.slice(0, 8)} ${subject}`);
}

if (records.length === 0) {
  // Not a pass. An empty range is the shape a broken base-ref takes, and this check has nothing to say about
  // zero commits — saying "ok" there is how a gate starts reporting green on nothing.
  process.stdout.write(
    `no commits in ${range} — nothing was checked. If that is expected (a branch with no commits of its own),\nthis step has simply not run; it has not passed.\n`,
  );
  process.exit(0);
}

if (offenders.length === 0) {
  const note = exempted > 0 ? `, ${exempted} exempted with a stated reason` : "";
  process.stdout.write(
    `ok   ${records.length} commit(s) in ${range} · ${behavioural} behavioural, all naming an outcome${note}\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `${offenders.length} behaviour-changing commit(s) name no outcome (CLAUDE.md rule 1):\n${offenders
    .map((o) => `  ${o}`)
    .join(
      "\n",
    )}\n\nRule 1: "Every feature, commit, and PR names the outcome ID(s) it advances: [S-xx], [C-xx], [A-xx]. Work\nthat serves no listed outcome gets flagged, not built." The tag belongs in the subject; the body counts too.\nThe outcomes are listed in CLAUDE.md and scored in docs/strategy/04-opportunity-scores.md.\n\nIf this genuinely changes behaviour and advances nothing on that list, say so in the commit body:\n  no-outcome: <why>\nand expect the answer to be interesting — rule 1 exists because work with no outcome is meant to be flagged\nrather than built.\n`,
);
process.exit(1);
