# 27 — Workflow Automation Engine

> The connective tissue: a declarative **trigger → condition → action** engine that turns signals, scores,
> and events into department workflows and signal-to-play automation — safely, idempotently, and audited.
> [ADR-0026](./decisions/ADR-0026-workflow-automation-engine.md) locks the design; runs on the event
> backbone ([20](./20-event-driven-realtime-backbone.md)).

## 1. Principles

- **One engine, many plays.** Sequences, CRM push, notifications, scoring, and AI plug in as **actions** —
  no per-feature bespoke automations.
- **Safe by construction.** Every action respects **suppression** (`H5`) + reveal gating (`H1`), is
  **idempotent**, runs under the rule owner's RLS + team visibility (`H18`), and is **audited**.
- **Department-aware.** Rules are workspace/team-scoped; departments ship with recipe libraries (`25`).

## 2. Rule model

**`automation_rules`** = `trigger` + `conditions` (JSON predicate) + ordered `actions`, with
owner, scope (workspace/team), enable/disable, and a **dry-run** mode that logs would-be actions without
executing.

## 3. Triggers (`automation_trigger`)

`signal_received | score_changed | record_created | record_updated | list_entered | reply_received |
reveal_completed | schedule | manual` — sourced from the **domain-events catalog** (`20 §2`); `schedule`
runs on cron; `manual` is user-invoked from the grid (`24 §7`).

## 4. Conditions

A bounded predicate language over record/account/signal/score fields, `data_quality_score`/freshness
(`22`), list/segment membership, owner/team (`H18`), and entitlements — AND/OR groups, comparisons, recency
windows. Evaluated against the triggering entity + context.

## 5. Actions (`automation_action`)

`enroll_sequence | assign_owner | assign_team | add_to_list | update_field | send_notification |
create_task | push_crm | send_webhook | adjust_score`. Actions compose in order; AI-content actions
(draft) require human review before send (`H19`, `23`). Each action is idempotent + audited (`08 §5`).

## 6. Execution, idempotency & ordering

- A `workers` consumer (`02 §2`, `20 §4`) evaluates rules on matching events; per-entity ordering holds
  (`20 §9`); cross-entity is concurrent.
- **Idempotency** on `(rule_id, event_id, entity_id)` prevents double-firing on re-delivery; external
  actions carry idempotency keys (`20 §5`).
- **`automation_runs`** (append-only, month-partitioned): rule, trigger event, evaluated conditions,
  actions taken, outcome — the observability + audit trail.

## 7. Guardrails

- **Suppression + reveal gating** on every contact-touching action (`H5`/`H1`).
- **Per-workspace/team rate limits** + loop/recursion guards (an action's event can't infinitely re-trigger
  its own rule); **per-team automation policies** in settings bound allowed triggers/actions (`12`,
  `25 §8`).
- **Budgets:** reveal/enrich/AI actions debit per-team budgets (`H2`/`H18`); hard-cap blocks.
- **Bulk-origin safety:** triggers from a bulk import are **suppressed/batched by default** and never
  auto-enroll or fire billable side-effects per row (`§10`).
- **Dry-run + staged enable** before a rule goes live.

## 8. Recipe / play library

Prebuilt, parameterized plays seed departments (`25`): lead/account **routing**, **SDR→AE handoff**,
**signal-to-play** (funding/job-change/tech-install → outreach), **champion-change** (CS), **whitespace**
(BDR), **data-hygiene** (Ops, `22`), **budget-alert** (Finance), **DSAR/suppression** (Compliance). AI can
**suggest** a play; a human enables it.

## 9. Surfaces

Build/manage in a Settings automation surface (`12`); status + history on Home/Reports per department;
live run status via SSE (`20 §8`). API + webhooks expose runs (`09`, `26`).

## 10. Safe-by-default automation for bulk-origin records

