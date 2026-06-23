# Incident Response

When TruePoint breaks in a way users feel, the response is a defined process, not
improvisation. A process gets faster and better each time; firefighting doesn't.
This builds on the platform observability (alerts, SLOs, traces) that surfaces and
diagnoses incidents — see `truepoint-platform` observability.

> **Implementation status:** this process assumes the platform observability stack
> (alerting, SLO burn alerts, traces, a status page) is wired. Confirm that
> dependency is actually in place — the detection/declare/communicate steps below
> degrade to manual report-driven response wherever an alert or signal isn't yet
> emitted. The process is the target regardless; close any observability gap rather
> than weakening the process.

---

## Severity Levels

Every incident is classified, because severity drives urgency, who's pulled in, and
communication:

- **SEV1 — critical.** Broad outage or data exposure: the product is down for many
  users, a cross-tenant data leak, or a security breach. All-hands, immediate,
  customer-facing communication, executive awareness. A suspected cross-tenant data
  exposure is always SEV1 (the worst case in a multi-tenant CRM — see
  `truepoint-security` access-control).
- **SEV2 — major.** A core capability is broken or badly degraded for many users
  (search down, enrichment failing, logins failing for a segment), but not a total
  outage or breach. Urgent, owner + on-call engaged.
- **SEV3 — minor.** Limited or degraded impact with a workaround; a single
  non-critical feature, or elevated errors within SLO budget. Handled in normal
  working hours.

When unsure, classify *up* — it's cheaper to downgrade a SEV2 than to under-respond
to a SEV1.

---

## The Flow

1. **Detect** — an alert fires (SLO burn, error spike, saturation — platform
   observability) or a report arrives.
2. **Declare and classify** — name it an incident, assign a severity, name an
   **incident commander** (coordinates; not necessarily the one fixing).
3. **Communicate** — internal channel opened; for SEV1/2, customer-facing status
   (see Status Page) and stakeholder updates on a cadence.
4. **Mitigate first, fix second** — stop the bleeding (feature-flag the feature off
   — see `runbooks.md` and architecture feature-flags; roll back; shed load) before
   root-causing. Restoring users comes before understanding.
5. **Resolve** — confirm recovery against the signal that detected it (the SLO/metric
   is healthy, not just "looks fine").
6. **Postmortem** — blameless, written, with follow-up actions (below).

---

## Mitigation Levers (Know These Cold)

The fastest recovery is usually not a code fix:

- **Feature flag off** — disable the offending feature at runtime, no deploy (the
  rollback mechanism the pre-build pass requires; see architecture feature-flags).
- **Roll back** — revert to the last good deploy; additive-first migrations make
  this safe (architecture `database.md`, platform service-topology).
- **Shed/limit load** — tighten rate limits, pause a queue, scale workers
  (platform async-jobs, scaling-playbook).
- **Fail over** — to a replica/region for an infrastructure failure (platform
  data-platform).

Every critical feature's runbook names which levers apply to it.

---

## Blameless Postmortems

After every SEV1/SEV2 (and notable SEV3s):

- **Blameless** — the question is "what about the system let this happen," never
  "who messed up." People are honest only when they aren't blamed, and honesty is
  what makes the postmortem useful.
- **Written and shared** — timeline, impact, root cause, what went well, what
  didn't, and concrete **follow-up actions with owners**.
- **Actions are tracked to completion** — a postmortem whose actions are never done
  guarantees the repeat. Common actions: an alert that would've caught it sooner,
  a runbook gap, a missing guardrail, a test (e.g. a tenant-isolation test after a
  scoping bug — platform tenancy).

---

## Status Page and Customer Communication

- A **public status page** communicates SEV1/SEV2 to customers — enterprise buyers
  expect one. Honest, timely, plain-language updates beat silence.
- Don't expose internal detail, customer data, or anything that aids an attacker
  mid-incident (especially for a security incident — coordinate with breach
  notification, `breach-notification.md`).
- Enterprise/siloed customers may have contractual communication SLAs — honour them.

---

## Checklist

- Is the incident classified by severity, with a commander and an internal channel?
- For SEV1/2, is there customer-facing status and a stakeholder update cadence?
- Was the bleeding stopped (flag/rollback/shed/failover) before root-causing?
- Is recovery confirmed against the detecting signal, not just impression?
- Is there a blameless written postmortem with tracked follow-up actions?
- Is a suspected cross-tenant exposure always treated as SEV1 + breach process?
