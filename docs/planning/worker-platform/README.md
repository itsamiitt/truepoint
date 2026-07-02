# TruePoint Worker Platform — Audit & Target Architecture

This directory is the enterprise-grade audit of the TruePoint (`@leadwolf/*`) background-job
worker system (`apps/workers`, `@leadwolf/workers`). It was commissioned to answer one operational
question — *why does the admin dashboard show `Queued: 4, Awaiting Confirmation: 1`?* — and then
to turn that investigation into a full current-state audit, a target architecture for millions of
users / billions of jobs, and a verifiable path to get there.

## Verdict

The stuck dashboard counts are **almost certainly by design, not a broken worker.** `Queued` and
`Awaiting Confirmation` are `enrichment_jobs.status` values in a **DB control table** — *not* BullMQ
queue depth — and the entire bulk-enrichment money path is deliberately **dark** behind an env
kill-switch (`BULK_ENRICHMENT_ENABLED`, default off) plus a per-tenant feature flag plus a
human confirm-before-spend gate. With the switch off, nothing consumes `queued` rows (an inert
orphan by design) and `awaiting_confirmation` is the intended resting state of an armed job no one
has confirmed. The system is genuinely thin on observability, retries/DLQs, and scale primitives —
but the specific counts under investigation are safe-by-default rollout behaviour, not a fault. The
audit's job is to hold both truths at once: explain the by-design darkness **and** give operators a
runbook to rule out the real failure modes (worker never booted, Redis wedged, a boot crash from an
unrelated missing env var) on the live environment. See
[03-live-inspection-runbook.md](03-live-inspection-runbook.md) to decide by-design vs fault in
minutes.

## Recommended reading order

Start with **[00-executive-summary.md](00-executive-summary.md)** — the ~5-min capstone for eng
leadership and staff engineers: the headline by-design verdict, the five stuck rows explained, the
by-design-vs-defect table, the ranked risks, and the P0/P1/P2 roadmap, each claim linked back to its
detail doc and cited to `path:line`. Then read the detail in order:

1. [01-current-architecture-audit.md](01-current-architecture-audit.md) — the as-built system: the
   25-queue table, boot/leader/health composition, both flag systems, and the dashboard data path.
2. [02-root-cause-analysis.md](02-root-cause-analysis.md) — the `enrichment_jobs` state machine and
   ranked stuck-causes behind the reported counts.
3. [03-live-inspection-runbook.md](03-live-inspection-runbook.md) — exact live-env commands and an
   interpretation matrix to confirm by-design vs fault. **Start here in an incident.**
4. [04-issue-resolution-plan.md](04-issue-resolution-plan.md) — per-issue root cause, impact, fix,
   rollback, and validation (with by-design/doc-only items clearly separated from real fixes).
5. [05-enterprise-research.md](05-enterprise-research.md) — web-cited best practice for large-scale
   background job processing, each section grounded back to TruePoint.
6. [06-gap-analysis.md](06-gap-analysis.md) — intended (docs/ADRs) vs built matrix and ranked
   bottlenecks — the bridge from audit to target.
7. [07-target-architecture.md](07-target-architecture.md) → [08-migration-strategy.md](08-migration-strategy.md)
   — where we are going and the phased, reversible path there.
8. [09-reliability-fault-tolerance.md](09-reliability-fault-tolerance.md) ·
   [10-observability-alerting.md](10-observability-alerting.md) ·
   [11-capacity-finops.md](11-capacity-finops.md) ·
   [12-security-review.md](12-security-review.md) — the four cross-cutting target pillars.
9. [13-operational-runbooks.md](13-operational-runbooks.md) — the day-2 runbooks that operationalize
   the target.
10. [14-re-audit-and-risks.md](14-re-audit-and-risks.md) — an adversarial second pass over the
    proposals, surfacing residual risk and revised recommendations. Its findings (F1–F15) have now
    been reconciled into 07/08/11/15, and where those docs still differ from it, **14 is the
    authoritative override.**
11. [15-phased-implementation-plan.md](15-phased-implementation-plan.md) — the deferred, verifiable
    code plan (no code written yet), phased from quick wins to outbox/autoscaling/multi-region.

> Note: [00-executive-summary.md](00-executive-summary.md) is now written and is the top-of-funnel
> entry point; [01-current-architecture-audit.md](01-current-architecture-audit.md) and
> [02-root-cause-analysis.md](02-root-cause-analysis.md) remain the fastest way into the underlying
> as-built detail.

## Objective → document map

| # | Objective | Document(s) |
|---|---|---|
| 0 | Executive summary — the whole audit in ~5 min: headline verdict, by-design-vs-defect table, ranked risks, and the P0/P1/P2 roadmap | [00-executive-summary.md](00-executive-summary.md) |
| 1 | Explain the current worker system and root-cause the stuck dashboard counts (by-design vs fault) | [01-current-architecture-audit.md](01-current-architecture-audit.md), [02-root-cause-analysis.md](02-root-cause-analysis.md), [03-live-inspection-runbook.md](03-live-inspection-runbook.md) |
| 2 | Deliver a concrete issue-resolution plan | [04-issue-resolution-plan.md](04-issue-resolution-plan.md) |
| 3 | Research enterprise best practice for large-scale background job processing | [05-enterprise-research.md](05-enterprise-research.md) |
| 4 | Define the enterprise target architecture and the path to it | [06-gap-analysis.md](06-gap-analysis.md), [07-target-architecture.md](07-target-architecture.md), [08-migration-strategy.md](08-migration-strategy.md), [09-reliability-fault-tolerance.md](09-reliability-fault-tolerance.md), [10-observability-alerting.md](10-observability-alerting.md), [11-capacity-finops.md](11-capacity-finops.md), [12-security-review.md](12-security-review.md), [13-operational-runbooks.md](13-operational-runbooks.md) |
| 5 | Adversarially re-audit the proposals and surface residual risk | [14-re-audit-and-risks.md](14-re-audit-and-risks.md) |
| 6 | Produce a phased, verifiable implementation plan for the code work | [15-phased-implementation-plan.md](15-phased-implementation-plan.md) |

## How to use this with the live runbook

Read this set as analysis, but **act from [03-live-inspection-runbook.md](03-live-inspection-runbook.md).**
When the dashboard shows stuck `Queued` / `Awaiting Confirmation` counts, do not assume a broken
worker: open the runbook and walk its checks in order — is the `workers` container up, is Redis
reachable and what are the real queue depths, what do the `enrichment_jobs` rows say, and what state
are the env kill-switch and per-tenant flags in. Its interpretation matrix maps each observation to
either *by-design (expected)* or a *specific fault*; when it points at a fault, jump to the matching
procedure in [13-operational-runbooks.md](13-operational-runbooks.md) (worker down, Redis wedged,
backlog/stuck job, DLQ growth, safe flag-flip to enable bulk-enrichment, confirm a stuck
`awaiting_confirmation`, boot-crash-from-missing-env). The runbook decides *whether* there is a
problem; the audit chapters explain *why* and the implementation plan says *what to change*.
