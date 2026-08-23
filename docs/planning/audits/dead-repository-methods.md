# Audit — repository methods with no caller

**Date:** 2026-08-22 · **Scope:** `packages/db/src/repositories` (152 files, 853 methods) · **Outcome:** A-01

## Why this audit exists

This codebase has a recurring shape: a method is written, given an itest, reviewed, and never called. It
reads as done in every status doc, and delivers nothing. `erRepository.confirmMerge` is the known example —
the prospect-platform I4 brief is entirely about *wiring an already-built, already-itested, uncalled*
Layer-0 merge. The question this audit asks is how many more there are.

Answer: **54 of 853 repository methods have no caller outside their own file and their tests.** (53 after the
one fix below — the audit picks up the new call site, which is the cheapest possible check that the fix is
real.)

## Method, and its known blind spots

For each `export const xRepository = { … }`, extract the method names, then search every non-test `.ts`/`.tsx`
under `apps/` and `packages/` for either the qualified `xRepository.method` or the bare `.method(`.

A method called by a SIBLING in its own file counts as reached. Skipping the defining file outright was wrong
and had a live victim: after `sendQuotaRepository.lock()` was fixed to call `resetPeriod`, the audit still
reported `resetPeriod` as dead. The check inside the defining file uses only the QUALIFIED form, which can
only be a call — the declaration `async resetPeriod(` is a different shape. Known edge: a directly recursive
method would clear itself this way. None exist here, and the alternative re-introduces a false positive on
every internal call.

The bare form is load-bearing. The first version matched only the qualified spelling and produced false
positives immediately: `apps/workers/src/outboxRelay.ts` calls `repository.markFailed(...)` where `repository`
is an injected `Pick<typeof outboxRepository, …>`, and `importReaperSweep` calls `.listReapableDrafts(` off a
chained alias. Neither line contains the literal `eventOutboxRepository.markFailed`. Requiring both spellings
cut 73 findings to 54.

Two blind spots, stated rather than discovered later:

- **Under-reports.** A same-named method on any other object masks a dead one — a live `.create(` anywhere
  clears every repository's `create`. That is the deliberate direction: every surviving finding is worth
  reading.
- **Misses destructured calls.** `const { resetPeriod } = repo; resetPeriod(…)` contains no `.resetPeriod(`.
  Rare in this codebase, but it is why each finding below is a lead, not a verdict.

Reproduce: `node scripts/audit-dead-repository-methods.mjs`. It is an audit, not a gate — it always exits 0,
because the right response to most of these is a judgement call, not a build failure.

## Acted on

**`dsarRequestRepository.findOverdue` — tested, never called. Now wired.**

Its own doc comment reads *"This is the query the breach probe runs."* No breach probe existed. What existed
was `apps/api/src/features/admin/compliance.ts`, which computes `overdue` per row when a staff user loads the
compliance page — a pull, which reports a missed statutory deadline only if somebody happens to look at a
queue that is usually empty.

Wired as `apps/workers/src/queues/dsarDeadlineSweep.ts`: leader-locked, hourly, read-only, publishing
`leadwolf_compliance_dsar_overdue` and `leadwolf_compliance_dsar_oldest_overdue_seconds`. Hourly rather than
daily because the SLA is 72h — a daily probe can report a breach up to 24h late, a quarter of the budget spent
on detection. Both gauges are written on every tick including the zero case, so a dead sweep and a clean
system do not produce the same scrape.

Compliance impact: reads only; the query returns ids and timings and never `subject_email_blind_index`, so no
personal data reaches a log line or a metric. Net effect on data subjects is positive.

**`sendQuotaRepository.resetPeriod` — traced, confirmed real, fixed.**

The first lead below, followed through. Nothing anywhere reset `email_send_used`: not a job, not a trigger,
not a DEFAULT, no raw SQL — searched across `apps/`, `packages/` and every migration. `resetPeriod` was the
only reset in the system and it documented itself as "driven by the P6 retention/period sweep", a sweep that
was never built. Usage only ever went up, so a tenant that reached its quota was refused by
`assertWithinQuota` **permanently**, with nothing short of hand-written SQL able to clear it.

Latent, not live, and that is why it survived review: `email_send_quota` has no default, so every tenant is
NULL (unlimited) until a platform admin calls `setQuota` — which does have callers. The trap springs the first
time anyone sets a quota.

Fixed by rolling the window inside `lock()`, under the `FOR UPDATE` it already holds, rather than by building
the missing sweep: a sweep is one more thing that can be down, mis-scheduled, or never built, which is how the
counter came to have no reset in the first place. Rolling at the point of use is self-healing and costs a
single UPDATE on the first send after the window elapses. `snapshot()` reports the effective usage so a GET
cannot claim a tenant is out of quota when the very next send would succeed.

