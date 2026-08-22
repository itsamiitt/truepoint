#!/usr/bin/env node
// lint-cross-feature-imports.mjs — feature slices must not import each other, checked on the ALIAS form.
//
// dependency-cruiser already has a `no-cross-feature-import` rule, it is listed in that config's
// "VERIFIED TO FIRE" ledger, and it is blind to every violation in this repo. This script exists because of
// how that happened, which is worth understanding before changing either check.
//
// The cruise runs `depcruise apps packages` from the repo root with no per-app tsconfig, so the `@/*` path
// mapping in each app's tsconfig is never loaded. Measured 2026-08-22 on apps/web: **251 `@/` imports
// unresolved, 0 resolved.** An unresolved dependency keeps its bare specifier as the `resolved` value, so a
// rule matching on `^apps/web/src/features/` can never see it. The rule fires perfectly for
// `../../sequences/api` and never for `@/features/sequences` — and this codebase writes the alias form
// everywhere, so the rule's coverage of real code is zero.
//
// It was verified with a relative import, which is the honest way to test most rules in that config (a bare
// workspace specifier proves nothing when the dependency is undeclared — see the note in
// .dependency-cruiser.cjs). Here the same method hid the problem instead of exposing it. A guard has to be
// tested with the spelling the codebase actually uses, not the spelling that is convenient to plant.
//
// FIXING THE CRUISE PROPERLY means running it per-app with that app's tsconfig so the alias resolves, which
// means per-app rule paths too — a re-engineering of `lint:boundaries`, not a one-line change. This closes
// the hole now, by regex, on the exact text of the import specifier. No resolver, nothing to misconfigure.
//
// WHAT IT FOUND, and why this ships as a ratchet rather than a wall: apps/web has **9** cross-feature imports
// today (accounts→prospect ×5, accounts→signals, lists→prospect, search→prospect, home→api-usage). Whether
// those get refactored — shared code moves to `shared/`, or `prospect` is acknowledged as a base other
// destinations may build on — is an architecture decision (truepoint-architecture), not something to settle
// by deleting imports. Every other app is already at zero and is held there.
//
// Run: `node scripts/lint-cross-feature-imports.mjs` (wired as `bun run lint:cross-feature`). Exit 0 = clean.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/** Per-app budgets. apps/web is a ledger of known imports; every other app is a wall at zero. */
const BUDGETS = {
  "apps/web": 9,
  "apps/admin": 0,
  "apps/auth": 0,
  "apps/forge": 0,
  "apps/doc": 0,
};

/** `from "@/features/<slug>"` — the alias form, which is what the cruiser cannot see. */
const CROSS_FEATURE = /from\s+"@\/features\/([a-z0-9-]+)/g;

function sourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an app without a features/ tree is not a failure
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

/** Every import where the importing file's own feature differs from the imported one. */
function violations(app) {
  const found = [];
  for (const file of sourceFiles(join(app, "src", "features"))) {
    const parts = file.split(sep);
    const owner = parts[parts.indexOf("features") + 1];
    for (const match of readFileSync(file, "utf8").matchAll(CROSS_FEATURE)) {
      if (match[1] !== owner) {
        found.push(`${file.split(sep).join("/")} → @/features/${match[1]}`);
      }
    }
  }
  return found;
}

const over = [];
const lines = [];
let total = 0;

for (const [app, budget] of Object.entries(BUDGETS)) {
  const found = violations(app);
  total += found.length;
  if (found.length > budget) over.push({ app, budget, found });
  else if (found.length < budget) {
    lines.push(`  ${app}: ${found.length} (budget ${budget}) — TIGHTEN the budget in this script`);
  }
}

if (over.length === 0 && lines.length === 0) {
  process.stdout.write(`ok   cross-feature imports within budget (${total} total, all declared)\n`);
  process.exit(0);
}

if (lines.length > 0 && over.length === 0) {
  process.stdout.write(
    `Cross-feature imports went DOWN — good, now make it stick:

${lines.join("\n")}

A ratchet nobody tightens stops being a ratchet.
`,
  );
  process.exit(1);
}

process.stdout.write(
  `${over.length} app(s) over budget for cross-feature imports:

${over
  .map(
    ({ app, budget, found }) =>
      `${app}: ${found.length} (budget ${budget})\n${found.map((f) => `  ${f}`).join("\n")}`,
  )
  .join("\n\n")}

A feature slice importing another couples two destinations that are meant to ship independently. Put the
shared piece in the app's shared/ tree, or lift it into @leadwolf/ui if it is presentational.

Note that dependency-cruiser's no-cross-feature-import rule will NOT flag this: the cruise runs without the
per-app tsconfig, so the "@/" alias never resolves and the rule cannot see the edge. That is why this check
exists — see the header.
`,
);
process.exit(1);
