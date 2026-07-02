# Executive Summary — TruePoint Worker Platform Audit

> **Audience:** eng leadership + staff engineers. **Read time:** ~5 min. This is the capstone of the
> worker-platform audit set; every claim links to the detailed sibling doc and cites `path:line` for
> as-built facts. Registers are kept distinct throughout: **[AS-BUILT]** = code today (cited),
> **[INTENDED]** = a sanctioned ADR/§18/§19 target, **[REC]** = this audit's proposal (never presented
> as if it exists).

---

## 1. Headline verdict

**The dashboard reading `Queued: 4, Awaiting Confirmation: 1` is by design — not a broken worker.**

Those numbers are **not BullMQ queue depths.** They are a `count(*) … GROUP BY status` census of rows
in the database control table `enrichment_jobs`
(`packages/db/src/repositories/platformAdminReads.ts:549-554` → `apps/api/src/features/admin/dataRoutes.ts:160-183`
→ `apps/admin/src/features/system-health/components/SystemHealthPage.tsx:192-199`). The entire
bulk-enrichment ("confirm-before-spend") money path that produces them is deliberately **dark** behind a
three-part safety envelope, all fail-closed and defaulting off:

1. a deploy-time env kill-switch `BULK_ENRICHMENT_ENABLED` (default OFF, `packages/config/src/env.ts:223`);
2. a per-tenant rollout flag `bulk_enrichment_enabled` (seeded `global_enabled=false, default=false`,
   `packages/db/src/migrations/0048_seed_bulk_enrichment_flag.sql:1`); and
3. a human owner/admin confirm-before-spend gate (`apps/api/src/features/enrichment/routes.ts:82-100`).

With the switch off, the BullMQ consumer is **never even constructed** (`apps/workers/src/register.ts:636`),
and the initial bulk-enrich request writes a DB row and enqueues nothing
(`packages/core/src/prospect/bulkActions.ts:337-364`). The source comment states it literally: a `queued`
bulk-enrich job "stays an inert orphan exactly as today (no worker, no spend)"
(`packages/core/src/prospect/bulkActions.ts:330-332`).

**Important caveat:** a healthy-looking tally does **not** prove a healthy worker. Three genuine faults
(worker never booted, Redis silently wedged, boot crash from an unrelated missing env var) present as
*different* stuck states or are invisible in these particular counts. They must be ruled out on the live
environment — see [`02-root-cause-analysis.md`](02-root-cause-analysis.md) §8 and the commands in
[`03-live-inspection-runbook.md`](03-live-inspection-runbook.md). Also explicitly ruled out: the
multi-agent coord-bus (`tools/coord-bus/COORDINATION.md`) has no `Queued`/`Awaiting Confirmation` states
and is **not** the source ([`01-current-architecture-audit.md`](01-current-architecture-audit.md) §12).

## 2. The five stuck rows, explained

Full lifecycle trace in [`02-root-cause-analysis.md`](02-root-cause-analysis.md); live commands in
[`03-live-inspection-runbook.md`](03-live-inspection-runbook.md).

- **`Queued` × 4 — inert orphans by design.** Each is one click of "bulk re-enrich" while the flag was
  off. The insert chose `queued` via `status: enabled ? "estimating" : "queued"`
  (`packages/core/src/prospect/bulkActions.ts:354`). **There is no `queued → *` transition anywhere in
  the code** — the flag-ON lane skips `queued` entirely — so the row is a durable record of a click that,
  by policy, spends nothing. Worker health is irrelevant: nothing ever reads a `queued` row.
- **`Awaiting Confirmation` × 1 — parked at the human gate.** This row was submitted while the flag was
  ON: it went `∅ → estimating → awaiting_confirmation` (`enrichmentJobRepository.ts:331-345`) and now
  **waits indefinitely for an owner/admin to click confirm** — its intended resting state. It is
  deliberately *excluded* from the `queueDepth` tile because it waits on a human, not a worker
  (`apps/api/src/features/admin/dataRoutes.ts:166-167`). It may be unconfirmable if the switch was since
  turned off (confirm 403s) — still by-design, not a worker fault.

Fast heuristic: if the only non-terminal rows are `queued` and one `awaiting_confirmation` with **zero
`running`/`paused`**, the system is behaving exactly as a safe-by-default rollout should. Stuck `running`
or `paused` rows are the tell of a genuine fault (§8 of the RCA).