**Open decision recorded in `docs/strategy/decisions.md`:** the window is a rolling 30 days. The method's own
comment said "monthly/daily" and never chose. If these quotas are meant to be billing-aligned, the constant
should be replaced by the billing-cycle boundary rather than tuned.

## Worth verifying next — possible real gaps, not yet confirmed

Each of these has no `.method(` call anywhere. None has been traced to a conclusion; they are ordered by what
would be worst if true. The one that has been traced is struck through — it was real.

| Method | If it really has no caller |
|---|---|
| ~~`sendQuotaRepository.resetPeriod`~~ | ~~A send quota that never resets its period.~~ **Confirmed and fixed — see above.** |
| ~~`eventOutboxRepository.prunePublished`~~ | ~~The outbox grows without bound.~~ **Confirmed and fixed — see below.** |
| ~~`oauthConnectStateRepository.sweepExpired`~~ | ~~OAuth connect-state rows accumulate forever.~~ **Not a bug — the table is inert. See below.** |
| ~~`userRepository.markEmailVerified`~~ | ~~Nothing marks an address verified.~~ **Not a bug — vestigial. See below.** |
| ~~`retentionClassPolicyRepository.getPolicy`~~ | ~~Per-class retention policy read by nothing.~~ **Not a bug — redundant accessor. See below.** |

All five leads are now traced: two were real and are fixed, three were not bugs. The verdicts also live in the
script's `ADJUDICATED` register, so a re-run prints them with their reason instead of re-listing the symbols as
unknowns. Without that the audit is a treadmill — the reader cannot tell "nobody has looked at this" from
"somebody looked and it was fine", and noise trains you to skim past the one finding that matters.

**`userRepository.markEmailVerified` — vestigial, not a gap.** `email_verified_at` is set at CREATION in both
`create()` call sites: registration proves the address with a code before the row exists, and SSO JIT takes the
IdP's word for it. `verifyEmailCode` therefore runs *before* the user exists, and there is no change-email flow
anywhere, so no address is ever verified after the fact. The method is a leftover from a design in which
verification came second.

**`retentionClassPolicyRepository.getPolicy` — redundant accessor, not a gap.** The repository is used:
`listPolicies` by `runRetentionSweep` and the admin routes, `upsertPolicy` by the admin write path. Only the
fetch-one-by-id accessor is unused, because the sweep reads the whole set per run.

**`eventOutboxRepository.prunePublished` — traced, confirmed real, fixed.**

`event_outbox` is live: `emitRevealEvent` and `linkedinLinkFetchSweep` append to it, and `realtimeRelay`
drains it — but the relay only ever flips rows to `published`, and nothing deleted them. `prunePublished`
documented itself as "retention" and had no caller, so the table has been accumulating for its entire life.

Wired into the existing `retentionSweep`, beside the idempotency-key and dead-session reaps it already runs —
no new queue, and the job's stated purpose already covered this. The window is 7 days rather than the house
30: a published row has no consumer left (the relay has already published it), so what remains is forensic
value, and it is the highest-volume of the three tables because every reveal appends.

`prunePublished` also gained a batch limit. Its unbounded `DELETE … WHERE status='published'` would, on the
first run against an accumulated backlog, take every matching row's locks in a single statement. The limit is
not a nicety — it is what makes the first execution safe. The caller loops until a short batch returns, the
same shape as the reaps beside it.

New itest (`eventOutboxRetention.itest.ts` — the table had no coverage at all). Every case pins something the
prune must LEAVE ALONE, because that is the dangerous direction: deleting too little wastes disk, deleting too
much destroys events that were never published. It covers a pending row, a `failed` row, a recently-published
row, the batch bound, and specifically that a NULL `published_at` is never swept even under a cutoff far in
the future — SQL's three-valued logic gives that for free today, and the test exists so a later rewrite to
`COALESCE(published_at, occurred_at)` fails loudly instead of quietly eating the queue.

**`oauthConnectStateRepository.sweepExpired` — traced, NOT a bug, nothing built.**

The reaper has no caller, but neither does anything else on that table: `oauth_connect_state` has no writer
anywhere outside tests. The mailbox OAuth handshake it was built for does not run. An unused reaper on an
empty table is a dark feature, not unbounded growth, and building a sweep for it would add a scheduled job
that can only ever delete zero rows. Revisit if and when that handshake ships — the method is already correct.

## Deliberately not acted on

- **The CRM connector family** (`crmConnectionRepository`, `crmRecordLinkRepository`, `crmSyncStateRepository`,
  `crmFieldMappingRepository`, `crmDeadLetterRepository`, `crmInboundEventRepository`, `crmOauthStateRepository`,
  `contributionPolicyRepository`) — 9 tables dark behind `CRM_SYNC_ENABLED`. Uncalled methods here are the
  expected state of an unshipped module, not rot.
