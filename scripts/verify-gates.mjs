#!/usr/bin/env node
// verify-gates.mjs — run every cheap gate, one per line, in a form that cannot be misread.
//
// CLAUDE.md lists a dozen gate commands and they are normally run one at a time. That is how a green build
// gets reported that is not green: on 2026-08-24 three branches went red on CI for `lint/style/useTemplate`
// after `biome check --write` had been run — the safe `--write` REFUSES unsafe fixes, prints
// "Some errors were emitted while applying fixes", and changes nothing. Its output was piped through `tail`
// beside another command's output, and the other command's `ok` line was read as the formatter passing.
//
// So the design rules here are all about the READING, not the running:
//   • one line per gate, with the status first — nothing to mistake for a neighbouring command's output;
//   • a failing gate's output is printed IN FULL and never truncated, because the reason is the point;
//   • the summary states what was NOT run, so a green line is never mistaken for "everything passes";
//   • exit non-zero if anything failed.
//
// WHAT THIS DOES NOT RUN, deliberately: unit tests (`bun test`), the integration suites (`*.itest.ts`, which
// need Postgres), `bun run build` (needs a full env), and `db:migrate`. Those are minutes, not seconds, and
// CI runs them. This is the fast pre-push sweep, not a substitute for CI — which is exactly why it says so
// on the last line rather than leaving you to infer it.
//
// Run: `node scripts/verify-gates.mjs` (wired as `bun run verify`). `--with-typecheck` adds the slow one.

import { spawnSync } from "node:child_process";

const withTypecheck = process.argv.includes("--with-typecheck");

/** Every cheap gate CLAUDE.md names, in the order CI runs them. */
const GATES = [
  { name: "biome (lint + FORMAT)", cmd: ["bun", "run", "lint"] },
  { name: "import boundaries", cmd: ["bun", "run", "lint:boundaries"] },
  { name: "import-path PII in logs", cmd: ["bun", "run", "lint:import-pii"] },
  { name: "lockfile hygiene", cmd: ["bun", "run", "lint:lockfile"] },
  { name: "itest rejection shape", cmd: ["bun", "run", "lint:itest-rejects"] },
  { name: "production switch posture", cmd: ["bun", "run", "lint:prod-switches"] },
  { name: "committed secrets + PII files", cmd: ["bun", "run", "lint:secrets"] },
  { name: "roving tabindex", cmd: ["bun", "run", "lint:roving-tabindex"] },
  { name: "design tokens", cmd: ["bun", "run", "lint:design-tokens"] },
  { name: "cross-feature imports", cmd: ["bun", "run", "lint:cross-feature"] },
  { name: "alias-aware import cycles", cmd: ["bun", "run", "lint:alias-cycles"] },
  { name: "typecheck reaches every test", cmd: ["bun", "run", "lint:typecheck-coverage"] },
  { name: "required env vars in template", cmd: ["bun", "run", "lint:env-template"] },
  { name: "commits name an outcome", cmd: ["bun", "run", "lint:outcome-tags"] },
  { name: "no earned currency (rule 7)", cmd: ["bun", "run", "lint:earned-currency"] },
  { name: "architecture map is current", cmd: ["bun", "run", "lint:arch-map"] },
  { name: "batch insert bounds", cmd: ["bun", "run", "lint:batch-inserts"] },
  { name: "queue consumers", cmd: ["bun", "run", "lint:queue-consumers"] },
  { name: "gates can still fail", cmd: ["bun", "run", "lint:gates-selftest"] },
];

if (withTypecheck) {
  // The root script is `turbo run typecheck typecheck:tests`, so this DOES cover out-of-src test files —
  // the gap CLAUDE.md warns about (packages/db keeps 100+ itests outside src, and a wrong signature there once
  // passed typecheck and lint before failing in CI). The label says so, because a reader who sees bare
  // "typecheck" reasonably wonders whether tests were included and should not have to go and check.
  GATES.push({
    name: "typecheck + typecheck:tests",
    cmd: ["bun", "run", "typecheck"],
  });
}

