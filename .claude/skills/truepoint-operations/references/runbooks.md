# Runbooks and On-Call

A runbook is the difference between a calm two-minute mitigation and an hour of
panic at 3am. Every critical path has one, and writing it is part of building the
feature — the pre-build pass already requires at least a one-line runbook entry per
feature. This file is what a good runbook contains and how on-call uses them.

> **Implementation status:** the "how you know it's broken" and "mitigation levers"
> sections below lean on the platform observability and feature-flag/rollback
> mechanisms (see `truepoint-platform`). Confirm those are wired for each path —
> where an alert, dashboard, or named flag a runbook cites doesn't yet exist, that is
> a gap to close, not a reason to drop the runbook requirement. Keep the "every
> critical path has a runbook entry" principle as the target.

---

## What a Runbook Is

A runbook is a short, practical document for *when this specific thing breaks*:

- **What this feature/path does** — one or two lines, in operational terms.
- **How you know it's broken** — the alert(s), the dashboard, the symptom users
  report (ties to platform observability).
- **First things to check** — the most common causes, in order, with where to look
  (which metric, which log query, which trace).
- **Mitigation levers** — the specific ways to stop the bleeding for *this* path:
  which feature flag disables it (architecture feature-flags), whether rollback is
  safe, which queue to pause, what to scale (incident-response mitigation levers).
- **Escalation** — who owns this path and who to pull in if first mitigation
  doesn't work.

It is not architecture documentation — it's a checklist for someone tired and under
pressure who may not have built the thing.

---

## Runbooks Are Built With the Feature

Like tests, observability, and FinOps, runbooks are wired at build time, not
retrofitted after the first incident (the pre-build "on-call runbook entry" item):

- The feature ships with its runbook entry — even one line to start, expanded as
  the feature grows and as incidents reveal gaps.
- A postmortem that finds "there was no runbook / the runbook was wrong"
  (incident-response) produces a runbook update as a tracked action.
- The mitigation levers in the runbook are *real and tested where possible* — a
  feature flag named in a runbook must actually exist and actually disable the
  feature.

---

## On-Call Expectations

- **Every critical path has an owner.** On-call routes to someone who can act, with
  a clear escalation path to the owning team.
- On-call's job in an incident is to **stabilise** (mitigate via the runbook levers)
  and **escalate** appropriately — not necessarily to root-cause alone at 3am.
- On-call is **sustainable** — alert hygiene (platform observability: alert on
  symptoms + saturation, not noise) is what keeps on-call from burning out and
  starting to ignore alerts. A noisy pager is a broken pager.

---

## Keeping Runbooks Alive

A stale runbook is worse than none — it sends the responder down a dead path.

- Runbooks are reviewed when the feature changes materially and after incidents.
- A runbook that references a removed flag, a renamed metric, or a dead dashboard
  is a bug, fixed like any other (the removal-cleanup discipline — architecture
  removal-cleanup — applies to operational docs too).

---

## Checklist

- Does every critical path have a runbook covering what it is, how you know it
  broke, what to check, how to mitigate, and who to escalate to?
- Does the feature ship with at least a one-line runbook entry, expanded over time?
- Are the runbook's mitigation levers (flags, rollback, queue controls) real and
  tested?
- Does on-call route to someone who can act, with sustainable alert hygiene?
- Are runbooks kept current as features change and after postmortems?
