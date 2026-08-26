#!/usr/bin/env node
// lint-itest-rejects.mjs — the `expect(...).rejects` tripwire for integration tests.
//
// CLAUDE.md states the rule: "Never assert a rejected DB call with `expect(...).rejects`. A promise holding a
// pooled connection can be left unsettled, and the symptom is a HANG — of that assertion AND of every later
// query in the file, since the itest pools are `max: 1`." `activitiesPartitioned.itest.ts` documents the same
// thing at its own call site. It had already bitten partitionMaintenance, contactMerge and tags.
//
// It kept biting anyway. Running the suites doc 16 lists as CI-owed turned up FOUR more live instances —
// retention (540s), scheduledImports (240s), bulkImport.pipeline (120s, surfacing as `write CONNECTION_ENDED`)
// and enrichmentPolicy (240s) — every one of them a stall rather than a failure. That is why the rule needed
// to stop being advice: a hang is not a red. Nobody reads a green-but-slow suite, CI just gets more expensive,
// and the eventual error (a driver-level connection message) points away from the cause.
//
// So: `.rejects` in an `*.itest.ts` is an error here. The escape hatch is a comment on the preceding line —
//   // itest-rejects-ok: <why this promise cannot hold a pooled connection>
// — because the ban is on the shape being used *unthinkingly*, not on the operator existing. A non-DB promise
// is fine; saying so in one line is the whole cost.
//
// The replacement shape is the house `.then`-capture (activitiesPartitioned.itest.ts:236 and every suite this
// sweep converted):
//
//   const err = await doTheThing().then(
//     () => "",
//     (e) => (e instanceof Error ? e.message : String(e)),
//   );
//   expect(err).toMatch(/expected/);
//
// Run: `node scripts/lint-itest-rejects.mjs` (wired as `bun run lint:itest-rejects`). Exit 0 = clean.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where integration tests live. Relative to repo root (cwd when run via the npm script). */
const ROOTS = ["packages", "apps"];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);

/** The opt-out, which must sit on the line immediately above the offending one. */
const ALLOW = /itest-rejects-ok:/;

function itestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) itestFiles(full, out);
    else if (entry.endsWith(".itest.ts")) out.push(full);
  }
  return out;
}

const offenders = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of itestFiles(root)) {
    scanned += 1;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      // Only the assertion form. A comment ABOUT `.rejects` — several suites explain why they avoid it — is
      // not a use of it, and flagging those would train people to delete the explanation.
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
      if (!/\)\s*\.rejects\b/.test(line) && !/^\s*\)\.rejects\b/.test(line)) return;
      if (ALLOW.test(lines[index - 1] ?? "")) return;
      offenders.push(`${file.replace(/\\/g, "/")}:${index + 1}: ${trimmed}`);
    });
  }
}

if (offenders.length === 0) {
  process.stdout.write(`ok   no expect(...).rejects in ${scanned} itest files\n`);
  process.exit(0);
}

process.stdout.write(
  `expect(...).rejects found in ${offenders.length} place(s) across ${scanned} itest files.

A rejecting DB call handed to .rejects can be left unsettled on the single pooled connection, and the
symptom is a HANG rather than a failure — the suite eats its timeout and the eventual error points at
the driver, not at the test. Use the .then-capture form instead:

  const err = await doTheThing().then(
    () => "",
    (e) => (e instanceof Error ? e.message : String(e)),
  );
  expect(err).toMatch(/expected/);

If the promise genuinely cannot hold a pooled connection, say so on the line above:
  // itest-rejects-ok: <reason>

${offenders.join("\n")}
`,
);
process.exit(1);