const width = Math.max(...GATES.map((g) => g.name.length));
const failures = [];
const unavailable = [];

for (const gate of GATES) {
  process.stdout.write(`${gate.name.padEnd(width)}  … `);
  const run = spawnSync(gate.cmd[0], gate.cmd.slice(1), {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const stdout = (run.stdout ?? "").trim();
  const output = `${stdout}\n${(run.stderr ?? "").trim()}`.trim();

  if (run.status === 0) {
    // The gate's own headline. STDOUT only — `bun run` echoes `$ node scripts/…` to stderr, and reading the
    // last COMBINED line printed that echo instead of the result: a line that looks like output and means
    // nothing, which is exactly the reading this script exists to stop.
    //
    // First `ok …` line, not the LAST line. lint:queue-consumers appends a multi-line coverage note after its
    // summary, so "last line" rendered `PASS   apps/forge-worker/src/register.ts:40` — genuinely the gate's
    // output, and useless as a headline. The fallback keeps gates that do not use the `ok ` convention
    // (lint:import-pii, lint:lockfile) reporting something meaningful.
    const stdoutLines = stdout.split("\n").filter(Boolean);
    const summary =
      stdoutLines.find((l) => l.trimStart().startsWith("ok")) ?? stdoutLines.pop() ?? "";
    process.stdout.write(`PASS   ${summary.slice(0, 96)}\n`);
    continue;
  }

  // A gate that could not RUN is not a gate that failed. biome and dependency-cruiser are node_modules
  // binaries, so in a fresh worktree they are simply absent — reporting that as FAIL sends the reader hunting
  // for a defect in their diff. It still exits non-zero: an incomplete sweep must never read as a pass.
  // `Script not found` belongs here too: it means the branch predates that gate, which is a fact about the
  // checkout rather than a defect in the diff. Seen for real when this was run against a branch cut before
  // lint:queue-consumers existed.
  if (/command not found|ENOENT|is not recognized|Script not found/i.test(output)) {
    process.stdout.write("UNAVAILABLE (tool not installed)\n");
    unavailable.push({ name: gate.name, output });
    continue;
  }

  process.stdout.write("FAIL\n");
  failures.push({ name: gate.name, output });
}

if (failures.length > 0) {
  for (const failure of failures) {
    // In FULL. A truncated failure is how a real finding gets skimmed past, and this whole script exists
    // because a truncated read cost three branches.
    process.stdout.write(
      `\n${"─".repeat(100)}\n${failure.name}\n${"─".repeat(100)}\n${failure.output}\n`,
    );
  }
}

const passed = GATES.length - failures.length - unavailable.length;
process.stdout.write(`\n${passed}/${GATES.length} gate(s) passed`);
if (failures.length > 0) {
  process.stdout.write(` · FAILED: ${failures.map((f) => f.name).join(", ")}`);
}
if (unavailable.length > 0) {
  process.stdout.write(
    ` · COULD NOT RUN: ${unavailable.map((u) => u.name).join(", ")} — run \`bun install\` (these are node_modules binaries; a fresh worktree has none)`,
  );
}
process.stdout.write("\n");
process.stdout.write(
  `NOT run here: unit tests, *.itest.ts (needs Postgres), bun run build (needs env)${withTypecheck ? "" : ", typecheck (pass --with-typecheck)"} — CI runs those.\n`,
);
// The two REPORT-ONLY audits are named because this script's whole job is telling you what it did and did not
// check, and silently omitting the existence of two more checks is the same omission in miniature. They are
// not run here on purpose: both always exit 0, so folding them into a pass/fail sweep would either read as a
// PASS that proves nothing, or force a red on findings that are open questions rather than defects.
process.stdout.write(
  "Report-only audits (exit 0, run them yourself): bun run audit:feature-flags · node scripts/audit-dead-repository-methods.mjs\n",
);

// Unavailable counts as failure for the EXIT code even though it is reported separately: a sweep that could
// not run two of its checks has not verified anything, and the whole point of this script is that its result
// cannot be read as more than it is.
process.exit(failures.length + unavailable.length > 0 ? 1 : 0);
