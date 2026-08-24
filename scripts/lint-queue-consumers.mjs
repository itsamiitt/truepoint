#!/usr/bin/env node
// lint-queue-consumers.mjs — a queue with a producer and no consumer fills Redis and never errors.
//
// Adding a queue is two edits in two files: `tracedQueue(NAME)` where something enqueues, and
// `tracedWorker(NAME, processor)` in the worker registry. Do the first and forget the second and NOTHING goes
// red: the producer succeeds, the jobs land in Redis, and they sit there. No exception, no failed job, no
// alert — the only symptom is work that silently never happens, and a queue depth nobody is looking at.
//
// That is the failure shape this repo keeps gating: correct-looking code whose defect is an absence. The rule
// was previously enforced by whoever remembered it.
//
// DEAD-LETTER QUEUES ARE THE EXCEPTION, and the only one. A `*_DLQ` is a parking lot: jobs are moved there
// precisely so they STOP being processed, and a consumer would defeat it. 12 of them exist and all are
// correct.
//
// Scope: producers are found repo-wide (apps/api declares ACCOUNT_REFRESH_QUEUE and apps/workers consumes it —
// a producer in the API and a consumer in the worker service is the intended split, not a violation), and a
// consumer anywhere satisfies the rule.
//
// Escape hatch, on the line above the declaration or within the file header:
//   // queue-consumer-ok: <why this queue has no consumer>
//
// Run: `node scripts/lint-queue-consumers.mjs` (wired as `bun run lint:queue-consumers`). Exit 0 = clean.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);

/**
 * The queue name routinely sits on the LINE AFTER the call:
 *   tracedWorker<RetentionSweepJobData>(
 *     RETENTION_SWEEP_QUEUE,
 * so these must match across newlines. A same-line pattern found 4 of 48 workers when this was first written
 * by hand — it would have reported 44 phantom orphans, which is how a check like this ends up deleted.
 */
// The generic is OPTIONAL and may itself contain `>` — `tracedQueue<Record<string, never>>(...)` is legal and
// common. The first version used `<[^>]*>` and was blind to exactly that: it stops at the INNER `>`, then
// demands `(` and finds `>`. It reported a clean pass on a planted violation, which is how this was caught —
// the non-greedy `[\s\S]*?` up to the `>(` pair is what makes a nested generic match.
const PRODUCER = /tracedQueue(?:<[\s\S]*?>)?\s*\(\s*([A-Z_][A-Z0-9_]*)/g;
const CONSUMER = /tracedWorker(?:<[\s\S]*?>)?\s*\(\s*([A-Z_][A-Z0-9_]*)/g;

const ALLOW = /queue-consumer-ok:/;

function sourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

const producers = new Map(); // queue const → first file that declares it
const consumers = new Set();
const exempted = new Set();
/** Queue constructions this check CANNOT analyse — reported, never silently dropped. */
const unanalysable = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    scanned += 1;
    const text = readFileSync(file, "utf8");

    // Raw BullMQ constructions, outside the traced* helpers this check understands. apps/forge-* builds its
    // queues as `new Queue(\`forge-${stage}\`)` and consumes them through the matching templated Worker, so
    // the NAMES are computed and cannot be matched statically at all.
    //
    // Deliberately NOT half-extended to cover the literal case: `new Queue("forge-parse")` is a literal
    // producer whose consumer is templated, so recognising literal producers WITHOUT resolving templated
    // consumers would report correct code as an orphan — a false positive on the one subsystem this would
    // newly touch. Reporting the count is the honest alternative: the reader learns the coverage boundary
    // instead of assuming there isn't one.
    // Comments blanked space-for-space first. The first run of this listed apps/workers/src/tuning.ts:4,
    // which is a COMMENT describing how register.ts spreads tuning into `new Worker(...)` — prose about a
    // construction, not one. `[^\S\r\n]*` and not `\s*`: \s matches newlines, so the greedy form deletes the
    // blank lines above a comment and shifts every line number after it.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/^[^\S\r\n]*\/\/.*$/gm, (m) => " ".repeat(m.length));

    for (const m of code.matchAll(/new\s+(?:Queue|Worker)\s*\(/g)) {
      const line = code.slice(0, m.index).split("\n").length;
      unanalysable.push(`${file.split(sep).join("/")}:${line}`);
    }

    if (!text.includes("traced")) continue;

    for (const m of text.matchAll(PRODUCER)) {
      if (!producers.has(m[1])) producers.set(m[1], file.split(sep).join("/"));
      // A declared exception anywhere in the file, or on the lines just above the match — the declaration
      // often spans lines, so the note lands above the whole call rather than beside the name.
      const before = text.slice(Math.max(0, m.index - 240), m.index);
      if (ALLOW.test(before) || ALLOW.test(text.slice(0, 1200))) exempted.add(m[1]);
    }
    for (const m of text.matchAll(CONSUMER)) consumers.add(m[1]);
  }
}

const orphans = [...producers.keys()]
  .filter((q) => !consumers.has(q))
  .filter((q) => !/_DLQ$/.test(q))
  .filter((q) => !exempted.has(q))
  .sort();

if (orphans.length === 0) {
  const dlqs = [...producers.keys()].filter((q) => /_DLQ$/.test(q)).length;
  process.stdout.write(
    `ok   ${producers.size} queue(s) across ${scanned} files, every non-DLQ one has a consumer (${dlqs} DLQ parking lot(s) skipped)` +
      (unanalysable.length > 0
        ? `\n     note: ${unanalysable.length} raw new Queue()/new Worker() construction(s) NOT analysed — ` +
          `their names are computed (apps/forge-*). Coverage boundary, stated rather than hidden:\n` +
          unanalysable.map((u) => `       ${u}`).join("\n")
        : "") +
      "\n",
  );
  process.exit(0);
}

process.stdout.write(
  `${orphans.length} queue(s) with a producer and no consumer:

${orphans.map((q) => `  ${q}  (declared in ${producers.get(q)})`).join("\n")}

Jobs enqueued here will sit in Redis for ever. Nothing throws, nothing retries, nothing alerts — the producer
succeeds and the work simply never happens, which is why this is a build failure rather than something to
notice later from a queue-depth graph.

Register a consumer in apps/workers/src/register.ts:
  instrument(tracedWorker<TJobData>(THE_QUEUE, processor, { connection, ...tuning }), THE_QUEUE)

A *_DLQ needs no consumer and is skipped automatically — a dead-letter queue is a parking lot by design.
If a queue genuinely should have no consumer, say why:  // queue-consumer-ok: <reason>
`,
);
process.exit(1);
