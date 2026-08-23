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

/**
 * Findings already investigated, with the verdict.
 *
 * Without this the audit is a treadmill: every run re-lists things somebody already traced to a conclusion,
 * and the reader cannot tell "nobody has looked at this" from "somebody looked and it is fine". That is the
 * same failure as a lint rule nobody trusts — noise trains you to skim, and the one real finding goes past
 * with the rest.
 *
 * A key is either an exact `objectRepository.method` or a `prefix*` wildcard. Adding an entry is a claim that
 * somebody CHECKED, so each carries its reason; "looks unused" is not a verdict.
 */
const ADJUDICATED = [
  {
    match: "oauthConnectStateRepository.sweepExpired",
    verdict:
      "not a bug — oauth_connect_state has no writer outside tests; the mailbox OAuth handshake it reaps for does not run. A sweep here could only ever delete zero rows.",
  },
  {
    match: "userRepository.markEmailVerified",
    verdict:
      "vestigial — email_verified_at is set at CREATION in both create() call sites (registration proves the address first; SSO's IdP vouches for it), and there is no change-email flow, so nothing verifies an address after the fact.",
  },
  {
    match: "retentionClassPolicyRepository.getPolicy",
    verdict:
      "redundant accessor — the retention sweep and the admin routes both read the whole set via listPolicies; nothing wants one policy by id.",
  },
  {
    match: "erRepository.confirmMerge",
    verdict:
      "the subject of prospect-database-platform I4, whose exit gate is already recorded as unmeetable. Wiring it opportunistically is exactly what that brief says not to do.",
  },
  {
    match: "crm*",
    verdict:
      "the CRM connector module is dark behind CRM_SYNC_ENABLED (9 tables). Uncalled methods are the expected state of an unshipped module, not rot.",
  },
  {
    match: "contributionPolicyRepository.*",
    verdict: "same dark CRM module — contribution policy is the CRM-object half of it.",
  },
];

/** Exact match, or `prefix*`. */
function adjudicationFor(symbol) {
  for (const entry of ADJUDICATED) {
    if (entry.match.endsWith("*")) {
      if (symbol.startsWith(entry.match.slice(0, -1))) return entry;
    } else if (symbol === entry.match) {
      return entry;
    }
  }
  return null;
}

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

      // A method called by a SIBLING method in the same file is reachable, and skipping the defining file
      // outright reported it as dead. sendQuotaRepository.resetPeriod is the live example: it is invoked by
      // lock() a few lines above, and this audit still listed it. The QUALIFIED form is what makes this safe
      // to check inside the definition — `sendQuotaRepository.resetPeriod(` can only be a call, whereas the
      // bare `.resetPeriod(` would also match nothing useful and the declaration `async resetPeriod(` is a
      // different shape again.
      if (text.includes(`${call}(`)) continue;

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

const settled = [];
const open = [];
for (const f of findings) {
  const entry = adjudicationFor(f.symbol);
  if (entry) settled.push({ ...f, verdict: entry.verdict });
  else open.push(f);
}

const tested = open.filter((f) => f.tests > 0);
const untested = open.filter((f) => f.tests === 0);

process.stdout.write(
  `${methodCount} repository methods scanned across ${repoFiles.length} files\n`,
);
process.stdout.write(
  `${findings.length} with no non-test caller: ${open.length} OPEN, ${settled.length} already adjudicated\n\n`,
);
process.stdout.write(
  `— TESTED BUT NEVER CALLED (${tested.length}) — built, proven, unreachable:\n`,
);
for (const f of tested)
  process.stdout.write(`  ${f.symbol}  (${f.tests} test file(s))  ${f.file}\n`);
process.stdout.write(`\n— NEITHER CALLED NOR TESTED (${untested.length}):\n`);
for (const f of untested) process.stdout.write(`  ${f.symbol}  ${f.file}\n`);

// Printed, not hidden. An adjudication is a judgement someone made on a date, and the code moves underneath
// it — showing the verdicts is what lets a reader notice one has gone stale.
process.stdout.write(`\n— ADJUDICATED (${settled.length}) — checked, and the reason:\n`);
for (const f of settled) process.stdout.write(`  ${f.symbol}\n      ${f.verdict}\n`);

// An adjudication for a symbol that no longer turns up is either a fixed finding or a renamed method, and
// either way the entry is now lying about the state of the code. Reported rather than enforced: this is an
// audit, and the right response is usually "delete the stale line", not "fail the build".
const seen = new Set(findings.map((f) => f.symbol));
const stale = ADJUDICATED.filter((e) => !e.match.endsWith("*") && !seen.has(e.match)).map(
  (e) => e.match,
);
if (stale.length > 0) {
  process.stdout.write(
    `\n— STALE ADJUDICATIONS (${stale.length}) — these no longer appear as findings; the method was fixed,\n` +
      `  renamed, or deleted, so the entry should go:\n${stale.map((s) => `  ${s}\n`).join("")}`,
  );
}
