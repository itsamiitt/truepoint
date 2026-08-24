// backfill-title-function.ts — the operator sweep migration 0136 promised.
//
//   bun run backfill:title-function -- --dry-run
//   bun run backfill:title-function -- --page-size 500 --max-pages 20
//   bun run backfill:title-function -- --after 0f9c…  (resume from a previous run's lastId)
//
// Needs the same DATABASE_URL the app uses; it runs on the ER seam (withErTx), Layer 0, no tenant scope.
//
// WHY A SCRIPT AND NOT A QUEUE: 0136's own words — "an operator-invoked bounded sweep, not a new queue". The
// landing writer keeps every row written after 0136 fresh, so this is a one-time catch-up over the existing
// population. A scheduled job would run forever to do nothing, and this codebase has just spent a sweep of
// audits removing exactly that kind of machinery.
//
// DEFAULT IS A DRY RUN'S SIBLING, NOT A DRY RUN: this writes. Start with --dry-run to see the resolve/unresolve
// split before committing to it, and note that an unresolvable title is a legitimate outcome (NULL), not a
// failure — a population with many of them is information about the taxonomy, not a reason to retry.

import { backfillTitleFunction } from "@leadwolf/core";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const dryRun = process.argv.includes("--dry-run");
const pageSize = Number(arg("page-size") ?? 500);
const maxPages = Number(arg("max-pages") ?? 200);
const afterId = arg("after") ?? null;

if (!Number.isFinite(pageSize) || !Number.isFinite(maxPages)) {
  console.error("page-size and max-pages must be numbers");
  process.exit(2);
}

console.log(
  `title_function backfill — ${dryRun ? "DRY RUN (writes nothing)" : "WRITING"}, page ${pageSize}, max ${maxPages} page(s)${afterId ? `, resuming after ${afterId}` : ""}`,
);

const result = await backfillTitleFunction({
  pageSize,
  maxPages,
  afterId,
  dryRun,
  onProgress: (p) => {
    console.log(
      `  page ${p.pages}: scanned ${p.scanned}, resolved ${p.resolved}, unresolved ${p.unresolved} — lastId ${p.lastId}`,
    );
  },
});

console.log(
  `\n${dryRun ? "would have written" : "wrote"} ${result.resolved} of ${result.scanned} scanned (${result.unresolved} title(s) the taxonomy does not resolve — left NULL, which is correct).`,
);

if (result.complete) {
  console.log("population exhausted — nothing left with a title and no derived function.");
} else {
  // The distinction that matters when resuming: this stopped because it hit its OWN bound, not because the
  // work is done. Re-run with --after to continue, or the next run starts from the top and re-scans.
  console.log(`stopped at the --max-pages bound. Re-run with:  --after ${result.lastId}`);
}
