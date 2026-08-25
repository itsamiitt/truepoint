#!/usr/bin/env node
// lint-batch-insert-bounds.mjs — a multi-row INSERT must be bounded by the bind-parameter ceiling.
//
// PostgreSQL addresses bind parameters with a 16-bit count, so ONE statement carries at most 65,534 of them
// (postgres.js throws MAX_PARAMETERS_EXCEEDED). Drizzle emits one statement for `.values(array)`, binding a
// parameter per present key per row — so a multi-row insert has a hard row ceiling of 65534/keysPerRow, and it
// is low enough to matter: a contact binds ~19 keys, capping a statement near 3,400 rows while the bulk
// importer plans bands of 10,000.
//
// THIS EXISTS BECAUSE SIX CALL SITES HAD IT WRONG AT ONCE — contacts, source_imports, import_job_rows,
// enrichment_job_rows, list_members and provenance_event. Every bulk import of a chunk with more than ~3,400
// new contacts threw. Nobody had hit it because bulk import ships dark behind BULK_IMPORT_ENABLED, and the
// soak suite written to catch it had never executed (it gates on NIGHTLY_SOAK, which no workflow set).
//
// Fixing six and moving on would leave the seventh to be written next week. The rule is mechanical, so it can
// be checked: any `.values(x)` where `x` is not an object literal is a multi-row insert and must go through
// `sliceForBindLimit` (packages/db/src/repositories/bindLimit.ts), which derives the slice width from the
// widest row rather than a hardcoded count.
//
// Single-row inserts — `.values({ … })`, the object-literal form — are exempt and are the common case.
//
// Escape hatch, within three lines above:
//   // batch-insert-bounds-ok: <why this batch is provably small>
//
// Run: `node scripts/lint-batch-insert-bounds.mjs` (wired as `bun run lint:batch-inserts`). Exit 0 = clean.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = "packages/db/src";
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".turbo"]);

/** The bounding helper any multi-row insert must route through. */
const HELPER = "sliceForBindLimit";

const ALLOW = /batch-insert-bounds-ok:/;

/**
 * `.values(` whose first non-whitespace argument character is captured, so the single-row object-literal form
 * can be told apart from an array.
 *
 * Written as an explicit capture rather than a negative lookahead: `\.values\(\s*(?!\{)` looks right and is
 * useless, because `\s*` backtracks to zero width and the lookahead then passes on the newline of every
 * multi-line object literal. That version reported 40 sites, nearly all of them single-row inserts.
 */
