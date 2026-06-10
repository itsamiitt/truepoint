# ADR-0026 — Workflow automation engine

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context doc:** [27-workflow-automation-engine.md](../27-workflow-automation-engine.md), [05-features-modules.md](../05-features-modules.md)

## Context

The platform has rich primitives — intent signals, scores, lists/segments, sequences, CRM sync, Slack
notifications — but **no engine to connect them**. Sequencing (`05 §13`) is a manual builder; there is no
"when a funding-round signal fires, assign the account to the right rep and enroll them in a play."
Signal-to-action automation is a core 2026 differentiator and the connective tissue for department
workflows (`25`, departments) and AI plays (`23`).

## Decision

Build a declarative **trigger → condition → action** automation engine (detail in
[27](../27-workflow-automation-engine.md)).

- **`automation_rules`:** workspace/team-scoped rule = `trigger` + `conditions` (JSON predicate over
  record/signal/score fields) + ordered `actions`, with enable/disable, owner, and a **dry-run** mode.
- **`automation_trigger`** enum: `signal_received|score_changed|record_created|record_updated|
  list_entered|reply_received|reveal_completed|schedule|manual`.
- **`automation_action`** enum: `enroll_sequence|assign_owner|assign_team|add_to_list|update_field|
  send_notification|create_task|push_crm|send_webhook|adjust_score`.
- **`automation_runs`:** an append-only execution log (rule, trigger event, evaluated conditions, actions
  taken, outcome) for observability + audit; material actions also hit `audit_log` (`08 §5`).
- **Execution model:** triggers are sourced from the **event backbone** ([ADR-0027](./ADR-0027-real-time-delivery-and-event-backbone.md))
  (domain events / outbox), evaluated by a `workers` consumer; actions are **idempotent** and run under
  the rule owner's RLS + team visibility (`H18`).
- **Guardrails (`H21`):** every action respects **suppression** (`H5`) and reveal gating; rate-limited
  per workspace; AI-generated content actions require human review (`H19`); per-team automation policies
  in settings (`12`) bound what rules may do.
- **Library:** prebuilt **recipes/plays** (signal-to-play, territory routing, lead-handoff, churn-risk)
  seed department modules.

## Rationale

A single declarative engine driven by domain events is the lowest-complexity way to deliver cross-module
automation and department workflows, reusing sequences/CRM/notifications/scoring as actions. Idempotent,
suppression-respecting, audited actions keep it safe in a regulated context.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Declarative trigger/condition/action engine (this ADR)** | Chosen | Reuses primitives; cross-module; safe + auditable; powers departments + AI plays. |
| Per-feature bespoke automations | Rejected | Fragmented, duplicative, no shared audit/guardrails. |
| Third-party iPaaS only (e.g. Zapier) | Rejected | Leaves core signal-to-play off-platform; weak compliance/audit; not a differentiator. |

## Consequences

- **Positive:** signal-to-play + department workflows; one audited, guarded execution path; recipe
  library; AI plays plug in as actions.
- **Negative:** an engine to build/operate; loop/abuse risks; condition-language surface.
- **Mitigation:** idempotency + per-workspace rate limits + dry-run + suppression gate + `automation_runs`
  observability; bounded condition predicates.

## Revisit if

Automation volume needs a dedicated stream processor, or customers demand a full visual no-code builder
beyond the recipe + rule model.
