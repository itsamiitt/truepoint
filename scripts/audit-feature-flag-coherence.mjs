#!/usr/bin/env node
// audit-feature-flag-coherence.mjs — do the flags the CODE gates on and the flags a MIGRATION defines agree?
//
// `evaluateFlagForTenant` documents its own posture: "Unknown flag → off (fail closed)". That is the right
// default and it is also what makes a typo invisible. A gate on `"bulk_imports_enabled"` when the seeded key
// is `"bulk_import_enabled"` does not throw, does not warn, and does not appear in the admin flag list — it
// simply returns false for ever, and the feature it guards is dark with no way to turn it on. An operator
// following an enablement runbook would flip the flag they can see, observe no change, and have nothing to
// look at.
//
// The reverse is the other half: a flag DEFINED in a migration but checked by no code is a switch in the
// admin UI that gates nothing. Someone toggles it, believes a capability is live, and nothing happens.
//
// One direction is clean (every key the code gates on IS defined). The other reports two keys defined and
// gated by nothing — but only ONE of them is a defect, and this script cannot tell them apart:
//   • usage_events    — a real gap. All four emitters gate on the env switch alone, though usage_event rows
//                       carry tenant and workspace and 0088 calls the flag a per-tenant rollout gate.
//   • provenance_events — NOT a gap. It gates OVERLAY events (contact|account) and no overlay writer exists
//                       yet; every provenance_event writer today is Layer-0, which 0088 says rides the env
//                       half alone. Seeded ahead of its consumer, deliberately.
// A key with no gate is therefore a QUESTION, not a verdict — which is one more reason this stays an audit
// rather than a gate. See decisions.md #9.
//
// This exists because the check was previously a thing somebody ran by hand, and that hand-run got it WRONG in
// the permissive direction: it asked only whether each flag key appeared somewhere in the source, and both of
// those keys do appear — as `flagKey:` metadata in the admin routes' dual-gate listing. Appearing in a
// description is not being gated on. The rule is that the key the CODE GATES ON and the key a MIGRATION
// DEFINES have to be the same string, and only the two narrow patterns above count as gating.
//
// Escape hatch, on the line above the declaration or in the file header:
//   // feature-flag-ok: <why this key needs no counterpart>
//
// AN AUDIT, NOT A GATE — it always exits 0. It ships with two OPEN findings that need a human decision (see
// docs/strategy/decisions.md #9), and a gate that is red on arrival gets disabled rather than fixed. Promote
// it to `lint:*` the moment those two are resolved: the check itself is cheap and the failure it catches is
// silent.
//
// Those two are held in the KNOWN register below and reported APART from anything new, because a report whose
// output never changes stops being read — and the reader who has learned to skim two familiar lines is the one
// who will skim the third. "No NEW finding" is the healthy state; the register is what makes that sentence
// mean something. It also self-expires: a key that stops being a finding is announced as RESOLVED with an
// instruction to delete it, so the register cannot quietly outlive the decision it stands in for.
//
// Run: `node scripts/audit-feature-flag-coherence.mjs` (wired as `bun run audit:feature-flags`).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const CODE_ROOTS = ["apps", "packages"];
const MIGRATION_DIR = "packages/db/src/migrations";
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);

/** `export const X_FLAG_KEY = "some_key"` — how every gate names its flag. */
const FLAG_CONST = /_FLAG_KEY\s*=\s*"([a-z0-9_.]+)"/g;
/** A literal passed straight to a gate helper, rather than through a constant. */
const FLAG_LITERAL = /(?:isFlagEnabledForTenant|evaluateFlagForTenant)\([^)]*?"([a-z0-9_.]+)"/g;

const ALLOW = /feature-flag-ok:/;

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
    else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

// ── What the CODE gates on ─────────────────────────────────────────────────────────────────────────────────
const used = new Map(); // key → first file that names it
const exempt = new Set();
for (const root of CODE_ROOTS) {
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("_FLAG_KEY") && !text.includes("FlagEnabledForTenant")) continue;
    const posix = file.split(sep).join("/");
    for (const re of [FLAG_CONST, FLAG_LITERAL]) {
      for (const m of text.matchAll(re)) {
        if (!used.has(m[1])) used.set(m[1], posix);
        if (ALLOW.test(text)) exempt.add(m[1]);
      }
    }
  }
}

