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

## Worth verifying next — possible real gaps, not yet confirmed

Each of these has no `.method(` call anywhere. None has been traced to a conclusion; they are ordered by what
would be worst if true.

| Method | If it really has no caller |
|---|---|
| `sendQuotaRepository.resetPeriod` | A send quota that never resets its period — either sending stops permanently at the cap, or the reset happens in SQL somewhere and this is redundant. |
| `oauthConnectStateRepository.sweepExpired` | OAuth connect-state rows accumulate forever; expired state is retained rather than reaped. |
| `eventOutboxRepository.prunePublished` | The transactional outbox (migration 0051) grows without bound — published rows are never pruned. |
| `userRepository.markEmailVerified` | Almost certainly verified through another path; worth confirming which, because the alternative is that nothing marks an address verified. |
| `retentionClassPolicyRepository.getPolicy` | Per-class retention policy read by nothing — relevant to the double-gated retention engine, which is inert by design. |

## Deliberately not acted on

- **The CRM connector family** (`crmConnectionRepository`, `crmRecordLinkRepository`, `crmSyncStateRepository`,
  `crmFieldMappingRepository`, `crmDeadLetterRepository`, `crmInboundEventRepository`, `crmOauthStateRepository`,
  `contributionPolicyRepository`) — 9 tables dark behind `CRM_SYNC_ENABLED`. Uncalled methods here are the
  expected state of an unshipped module, not rot.
- **`erRepository.confirmMerge`** — the subject of the I4 brief, whose exit gate is already recorded as
  unmeetable. Not something to wire opportunistically.
- **`outcomeMetricsRepository` (`mostWanted`, `revealOutcomes`, `actionCounts`)** — the repository is exported
  from the `@leadwolf/db` barrel and referenced by nothing else in the monorepo. **The queries that measure
  the product's own outcome metrics have no consumer.** CLAUDE.md rule 2 requires acceptance criteria written
  as outcome metrics; the SQL for several exists and no surface reads it. Building that surface is a product
  decision (which metrics, for whom, on which page), so it is raised here rather than decided.

## The general point

None of these were invisible. They sit in files that are reviewed, in packages that are type-checked, under
tests that pass. What no check asks is whether anything *calls* them — and a method with no caller cannot
fail, so nothing ever goes red. That is the same shape as the seven blind gates recorded in
`scripts/lint-gates-selftest.mjs`: the failure mode is silence, and silence has to be looked for deliberately.
