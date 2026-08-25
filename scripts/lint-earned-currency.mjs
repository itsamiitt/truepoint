#!/usr/bin/env node
// lint-earned-currency.mjs — rule 7, across the whole product rather than one app.
//
// CLAUDE.md rule 7: "No contributor-EARNED currency exists anywhere — no points, no bounties, no rewards a
// contribution can accrue; never implement one." decisions.md records why it is phrased that strongly: the
// strategy pack DELETED a credit/bounty reward economy outright (MONETIZATION PIVOT), and with nothing
// farmable, A-03 shrinks from economic fraud to data-quality fraud. That property is load-bearing.
//
// THIS IS NOT A HYPOTHETICAL RULE. apps/doc already carries a copy guard, and its own comment says why: "The
// brief behind this portal PROPOSES REVIVING IT." A rejected idea that keeps arriving in new briefs is the
// kind that eventually ships, and it will not arrive labelled as a reward economy — it will arrive as a
// helpful line on a Community-tier page about what contributors earn.
//
// WHAT THIS ADDS. The existing guard covers apps/doc's content modules and its rendered HTML. Nothing covered
// the other four apps, packages/ui, or the server. Measured 2026-08-25 before writing it: across every .ts
// and .tsx in apps/ and packages/, the ONLY matches were the guards themselves and one comment in
// apps/doc/src/content/pricing.ts. The product is clean; this keeps it that way as the contributor surfaces
// get built, which is exactly when the copy will be written.
//
// The patterns are the portal's, deliberately unchanged, so one rule is not enforced two different ways:
//   earn <n> credits · credits for contributing · bounty · reward points
// Plus the schema/identifier shapes the copy patterns cannot see — `points_balance`, `pointsEarned`,
// `awardPoints` — because rule 7 forbids the MECHANISM, not merely the marketing.
//
// A settlement CREDIT is not a reward and is not matched: the shipped credit ledger is a PURCHASED unit
// (decisions.md 2026-07-31 amendment), so "credits" alone is fine and only EARNING them is not. That
// distinction is the whole reason the patterns are narrow rather than a blanket ban on the word.
//
// Escape hatch, on the line or the one above it:
//   // earned-currency-ok: <why this mentions the rejected economy without implying it>
// The files that DEFINE these patterns need it, which is why it exists: a scanner that flags its own guard is
// a scanner people delete.
//
// Run: `node scripts/lint-earned-currency.mjs` (wired as `bun run lint:earned-currency`).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
const SOURCE = /\.(ts|tsx|sql)$/;

/** Copy shapes — identical to apps/doc's FORBIDDEN list, on purpose. */
const COPY = [
  { re: /earn\s+\w*\s*credits?/i, why: "contributor-earned credits (rule 7)" },
  { re: /credits?\s+for\s+(?:each\s+)?contribut/i, why: "credits for contributing (rule 7)" },
  { re: /\bbount(?:y|ies)\b/i, why: "bounty currency (rule 7)" },
  { re: /reward\s+points?/i, why: "reward points (rule 7)" },
];

/** Mechanism shapes — a schema column or a function name that implements an accruing balance. */
const MECHANISM = [
  { re: /\bpoints?_(?:balance|earned|awarded)\b/i, why: "an accruing points balance (rule 7)" },
  { re: /\bpoints(?:Balance|Earned|Awarded)\b/, why: "an accruing points balance (rule 7)" },
  { re: /\baward(?:ed)?[_ ]?points?\b/i, why: "awarding points (rule 7)" },
];

const ALLOW = /earned-currency-ok:/;

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
    else if (SOURCE.test(entry)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => sourceFiles(r));
const offenders = [];
let scanned = 0;

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  scanned += 1;
  if (!/earn|bount|point|reward/i.test(raw)) continue; // cheap pre-filter
  const lines = raw.split(/\r?\n/);
  // A FILE-level exemption in the header, for the files that legitimately enumerate these patterns: the
  // portal's own copy guards define them as regexes and would otherwise be reported by a scanner they exist
  // to complement. Six scattered line markers would say the same thing six times and read as noise; one
  // header note states the reason once. This is the same trade lint:secrets faced with its AWS-key fixture
  // and answered differently — there the value could be ASSEMBLED at runtime to keep the scanner strict,
  // which is better where it is possible. A regex definition cannot be assembled without becoming unreadable.
  if (lines.slice(0, 40).some((l) => ALLOW.test(l))) continue;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // The line itself or the one above may carry the exemption — a directive usually sits above what it
    // exempts, and a long line is often exempted inline.
    if (ALLOW.test(line) || (i > 0 && ALLOW.test(lines[i - 1]))) continue;
    for (const { re, why } of [...COPY, ...MECHANISM]) {
      if (!re.test(line)) continue;
      offenders.push(
        `${file.split(sep).join("/")}:${i + 1}  ${why}\n      ${line.trim().slice(0, 110)}`,
      );
      break;
    }
  }
}

if (offenders.length === 0) {
  process.stdout.write(`ok   ${scanned} source files, no contributor-earned currency\n`);
  process.exit(0);
}

process.stdout.write(
  `${offenders.length} reference(s) to a contributor-earned currency:\n${offenders
    .map((o) => `  ${o}`)
    .join(
      "\n",
    )}\n\nCLAUDE.md rule 7: "No contributor-EARNED currency exists anywhere — no points, no bounties, no rewards a\ncontribution can accrue; never implement one." The strategy pack deleted that economy outright, and A-03\ndepends on there being nothing to farm.\n\nA PURCHASED credit is fine — the shipped ledger is a settlement unit, not a reward. What is forbidden is a\ncontribution ACCRUING one. If a line names the rejected economy without implying it, say so:\n  // earned-currency-ok: <why>\n`,
);
process.exit(1);