// ── What a MIGRATION defines ───────────────────────────────────────────────────────────────────────────────
// Only rows inserted INTO feature_flags count. An earlier hand-run of this check grepped every quoted string
// in any migration that merely mentioned the table, which matched unrelated literals and produced a vacuous
// "no differences" answer — the shape of a check that cannot fail.
const defined = new Map(); // key → migration file
for (const file of readdirSync(MIGRATION_DIR).filter((f) => f.endsWith(".sql"))) {
  const sql = readFileSync(join(MIGRATION_DIR, file), "utf8");
  const lower = sql.toLowerCase();
  let from = lower.indexOf("insert into feature_flags");
  while (from !== -1) {
    // The statement runs to the next `;` — VALUES tuples inside it are what define keys.
    const end = sql.indexOf(";", from);
    const stmt = sql.slice(from, end === -1 ? undefined : end);
    for (const m of stmt.matchAll(/\(\s*'([a-z0-9_.]+)'\s*,/g)) {
      if (!defined.has(m[1])) defined.set(m[1], file);
    }
    from = lower.indexOf("insert into feature_flags", from + 1);
  }
}

// Findings already triaged and awaiting a HUMAN decision, not undiscovered ones. They are listed apart
// because a report that prints the same two lines forever teaches its reader to skim — and the next reader to
// skim is the one who misses finding number three. Keep this register as small as the truth allows: an entry
// here is a promise that a human is deciding, so delete it when they do.
const KNOWN = new Map([
  [
    "usage_events",
    "decisions.md #9 — env-gated only (USAGE_EVENTS_ENABLED); the per-tenant half was seeded by 0088 with no dual gate behind it. Decision pending: add the tenant half, or drop the row.",
  ],
  [
    "provenance_events",
    "decisions.md #9 — gates OVERLAY provenance events, and no overlay writer exists yet; 0088 states Layer-0 events ride the env half alone. Seeded ahead of its consumer, deliberately.",
  ],
]);

const usedButUndefined = [...used.keys()].filter((k) => !defined.has(k) && !exempt.has(k)).sort();
const allDefinedButUnused = [...defined.keys()]
  .filter((k) => !used.has(k) && !exempt.has(k))
  .sort();
const definedButUnused = allDefinedButUnused.filter((k) => !KNOWN.has(k));
const knownPending = allDefinedButUnused.filter((k) => KNOWN.has(k));

// A key that leaves the register on its own — because someone finally gated it, or deleted the row — should
// not keep claiming a pending decision. Say so rather than carrying a stale promise.
const staleKnown = [...KNOWN.keys()].filter((k) => !allDefinedButUnused.includes(k)).sort();

if (usedButUndefined.length === 0 && definedButUnused.length === 0) {
  if (knownPending.length > 0 || staleKnown.length > 0) {
    const lines = [
      `ok   ${used.size} flag(s) gated in code, ${defined.size} defined in migrations — no NEW finding`,
    ];
    for (const k of knownPending) {
      lines.push(`     known, decision pending: ${k}`, `       ${KNOWN.get(k)}`);
    }
    for (const k of staleKnown) {
      lines.push(
        `     RESOLVED: ${k} is no longer a finding — remove it from KNOWN in this script`,
      );
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exit(0);
  }
  process.stdout.write(
    `ok   ${used.size} flag(s) gated in code, ${defined.size} defined in migrations, both directions agree\n`,
  );
  process.exit(0);
}

const parts = [];
if (usedButUndefined.length > 0) {
  parts.push(
    `${usedButUndefined.length} flag(s) the CODE gates on that NO migration defines:\n${usedButUndefined.map((k) => `  ${k}  (gated in ${used.get(k)})`).join("\n")}\n\nevaluateFlagForTenant treats an unknown flag as OFF (fail closed), so each of these is permanently
disabled and cannot be turned on: it will not appear in the admin flag list, and an operator flipping the flag
they CAN see will observe no change. Seed it in a migration, or fix the key to match the one that exists.`,
  );
}
if (definedButUnused.length > 0) {
  parts.push(
    `${definedButUnused.length} flag(s) DEFINED in a migration that no code gates on:\n${definedButUnused.map((k) => `  ${k}  (defined in ${defined.get(k)})`).join("\n")}\n\nEach is a switch in the admin UI that changes nothing. Someone will toggle it, believe a capability
is live, and be wrong. Gate something on it or remove the definition.`,
  );
}
if (knownPending.length > 0) {
  parts.push(
    `Also present, already triaged — NOT new:\n${knownPending
      .map((k) => `  ${k}  (defined in ${defined.get(k)})\n    ${KNOWN.get(k)}`)
      .join("\n")}`,
  );
}
if (staleKnown.length > 0) {
  parts.push(
    `RESOLVED since this register was written — remove from KNOWN in this script:\n${staleKnown
      .map((k) => `  ${k}`)
      .join("\n")}`,
  );
}

process.stdout.write(
  `${parts.join("\n\n")}\n\nIf a key genuinely needs no counterpart, say why:  // feature-flag-ok: <reason>\n`,
);
// Exit 0 — see the header. This REPORTS, it does not block: it ships with two open findings that are a human
// decision (decisions.md #9), and a gate that is red on arrival gets disabled rather than fixed. Flip this to
// exit(1) and rename to lint:* the moment those are resolved.
process.exit(0);
