---
name: truepoint-operations
description: >
  How TruePoint is run in production once it's built — the operational maturity an
  enterprise product is expected to have. Use this skill for incident response, on-
  call, runbooks, breach notification, and FinOps/cost control (especially the
  metered enrichment and verification spend). Triggers on questions about what to do
  when something breaks, how incidents are classified and escalated, what happens
  after a security incident, how cost is controlled per tenant, or how a feature is
  made operable. It complements truepoint-platform (which builds observability and
  scale in) by covering the human and process side of operating the system. If the
  question is "how do we run, respond to, or pay for this in production", this skill
  is active.
---

# TruePoint Operations Skill

Building the system is half the job; operating it is the other half, and
"enterprise-grade" is largely an operational claim. This skill covers running
TruePoint in production: responding when it breaks, telling customers when their
data is affected, and controlling the real money the metered subsystems spend.

It complements **truepoint-platform**, which builds the *capabilities* to operate —
observability, SLOs, async resilience. This skill is the *practices* that use them.

---

## Which Skill, When

- **truepoint-operations** (this skill) — incident response, on-call, runbooks,
  breach notification, FinOps/cost control.
- **truepoint-platform** — the observability, SLOs, queues, and scale this skill
  operates against.
- **truepoint-security** — the controls and compliance program; breach
  *obligations* live there, breach *response process* here.
- **truepoint-data** — the enrichment/verification spend this skill's FinOps bounds.

---

## The Operational Principles

- **Every critical path has an owner and a runbook.** When it breaks at 3am, the
  responder should not be reverse-engineering the system. The pre-build pass's
  "one-line runbook entry" requirement is where this starts (see `runbooks.md`).
- **Incidents have a defined severity, escalation, and a blameless postmortem.**
  Ad-hoc firefighting doesn't improve; a process does (see `incident-response.md`).
- **A data breach starts a clock.** Regulator and customer notification have legal
  deadlines (GDPR's 72 hours); the response is planned before the incident, not
  invented during it (see `breach-notification.md`).
- **Metered spend is bounded per tenant.** Enrichment and verification cost real
  money per call; without per-tenant caps a bug or a stolen session is an unbounded
  bill (see `finops.md`).
- **You operate what you can see.** This skill assumes the platform observability
  exists (logs/traces/metrics/SLOs); if a feature can't be seen, it isn't
  operable — fix that first (platform observability).

  > **Implementation status:** the observability stack this skill operates against is
  > a dependency to confirm, not assumed-complete — where logs/traces/metrics/SLOs
  > aren't yet wired for a path, close that gap rather than relaxing the operational
  > expectations below.

---

## Reference Files

| Task | Read |
|---|---|
| Handling an incident; severity; escalation; postmortems; status page | `references/incident-response.md` |
| A security incident affecting data; regulator/customer notification | `references/breach-notification.md` |
| Cost control; per-tenant quotas; enrichment/verification spend; metering | `references/finops.md` |
| Writing a runbook; on-call expectations; making a feature operable | `references/runbooks.md` |

---

## Companion Skills

This skill runs the system. It depends on **truepoint-platform** for the
observability and resilience it operates against, carries out the notification
obligations defined in **truepoint-security** compliance, and bounds the
**truepoint-data** enrichment spend. Operating well is a property of the whole
system, not a separate phase.
