#!/usr/bin/env node
// lint-arch-map.mjs — is docs/architecture-map.json still describing the tree it claims to describe?
//
// The map is the machine-readable navigation index: which files belong to which feature, which areas are
// shared, which files belong nowhere. Agents read it to find things. A stale one does not fail loudly, it
// just quietly omits whatever was added since — so a search that should have found a file returns nothing,
// and "nothing found" is indistinguishable from "does not exist".
//
// A FRESHNESS CHECK ALREADY EXISTED AND COULD NOT SEE THIS. `.claude/hooks/check-architecture-map.mjs` is a
// Claude Code STOP HOOK, wired in `.claude/settings.json`: it nudges an agent at the end of a task, on that
// agent's machine. Nothing checks the map in CI. Measured on 2026-08-25: the committed JSON was 8 files
// behind the tree (2428 vs 2436) — added by the very session whose Stop hook was supposed to catch it — and
// every CI run over those commits was green. A hook that fires in one place is not a gate.
//
// This is the CI half, and it deliberately reuses the hook's own mechanism rather than inventing a second
// one: `buildMap()` from the same lib, compared on `fileSetHash`. The hash is over the sorted source file
// set, so it is exactly "did the set of files change", never mtimes or content churn — a git checkout or a
// reinstall cannot trip it, and two runs on one tree agree byte for byte.
//
// It checks the HASH, not the whole document, on purpose. The generator is the authority on the JSON's
// shape; re-serializing it here to diff would duplicate that shape in a second place and the two would
// drift. If the file set matches, the map was generated from this tree.
//
// Run: `node scripts/lint-arch-map.mjs` (wired as `bun run lint:arch-map`). Fix: `bun run arch:map`.

import { readFileSync } from "node:fs";
import { buildMap } from "../.claude/hooks/lib/arch-map.mjs";

const MAP = "docs/architecture-map.json";

let committed;
try {
  committed = JSON.parse(readFileSync(MAP, "utf8"));
} catch (err) {
  process.stdout.write(
    `could not read ${MAP}: ${String(err?.message ?? err)}\n\nThis is UNAVAILABLE, not clean — a map that cannot be read has told you nothing about the tree.\n`,
  );
  process.exit(1);
}

const current = buildMap(process.cwd());

if (!committed.fileSetHash || !current.fileSetHash) {
  // Neither side having a hash would make the comparison below vacuously true, which is the failure shape
  // this whole directory of scripts exists to avoid.
  process.stdout.write(
    `no fileSetHash to compare (committed: ${committed.fileSetHash ?? "absent"}, current: ${current.fileSetHash ?? "absent"}).\nThe generator's output shape has changed and this check can no longer tell fresh from stale — fix the check,\ndo not delete it.\n`,
  );
  process.exit(1);
}

if (committed.fileSetHash === current.fileSetHash) {
  process.stdout.write(
    `ok   architecture map current — ${current.fileCount} files, hash matches\n`,
  );
  process.exit(0);
}

const delta = current.fileCount - (committed.fileCount ?? 0);
const direction = delta === 0 ? "changed" : delta > 0 ? `${delta} more` : `${-delta} fewer`;

process.stdout.write(
  `${MAP} is STALE — the source file set has ${direction} file(s) than the map records.\n\n  committed : ${committed.fileCount ?? "?"} files, ${committed.fileSetHash}\n  current   : ${current.fileCount} files, ${current.fileSetHash}\n\nRegenerate and commit it:  bun run arch:map\n\nThe map is how an agent finds code by feature. Stale, it omits whatever was added since — and a search that\nsilently returns nothing reads exactly like a file that does not exist.\n`,
);
process.exit(1);