## 3. By-design vs genuine defect

The single most important framing of the whole audit. Detail: [`04-issue-resolution-plan.md`](04-issue-resolution-plan.md).

| Observation | Register | Action |
|---|---|---|
| `Queued: 4` (inert orphans, flag off) `bulkActions.ts:330-332,354` | **By design** | None. Expected. |
| `Awaiting Confirmation: 1` (parked at human gate) `routes.ts:82-100` | **By design** | Optional operator confirm/cancel only. |
| Flag-gated dark queues #19–#25; internally-guarded sweeps (retention shadow, ER, reverification) | **By design** | Rollout/runbook decision, not a patch. |
| Consumers with no live producer (enrichment/scoring/dsar) `register.ts:204,210,216` | **By design** | Doc; close retry/DLQ before wiring a producer. |
| Prod `workers` has **no healthcheck / no port** → wedged worker never restarted `docker-compose.prod.yml:115-117` | **Defect (S0)** | Add healthcheck + restart policy. |
| Redis unreachable → `maxRetriesPerRequest:null` **buffers silently, `/health` stays 200** `register.ts:132`, `health.ts:15-20` | **Defect (S0)** | Deepen `/ready` to PING Redis. |
| Non-atomic confirm→running→enqueue (no outbox); lost drive → stuck `running` `routes.ts:101,119` | **Defect (S0, latent)** | Transactional outbox / recovery sweep (ADR-0027). |
| `paused` trap — no `paused → running` resume wired `runBulkEnrich.ts:71` | **Defect (latent)** | Guarded resume/cancel before enabling spend. |
| `failed`/`cancelled` declared but **never written** → `deadLetter` reads 0 falsely | **Defect (latent)** | Wire terminal transitions. |
| `attempts:1` (no retry) on 6 event queues `register.ts:205,211,217,223,324,330` | **Defect** | Bounded retry + backoff + jitter. |
| DLQ on only **3 of 25** queues `register.ts:379,620,659` | **Defect** | DLQ + redrive everywhere. |
| Concurrency **1** + single Redis + single replica; no lock/stalled tuning; no drain timeout `index.ts:20` | **Defect (latent → scale)** | Tune, then HA + autoscale. |
| Whole-app env schema crashes worker on unrelated missing key `env.ts:328-335` | **Defect** | Slice per-service env. |
| No metrics/traces/errors/SLOs/alerts (no telemetry libs installed) `logger.ts:9-11` | **Not-yet-built + Defect** | Build observability layer. |

> Note the asymmetry: the S0 defects (no healthcheck, silent Redis wedge, non-atomic enqueue) bite the
> **live** system regardless of any dark feature; the lifecycle defects (paused-trap, no fail/cancel,
> thin retry/DLQ) are **latent until `BULK_ENRICHMENT_ENABLED` is switched on** — which is exactly why
> they must be closed *before* the flag flips, not after.

## 4. Top risks, ranked

By blast radius at target scale, with live-env risk noted. Full derivation:
[`06-gap-analysis.md`](06-gap-analysis.md) §3; per-issue fixes: [`04-issue-resolution-plan.md`](04-issue-resolution-plan.md).

1. **Single shared Redis — SPOF + silent wedge (S0, real now).** One `IORedis` for all 25 queues
   (`register.ts:132`); an outage buffers commands forever with `/health` still green. → [`09`](09-reliability-fault-tolerance.md), [`10`](10-observability-alerting.md).
2. **No prod healthcheck / auto-restart (S0, real now)** (`docker-compose.prod.yml:115-117`). A wedged
   worker is indistinguishable from a healthy one to every automated system. → [`04`](04-issue-resolution-plan.md) I-10.
3. **No transactional outbox — non-atomic enqueue (S0, real once confirm is used).** Enqueue-after-commit
   is the pattern ADR-0027 explicitly rejects; a lost drive → permanently stuck `running`. → [`09`](09-reliability-fault-tolerance.md).
4. **Concurrency 1 everywhere (S1, catastrophic when bulk is on at volume).** One job at a time per queue;
   a hung job blocks the queue. Violates the §18 freshness SLOs. → [`09`](09-reliability-fault-tolerance.md), [`11`](11-capacity-finops.md).
