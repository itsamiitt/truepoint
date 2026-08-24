// Find repository METHODS that nothing outside their own file and tests ever calls.
//
// Not a lint. An audit: "built, tested, and never called" is a real class here (I4's confirmMerge), and a
// method nobody calls delivers zero outcome while reading as done in every review and status doc.
//
// Method-level, not module-level, because the repository objects themselves are all imported somewhere — the
// dark part is always a method hanging off a live object.
//
// ── WHAT A FINDING HERE DOES *NOT* MEAN ────────────────────────────────────────────────────────────────────
// This answers exactly one question: does this SYMBOL have a caller? It cannot answer "is this CAPABILITY
// missing", and on 2026-08-24 two findings were written up as though it could. Both were wrong, both in the
// same direction, and both were caught only by asking a second question this script never asks:
//
//   WHAT ELSE WRITES THIS TABLE, OR SERVES THIS NEED, UNDER A DIFFERENT NAME?
//
//   • `governance.addGlobalSuppression` has no caller — true. It was written up as "staff cannot suppress an
//     individual address". False: `dsarFanoutRepository.addGlobalSuppression` writes exactly that row under a
//     different name, and two compliance flows call it daily. The real gap was narrower — no STAFF-initiated
//     address suppression — and a fix aimed at the wrong claim would have missed it.
//   • The `provenance_events` tenant flag is read by nothing — true. It was written up as a broken dual gate.
//     False: it gates OVERLAY events, no overlay writer exists yet, and migration 0088 states that Layer-0
//     events ride the env half alone. It is seeded AHEAD of its consumer, deliberately.
//
// So treat every row below as a LEAD. Before concluding that anything is missing: grep the TABLE, grep the
// COLUMN, and read the nearest migration's prose — this codebase routinely lands a writer ahead of its caller
// and says so at the definition. The ADJUDICATED register exists so that judgement, once made, is recorded
// rather than re-derived.

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
    match: "masterJobPostingsRepository.upsertPosting",
    verdict:
      "writer deliberately ahead of its producer — the file says so: hiring-intelligence evidence (0127, MI-S1) whose feed is D-6 procurement. When the feed lands, ingest is wiring rather than schema work.",
  },
  {
    match: "accountChildRepository.setParentAccount",
    verdict:
      "guard deliberately ahead of its verb — the file says so: 'NO API verb ships in this task'; the PATCH /accounts/:id parent verb rides doc 04/11's account UI slice. Method + tests first, tracked as a drift row.",
  },
  {
    match: "effectivePolicyRepository.backfillTenantPolicies",
    verdict:
      "invoked by a deploy step, not app code (auth tracker 1.1b-backfill), and it is the prerequisite of the 1.1b-cutover flip, which is explicitly gated on 'backfill applied, no drift'. Correctly sequenced, not stranded.",
  },
  {
    match: "masterPersonDerivedRepository.backfillEmploymentDatesTx",
    verdict:
      "migration 0136 performs this backfill in SQL as one statement; the bounded version exists for a re-run after a bulk landing, where a whole-table UPDATE would be a lock and a WAL spike rather than a task.",
  },
  {
    match: "erRepository.listPersonsMissingBlockKey",
    verdict:
      "superseded — erSweep folds the populate into its own cursor scan (setBlockKey per keyless seed) because 'a separate backfill would re-scan the same table to do strictly less'. Kept as the entry point if the populate is ever separated again; must not become a second writer.",
  },
  {
    match: "providerCallRepository.spendSinceByProvider",
    verdict:
      "unused refinement, not a broken brake — the aggregate spendSince IS the daily spend guard, called by enrichContact, enrichContactV2 and refreshAccount. Only the per-provider breakdown has no consumer.",
  },
  {
    match: "authAllowedOriginsRepository.*",
    verdict:
      "blocked on a design decision, not neglect — AUTH-036 cannot be wired as its tracker describes: three of the four redirect call sites have no tenant at check time, and the fourth is gated by a CORS preflight that carries no credentials. Written up in docs/planning/auth-platform/MANAGED_ORIGINS_BLOCKER.md and recorded as decisions.md #7. There is nowhere correct to call these from yet.",
  },
  {
    match: "revealJobRepository.requeueFailedRows",
    verdict:
      "unexposed, and not casually exposable. Bulk reveal is a confirm-before-spend money path; re-queuing rows in place would re-enter spend without a fresh confirmation. The shipped job-control surface (cancelAndRelease, pauseRunning, resumePaused, listFailedContactIds) instead LISTS failed contacts so a new, confirmed job can be submitted. Wiring an in-place retry is a spend-path product decision.",
  },
  {
    match: "mailboxRepository.markError",
    verdict:
      "the durable failure IS recorded — markReauthRequired has callers and is the state that needs surfacing. markError would flip status to a generic 'error' on a transient provider blip, and its CRM sibling documents exactly why that is undesirable. Whether transient failures should be visible at all is an ops question, not a missing call.",
  },
  {
    match: "providerConfigRepository.listEnabled",
    verdict:
      "superseded by the sibling list(), which selects the enabled column and lets callers filter. Enablement is default-true column semantics, so a pre-filtered variant saves nothing a caller does not already have.",
  },
  {
    match: "sessionRepository.findActiveById",
    verdict:
      "sessions are never looked up by id. Every path resolves one by findByRefreshTokenHash on the hashed lw_refresh cookie, which is the design: a merely-present cookie must never count as a valid session. A by-id lookup has no caller because it has no legitimate caller.",
  },
  {
    match: "featureFlagRepository.overridesForFlag",
    verdict:
      "the shipped admin surfaces read overrides per TENANT (overridesForTenant, overrideFor) or all at once (allOverrides). A per-FLAG view of which tenants override it is not a screen that exists.",
  },
  {
    match: "consentRepository.listForContact",
    verdict:
      "no per-contact consent HISTORY surface exists. The DSAR access report deliberately reports a footprint COUNT (assembleAccessReport's consentRecords is a number, from its own query), and contactMergeRepository counts rows the same way. Whether an access report should carry full consent detail is a legal/product question, not a missing call.",
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