- **`erRepository.confirmMerge`** — the subject of the I4 brief, whose exit gate is already recorded as
  unmeetable. Not something to wire opportunistically.
- **`outcomeMetricsRepository.mostWanted`** — still unsurfaced, and deliberately. Its own contract says any
  surface rendering it must first suppression-check every fingerprint against `suppression_list`'s
  `email_blind_index`, and that the demand feed itself is Phase 3. Shipping the numbers without that check
  would be exactly the compliance failure the method warns about. The miss COUNT is now surfaced (below); the
  miss SUBJECTS are not.
- **`outcomeMetricsRepository.actionCounts`** — still unsurfaced. Nothing needs per-action counts yet, and it
  has no workspace predicate of its own (it relies entirely on RLS under `withTenantTx`), so a future caller
  must run it on that seam and nowhere else.

**`outcomeMetricsRepository.revealOutcomes` — surfaced.** This was raised here as a product decision ("which
metrics, for whom, on which page") and turned out to have an answer already written down. The repository's own
header says the reveal-hit rate is the number **06-roadmap Phase 1 states its KILL criterion against** —
"reveal-hit rate <40% in the beachhead after seed load → stop" — and explains why no shipped meter can
substitute: `contact_reveals` records what was CHARGED, a miss never creates a claim row, so a hit rate derived
from it is 100% by construction. A kill criterion whose input nothing reads is not a criterion.

The remaining question was the page, and `apps/web`'s Reports destination already had six dashboard sections
and a route; this became the seventh rather than a new surface. `GET /api/v1/reports/reveal-outcomes` runs
under `withTenantTx` because these reads are workspace-scoped by RLS rather than by a WHERE clause. `hitRate`
and `p95ServerMs` stay NULLABLE end to end: "nothing attempted yet" and "every attempt missed" are opposite
conclusions, and a kill criterion that cannot tell them apart would stop the project on an empty table — the
panel renders that case as "Not enough data", never 0%.

## The general point

None of these were invisible. They sit in files that are reviewed, in packages that are type-checked, under
tests that pass. What no check asks is whether anything *calls* them — and a method with no caller cannot
fail, so nothing ever goes red. That is the same shape as the seven blind gates recorded in
`scripts/lint-gates-selftest.mjs`: the failure mode is silence, and silence has to be looked for deliberately.

## Second pass (2026-08-23) — six more traced, and the pattern behind them

Standing at **20 OPEN, 26 adjudicated** of 46 findings; "tested but never called" is down from 13 to 7. Each
verdict below was traced to a primary source, not inferred from the shape of the name.

| Method | Verdict |
|---|---|
| `masterJobPostingsRepository.upsertPosting` | Writer ahead of its producer. The file says so: hiring-intelligence evidence (0127, MI-S1) whose feed is D-6 procurement. |
| `accountChildRepository.setParentAccount` | Guard ahead of its verb. The file says so: *"NO API verb ships in this task"* — the `PATCH /accounts/:id` parent verb rides the account UI slice. |
| `effectivePolicyRepository.backfillTenantPolicies` | Invoked by a deploy step, not app code (tracker 1.1b-backfill), and the prerequisite of the 1.1b-cutover flip, which is gated on *"backfill applied, no drift"*. |
| `masterPersonDerivedRepository.backfillEmploymentDatesTx` | Migration 0136 does this backfill in SQL; the bounded version is the re-run tool for after a bulk landing. |
| `erRepository.listPersonsMissingBlockKey` | Superseded — `erSweep` folds the populate into its own cursor scan, because *"a separate backfill would re-scan the same table to do strictly less"*. |
| `providerCallRepository.spendSinceByProvider` | An unused refinement, not a broken brake: the aggregate `spendSince` IS the daily spend guard, called from three places. |

**The pattern: this codebase deliberately lands a repository method ahead of its caller, and says so at the
definition.** Two of the six state it outright in the doc comment ("the WRITER exists ahead of its producer",
"NO API verb ships in this task"). That is a deliberate sequencing habit, not rot — which means a raw
"no caller" list systematically over-reports here, and the first move on any finding should be to read the
method's own comment before assuming neglect.

It cuts the other way too, so the audit stays worth running: **the two real bugs this audit found — a send
quota that never reset, and an outbox with no retention — were BOTH in methods whose comments claimed a caller
that did not exist** ("driven by the P6 retention/period sweep", "retention"). The tell is not silence. It is a
comment that names a caller, plus no caller.

**One stale comment corrected.** `listPersonsMissingBlockKey` said "nothing writes it yet"; `erSweep` does.
That comment briefly convinced this audit it had found an inert column, which is the cost of documentation that
outlives its facts.