5. **Partial DLQ + partial retry (S1).** 6 queues lose transient failures with no trace or recovery. → [`09`](09-reliability-fault-tolerance.md).
6. **No observability (S1, blind now).** No depth/age/oldest-job, no DLQ-growth alert, no burn-rate gate;
   a wedge is found by users, not monitors. → [`10`](10-observability-alerting.md).
7. **No autoscaling / backpressure / priority (S1)** and **no multi-region/DR (S1)** — the not-yet-built
   target-scale layer. → [`07`](07-target-architecture.md), [`11`](11-capacity-finops.md).

The second-pass adversarial review ([`14-re-audit-and-risks.md`](14-re-audit-and-risks.md)) found the
*proposed cure* also carries risks that must be designed out inside their phase gates: the outbox relay
must be **leaderless-and-partitioned** (not single-leader), the daily budget breaker must be made
**atomic** before any concurrency raise, DR duplicate-spend is **RPO-bounded, not zero**, and
`withLeaderLock` is **fenceless / intra-cluster** and not partition-safe.

## 5. Remediation roadmap (P0 / P1 / P2)

Sequenced so everything required to safely enable the money path is closed **before** the flag flips.
Full sequencing and exit criteria: [`15-phased-implementation-plan.md`](15-phased-implementation-plan.md).

| Tier | Theme | Scope | Gate to advance |
|---|---|---|---|
| **P0** | Confirm-on-live (no code) | Run [`03`](03-live-inspection-runbook.md): rule out worker-down / Redis-wedge / boot-crash behind the counts | Counts proven by-design on the live env |
| **P0** | Make the dark system observable & recoverable | `/ready` PINGs Redis + prod healthcheck (I-10); core queue metrics + alerts (I-14 slice); boot-env decouple (I-11) | A wedged worker is now visible + auto-restarted |
| **P1** | Reliability before enabling spend | Outbox/recovery (I-03), `paused` resume (I-04), `failed`/`cancelled` (I-05), retries+backoff (I-06), DLQ-everywhere (I-07), lock/vendor timeouts (I-08), bounded drain (I-15) | Bulk-enrich lifecycle is complete, retried, DLQ'd, resumable |
| **P2 / at-scale** | Elasticity & resilience | Concurrency >1, HA Redis, autoscale on depth+age, backpressure + priority + per-tenant caps, full traces/SLO gates, multi-region/DR | Meets ADR-0024 / §18 / §19 targets |

## 6. What to do now

1. **Do nothing to the code first — confirm on the live env.** Run
   [`03-live-inspection-runbook.md`](03-live-inspection-runbook.md) end to end to positively establish
   the `Queued: 4 / Awaiting Confirmation: 1` counts are by-design and to falsify the three genuine
   faults. Do not treat the tally as an incident until Redis-wedge / worker-down / boot-crash are
   excluded.
2. **Land the P0 slice.** Deepen `/ready` to PING Redis and add a prod healthcheck + restart policy,
   plus the core queue-depth/age/DLQ metrics and alerts — so next time these counts appear, the
   by-design-vs-fault question is answered by a **signal, not a manual inspection**.
3. **Do not flip `BULK_ENRICHMENT_ENABLED` yet.** The lifecycle defects (I-03, I-04, I-05) are latent
   until it is on. Close the P1 reliability gate first; the deliberate flip is owned by the safe
   flag-flip runbook in [`13-operational-runbooks.md`](13-operational-runbooks.md), not by any build
   schedule.

---

### See also

[`01-current-architecture-audit.md`](01-current-architecture-audit.md) ·
[`02-root-cause-analysis.md`](02-root-cause-analysis.md) ·
[`03-live-inspection-runbook.md`](03-live-inspection-runbook.md) ·
[`04-issue-resolution-plan.md`](04-issue-resolution-plan.md) ·
[`06-gap-analysis.md`](06-gap-analysis.md) ·
[`07-target-architecture.md`](07-target-architecture.md) ·
[`09-reliability-fault-tolerance.md`](09-reliability-fault-tolerance.md) ·
[`10-observability-alerting.md`](10-observability-alerting.md) ·
[`11-capacity-finops.md`](11-capacity-finops.md) ·
[`12-security-review.md`](12-security-review.md) ·
[`13-operational-runbooks.md`](13-operational-runbooks.md) ·
[`14-re-audit-and-risks.md`](14-re-audit-and-risks.md) ·
[`15-phased-implementation-plan.md`](15-phased-implementation-plan.md)