const VALUES_ARG = /\.values\(\s*([^\s])/g;

/** An identifier passed to `.values()` is only a batch if it was BUILT as one — `.map(...)`, an array literal,
 *  or an array-typed parameter. Anything else is the single-object form (`const values = { … }`), which is the
 *  common case and is not a batch at all. */
function isArrayBinding(region, name) {
  const decl = new RegExp(
    `(?:const|let)\\s+${name}\\s*(?::[^=]+)?=\\s*([\\s\\S]{0,80})|\\b${name}\\s*:\\s*(?:readonly\\s+)?[A-Za-z<>{}\\[\\], |]*\\[\\]`,
  ).exec(region);
  if (!decl) return false;
  if (decl[1] === undefined) return true; // matched the array-typed parameter branch
  return /^\[|\.map\(|\.flatMap\(|\.filter\(|\.slice\(/.test(decl[1].trim());
}

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
    else if (entry.endsWith(".ts") && !entry.includes(".test.") && !entry.includes(".itest.")) {
      out.push(full);
    }
  }
  return out;
}

const offenders = [];
let scanned = 0;
let bounded = 0;

for (const file of sourceFiles(ROOT)) {
  scanned += 1;
  const raw = readFileSync(file, "utf8");
  if (!raw.includes(".values(")) continue;

  // Blank comments space-for-space so line numbers survive — a `.values(array)` inside a doc comment is prose,
  // not a statement, and bindLimit.ts's own header describes the very pattern this scans for.
  // `[^\S\r\n]*` — horizontal whitespace ONLY. `^\s*//` looks equivalent and is not: `\s` matches newlines,
  // so in multiline mode it swallows the blank lines above a comment and the replacement deletes them. That
  // silently shifted every reported line number after the first comment block (measured: 698 newlines became
  // 609 in one file, so a call on line 227 was reported as 187 — and the escape-hatch lookback, which reads
  // the ORIGINAL lines, then searched the wrong region entirely).
  const text = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[^\S\r\n]*\/\/.*$/gm, (m) => " ".repeat(m.length));

  const lines = raw.split(/\r?\n/);
  for (const match of text.matchAll(VALUES_ARG)) {
    const first = match[1];
    if (first === "{") continue; // single-row object literal — the common case, not a batch
    // `.values()` with no argument is a Map/Object iterator, not a Drizzle insert. `deduped.values()` and
    // `unique.values()` both read as batches to a text scan and are nothing of the kind.
    if (first === ")") continue;

    const line = text.slice(0, match.index).split("\n").length;

    // An inline projection is unambiguous — `.values(rows.map(…))` is a batch whatever `rows` is typed as.
    // Checked FIRST because the binding heuristic below missed exactly this: revealJobRepository types its
    // parameter `Array<{ … }>` rather than `X[]`, so a declaration-shape test alone let a real batch through.
    const ahead = text.slice(match.index, match.index + 160);
    const inlineProjection = /\.(?:map|flatMap)\(/.test(ahead);

    if (!inlineProjection && /[A-Za-z_$]/.test(first ?? "")) {
      const name = /\.values\(\s*([A-Za-z_$][\w$]*)/.exec(text.slice(match.index))?.[1];
      const scope = lines.slice(Math.max(0, line - 40), line).join("\n");
      if (name && !isArrayBinding(scope, name)) continue;
    }

    // The helper is applied at the loop that wraps the insert, which can sit a few lines above the .values(
    // call, so look at the enclosing region rather than the single line. Generous on purpose: this check is
    // about "did anyone think about the ceiling here", not about a precise dataflow proof.
    //
    // IMPORT LINES ARE EXCLUDED FROM THAT WINDOW, and they have to be. `import { sliceForBindLimit } from
    // "./bindLimit.ts"` mentions the helper without applying it, and in a SHORT file the import block sits
    // within twelve lines of everything — so any file that bounded one insert silently exempted every other
    // insert near its imports. Demonstrated before this line was written: a repository whose only mention of
    // the helper was its import, with a plain `.values(rows.map(…))` beneath it, was counted as bounded and
    // the run exited 0. All eleven genuinely-bounded sites in this repo carry a NON-import mention in their
    // window, so excluding imports keeps every one of them and closes the hole.
    const from = Math.max(0, line - 12);
    const region = lines
      .slice(from, line + 4)
      .filter((l) => !/^\s*import\b/.test(l))
      .join("\n");
    if (region.includes(HELPER)) {
      bounded += 1;
      continue;
    }
    // Same window as the helper check above, and for the same reason: the declaration sits with the
    // statement's opening lines, not necessarily on the line before `.values(`. A four-line lookback was too
    // tight and reported a site whose reason was written five lines up.
    if (region.split("\n").some((l) => ALLOW.test(l))) continue;

    offenders.push(`${file.split(sep).join("/")}:${line}`);
  }
}

if (offenders.length === 0) {
  process.stdout.write(
    `ok   ${scanned} files, ${bounded} multi-row insert(s) all bounded by ${HELPER}\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `${offenders.length} unbounded multi-row INSERT(s):

${offenders.join("\n")}

Drizzle emits ONE statement for .values(array), and PostgreSQL caps a statement at 65,534 bind parameters —
so a batch insert has a row ceiling of 65534/keysPerRow (~3,400 for a contact). Six call sites exceeded it at
the bulk importer's own chunk size, and every one of them threw MAX_PARAMETERS_EXCEEDED in production shape.

Route the rows through sliceForBindLimit (packages/db/src/repositories/bindLimit.ts) and insert per slice on
the same tx — atomicity is unchanged and order is preserved, so result[i] still matches rows[i].

If the batch is provably small (a fixed handful, not a user- or chunk-sized list), say why:
  // batch-insert-bounds-ok: <reason>
`,
);
process.exit(1);
