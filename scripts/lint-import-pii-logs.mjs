#!/usr/bin/env node
// lint-import-pii-logs.mjs — the S-S6 import-path PII-in-log tripwire (import-and-data-model-redesign 13 §3.5,
// worst-case #2). The central logging-layer redactor is UNVERIFIED (security skill data-protection.md status),
// so the import slices carry their own discipline: a structured log/console call in an import module must take
// `{jobId, workspaceId-as-id, code, counts}` shapes only — NEVER a raw row, the ledger `input`, a parsed-rows
// array, or a filename-as-typed. This grep-style check flags the obvious leak patterns (the 13 §3.5 example
// `logger.*(…row…|…input…|…file.name…)`) so a regression fails CI instead of shipping PII to a log stream.
//
// Deliberately a heuristic, review-backed tripwire (not a parser): it scans the ARGUMENTS of each log/console
// call for a small closed set of PII-value carriers. Run: `node scripts/lint-import-pii-logs.mjs` (Node ESM;
// wired as `bun run lint:import-pii`). Exit 0 = clean; exit 1 = a candidate leak (file:line printed).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The import surfaces this discipline covers (13 §3.5). Relative to repo root (cwd when run via the npm script).
const ROOTS = [
  "packages/core/src/import",
  "apps/api/src/features/import",
  "apps/workers/src/queues",
];

// A log/console/logger call opener — we then scan its single-line argument list.
const CALL = /\b(?:log|logger|console)\s*\.\s*(?:log|info|warn|error|debug|trace)\s*\(/g;

// PII-value carriers that must NEVER appear inside a log argument list. Codes/columns/ids/counts are fine;
// these name a RAW VALUE or the raw row. Kept tight to avoid false positives (e.g. "rejected-rows" — a
// message string with a hyphen — is not matched by `\.rows` / `\brows\s*:`).
const FORBIDDEN = [
  { re: /\brawData\b/, why: "raw parsed row (rawData)" },
  { re: /\.raw\b/, why: "row .raw payload" },
  { re: /\binput\b/, why: "ledger `input` (durable plaintext row)" },
  { re: /\.rows\b/, why: "parsed rows array (.rows)" },
  { re: /\brows\s*:/, why: "rows: value in a log object" },
  { re: /file\s*\.\s*name|\bfileName\b|\bfilename\b/i, why: "filename-as-typed" },
  { re: /\.body\b/, why: "request/response body" },
  { re: /\b(?:email|phone)\s*[:=]/i, why: "a channel value (email/phone)" },
];

/** Extract the argument text of a call starting at `openParenIdx` (index of the `(`), balancing parens on the
 *  same logical line span. Best-effort single-pass; good enough for the one-line structured log calls the repo
 *  uses. Returns the substring between the outer `(` and its matching `)`. */
function argsOf(src, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i += 1) {
    const c = src[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(openParenIdx + 1, i);
    }
  }
  return src.slice(openParenIdx + 1); // unbalanced (shouldn't happen) — scan the tail
}

/** Map a character offset to a 1-based line number. */
function lineAt(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

function scanFile(path) {
  const src = readFileSync(path, "utf8");
  const findings = [];
  for (const m of src.matchAll(CALL)) {
    const openParen = m.index + m[0].length - 1;
    const args = argsOf(src, openParen);
    for (const f of FORBIDDEN) {
      if (f.re.test(args)) {
        findings.push({ line: lineAt(src, m.index), why: f.why });
      }
    }
  }
  return findings;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // a root that doesn't exist yet is not a failure
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
}

const files = [];
for (const root of ROOTS) walk(root, files);

let failed = false;
for (const file of files) {
  for (const { line, why } of scanFile(file)) {
    console.error(`PII-in-log risk: ${file}:${line} — log argument references ${why}`);
    failed = true;
  }
}

if (failed) {
  console.error(
    "\nImport-path logs must carry codes/ids/counts only, never row values (13 §3.5). " +
      "Fix the flagged call or, if it is a false positive, narrow it and add a review note.",
  );
  process.exit(1);
}
console.log(`lint-import-pii-logs: clean (${files.length} import-module files scanned)`);