A million-row CSV import ([30](./30-bulk-import-export-pipeline.md),
[ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)) emits a burst of
`record.created`/`record.updated`. Treated like single-record edits, it would fan out a million
`enroll_sequence`/send/enrich actions — a runaway, billable side-effect. The principle is **safe-by-default
side effects**: a bulk load **must not** auto-enroll rows into active sequences or fire billable actions.
**Promotion to active is deliberate** — a human explicitly opts a reviewed batch into a sequence; the import
itself is inert for automation.

- **Bulk-origin signal.** `record.created`/`record.updated` from an import carry an `origin: bulk_import`
  flag with the `import_batch_id` (and the same flag rides the job-level `import.completed` event, `20 §2`).
  This is set by the bulk pipeline (`30`), not by automation. The **event-coalescing mechanism that batches
  or collapses the burst lives in [20](./20-event-driven-realtime-backbone.md)** — automation is a
  consumer of the coalesced stream, not the coalescer.
- **Default trigger behaviour for bulk-origin events:**
  - `enroll_sequence` and other billable/contact-touching actions (send, reveal, enrich, `push_crm`,
    `send_webhook`) **do not fire per row.** A rule whose trigger matches a `bulk_import`-origin event is
    **suppressed** unless it is explicitly marked **bulk-safe** by the rule owner.
  - Non-billable, idempotent actions (`add_to_list`, `update_field`, `adjust_score`, `assign_owner`) may run
    but are **batched**, not per-row, when the trigger is bulk-origin.
  - The suppressed/deferred decision is recorded in `automation_runs` (outcome = `skipped:bulk_origin`) so it
    is auditable, not silent.
- **Deliberate promotion.** Acting on an imported batch is a separate, explicit step: the user selects the
  reviewed batch (or a saved segment over it) and enrolls it via a `manual` trigger (`§3`) or a one-off
  bulk action from the grid (`24 §7`). Promotion re-checks **suppression + reveal gating** (`H5`/`H1`) and
  debits budgets per action, exactly as a normal enrollment does.
- **Guardrail / quota interaction (anti-fan-out).** Even a bulk-safe rule is bounded so a deliberate
  promotion can't melt the system:
  - The **per-workspace/team rate limits and loop guards** (`§7`) apply to the promoted batch; enrollment is
    metered through the automation queue (`20 §4`) at the configured throughput, not all at once.
  - **Budgets/quotas** (`H2`/`H18`) are checked **in-tx per action**; a `hard_cap` team is **blocked at
    budget** part-way through a batch rather than overshooting — the remainder is reported as
    `blocked:budget` in `automation_runs`. **Billing safety and the per-team budget/hard-cap model are owned
    by [07](./07-billing-credits.md)**; this section only defers to them.
  - A **batch-enrollment cap** (per-team policy, `12`/`25 §8`) bounds how many records one promotion may
    enroll; exceeding it requires an explicit confirm/admin override, surfaced before the action runs (not
    after the fan-out).

## Links
- **Links to:** [20](./20-event-driven-realtime-backbone.md), [03 §6/§7/§14](./03-database-design.md), [05 §13](./05-features-modules.md),
  [22](./22-data-quality-freshness-lifecycle.md), [23](./23-ai-intelligence-layer.md), [24](./24-advanced-search-exploration-ux.md),
  [25](./25-departments-teams-workspaces.md), [26](./26-integrations-data-delivery.md), [09](./09-api-design.md),
  [12](./12-settings.md), [08 §5](./08-compliance.md), [ADR-0026](./decisions/ADR-0026-workflow-automation-engine.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [05](./05-features-modules.md), [25 §7](./25-departments-teams-workspaces.md), README

## Open questions
1. Condition language: JSON-logic vs. a small expression DSL; UI builder depth at GA.
2. Visual no-code builder vs. recipe+form at GA (`ADR-0026` revisit).
3. Automation-action cost controls default per plan tier (`07`/`12`).
