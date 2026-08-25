#!/usr/bin/env node
// lint-typecheck-coverage.mjs — is every test file actually reached by a type-checker?
//
// `bun run typecheck` is `turbo run typecheck typecheck:tests`. A workspace that does not DEFINE a task is
// not a failure for turbo — it is nothing at all. So the coverage of the repo's type-checking is decided by
// which package.json files happen to declare which scripts, and nothing announces a workspace that declares
// neither.
//
// The rule this enforces is the one the repo already follows, just unevenly:
//   • Every tsconfig here is `"include": ["src"]`, so a test file COLOCATED in src/ is type-checked by the
//     plain `typecheck` task. Most of the repo's ~280 test files are in that position and need nothing.
//   • A test file OUTSIDE src/ — the `test/` directory convention — is outside that include, so it is checked
//     only if the workspace also has `typecheck:tests` pointing at a config that includes `test`.
//
// Measured on 2026-08-25, six workspaces keep tests outside src/ and THREE of them had no `typecheck:tests`:
// apps/forge-api (5 files), packages/forge-core (9), packages/identity (4). Eighteen files that no
// type-checker had ever read. Adding the task surfaced four real errors immediately, and one of them was the
// kind that matters: `BffReaders` gained a `sourceFetches` member for the extension-intelligence-loop and two
// test doubles were never updated, so they were constructing an object the production interface says is
// incomplete. bun test never noticed because it compiles per-file at run time and those routes were not
// exercised.
//
// That is the same failure packages/db's own tsconfig.typecheck.json was written to stop — "the itests were
// never type-checked at all … a wrong signature passed typecheck, passed lint, and failed in CI behind a
// misleading error" — which had already happened once. The fix was applied to db and workers and not to the
// rest, and there was no check to notice. This is that check.
//
// It deliberately does NOT verify that the tsconfig named by `typecheck:tests` really includes `test`: that is
// a second guess about a file's contents, and the gate that matters is whether the task exists at all. If a
// workspace points the task at a config that excludes its tests, the errors simply do not appear — a
// possibility called out here rather than silently assumed away.
//
// Run: `node scripts/lint-typecheck-coverage.mjs` (wired as `bun run lint:typecheck-coverage`).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
const IS_TEST = /\.(test|itest)\.tsx?$/;

function testFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (IS_TEST.test(entry)) out.push(full.split("\\").join("/"));
  }
  return out;
}

const offenders = [];
let workspaces = 0;
let covered = 0;

for (const root of ROOTS) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    continue;
  }
  for (const name of entries) {
    const ws = `${root}/${name}`;
    const manifest = `${ws}/package.json`;
    if (!existsSync(manifest)) continue;
    workspaces += 1;

    const outside = testFiles(ws).filter((f) => !f.startsWith(`${ws}/src/`));
    if (outside.length === 0) continue; // colocated tests ride the plain `typecheck`

    const scripts = JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {};
    if (scripts["typecheck:tests"]) {
      covered += 1;
      continue;
    }
    offenders.push({ ws, count: outside.length, sample: outside.slice(0, 3) });
  }
}

if (offenders.length === 0) {
  process.stdout.write(
    `ok   ${workspaces} workspaces · ${covered} with out-of-src tests, all declaring typecheck:tests\n`,
  );
  process.exit(0);
}

const lines = [
  `${offenders.length} workspace(s) keep test files OUTSIDE src/ with no \`typecheck:tests\` task, so nothing type-checks them:`,
];
for (const o of offenders) {
  lines.push(`  ${o.ws} — ${o.count} file(s), e.g. ${o.sample.join(", ")}`);
}
lines.push(
  "",
  'Every tsconfig here is `"include": ["src"]`, so these files are outside it, and `turbo run typecheck',
  "typecheck:tests` treats an undefined task as nothing to do rather than as a failure. The result is a file",
  "no type-checker reads — which is how a test double drifted from the interface it doubles, and how a wrong",
  "applyMigrations signature reached CI behind a misleading error.",
  "",
  "Fix: copy packages/db/tsconfig.typecheck.json (extend tsconfig.base.json, noEmit, include src + test) and",
  'add `"typecheck:tests": "tsc -p tsconfig.typecheck.json"` to the workspace. Do not add an exclude list —',
  "an exclusion is a file nobody type-checks, which is the condition this gate exists to prevent.",
);
process.stdout.write(`${lines.join("\n")}\n`);
process.exit(1);
