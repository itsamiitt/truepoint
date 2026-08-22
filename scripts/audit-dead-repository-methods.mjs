// Find repository METHODS that nothing outside their own file and tests ever calls.
//
// Not a lint. An audit: "built, tested, and never called" is a real class here (I4's confirmMerge), and a
// method nobody calls delivers zero outcome while reading as done in every review and status doc.
//
// Method-level, not module-level, because the repository objects themselves are all imported somewhere — the
// dark part is always a method hanging off a live object.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const REPO_DIR = "packages/db/src/repositories";
const SEARCH_ROOTS = ["apps", "packages"];

function walk(dir, out = [], filter = () => true) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (["node_modules", "dist", ".next", "build", ".turbo", "coverage"].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out, filter);
    else if (filter(full)) out.push(full);
  }
  return out;
}

const isTest = (f) => /\.(test|itest)\.tsx?$/.test(f);
const repoFiles = walk(REPO_DIR, [], (f) => f.endsWith(".ts") && !isTest(f));

// Every non-test source file in the monorepo, read once.
const allFiles = [];
for (const root of SEARCH_ROOTS) walk(root, allFiles, (f) => /\.tsx?$/.test(f));
const corpus = new Map();
for (const f of allFiles) corpus.set(f, readFileSync(f, "utf8"));

/** `export const fooRepository = {` … methods are the `name(` / `async name(` entries at one indent level. */
const OBJECT = /export const (\w+Repository)\s*=\s*\{/g;
const METHOD = /^ {2}(?:async )?(\w+)\s*(?:<[^>]*>)?\(/gm;

const findings = [];
let methodCount = 0;

for (const file of repoFiles) {
  const text = readFileSync(file, "utf8");
  for (const objMatch of text.matchAll(OBJECT)) {
    const objName = objMatch[1];
    // Body = from the opening brace to the line that closes it at column 0 (`};`).
    const start = objMatch.index + objMatch[0].length;
    const endRel = text.slice(start).search(/^\};/m);
    const body = endRel === -1 ? text.slice(start) : text.slice(start, start + endRel);

    for (const m of body.matchAll(METHOD)) {
      const method = m[1];
      methodCount += 1;
      const call = `${objName}.${method}`;
      // Two spellings, because requiring the qualified form produced false positives: apps/workers calls
      // `repository.markFailed(...)` where `repository` is an injected `Pick<typeof outboxRepository, ...>`,
      // and importReaperSweep calls `.listReapableDrafts(` off a chained alias. Neither contains the literal
      // `objName.method`. Accepting the bare `.method(` under-reports instead (a same-named method on another
      // repository masks a dead one) — the right direction for an audit a human will act on: every finding
      // that survives is worth reading, and the cost of the trade is stated rather than hidden.
      const bare = `.${method}(`;
      const callers = [];
      let testOnly = 0;
      for (const [f, content] of corpus) {
        if (f === file) continue;
        if (!content.includes(call) && !content.includes(bare)) continue;
        if (isTest(f)) {
          testOnly += 1;
          continue;
        }
        callers.push(f.split(sep).join("/"));
      }
      if (callers.length === 0) {
        findings.push({
          file: file.split(sep).join("/"),
          symbol: call,
          tests: testOnly,
        });
      }
    }
  }
}

findings.sort((a, b) => b.tests - a.tests || a.symbol.localeCompare(b.symbol));

const tested = findings.filter((f) => f.tests > 0);
const untested = findings.filter((f) => f.tests === 0);

process.stdout.write(
  `${methodCount} repository methods scanned across ${repoFiles.length} files\n`,
);
process.stdout.write(`${findings.length} with no non-test caller anywhere\n\n`);
process.stdout.write(
  `— TESTED BUT NEVER CALLED (${tested.length}) — built, proven, unreachable:\n`,
);
for (const f of tested)
  process.stdout.write(`  ${f.symbol}  (${f.tests} test file(s))  ${f.file}\n`);
process.stdout.write(`\n— NEITHER CALLED NOR TESTED (${untested.length}):\n`);
for (const f of untested) process.stdout.write(`  ${f.symbol}  ${f.file}\n`);
