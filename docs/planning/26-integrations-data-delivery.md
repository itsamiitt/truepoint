# 26 — Integrations & Data Delivery

> How data **leaves** LeadWolf and connects to the customer's stack: bidirectional CRM sync + native apps,
> public API, webhooks, reverse-ETL, a Chrome extension, SMS, and a governed export center — all under the
> **no-lock-in** policy ([ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md)).
> Extends [05 §14/§15](./05-features-modules.md) and the webhook seams in [09 §10](./09-api-design.md).

## 1. Principles

- **No lock-in.** Customers can **export and leave** without penalty; delivery is neutral and open
  ([ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md), `15`).
- **Compliance-gated.** Every export/sync is suppression-checked (`H5`), reveal-respecting (`H1`), and
  audited (`08 §5`); only revealed/owned data leaves.
- **Event-driven.** Outbound delivery rides the event backbone (`20`) for reliability + idempotency.

## 2. CRM sync & native apps

| Target | Capability | Milestone |
|---|---|---|
| Salesforce / HubSpot / Pipedrive | OAuth connect, field mapping, **bidirectional** sync, conflict handling, `integrations` table | M10 (`05 §14`) |
| **Native SFDC / HubSpot apps** | in-CRM sidebar: search, reveal, push, freshness badge | post-M10 |

Conflict policy + mapping configurable per workspace (`12 §3`); unified-integration-API (e.g. Merge.dev)
remains the documented alternative (`05 §14` open question).

## 3. Public REST API (delivery)

API-key-authenticated, tenant-scoped: search, reveal (metered), pull records, manage lists/segments;
idempotent (`Idempotency-Key`), rate-limited + quota'd per tenant, OpenAPI-documented ([09 §8](./09-api-design.md)).
Streaming endpoints (SSE) for live updates (`20 §8`).

## 4. Webhooks (outbound)

Subscriptions to domain events (`20 §2`): `reveal.completed`, `score.updated`, `outreach.status_changed`,
`signal.received`, `verification.completed`, auth events. Signed payloads, delivery log + retries + DLQ
(`09 §10`, `20 §4`); used by automation (`27`) and customer systems.

## 5. Reverse-ETL / warehouse sync

Push segments/records to the customer's **warehouse** (Snowflake/BigQuery/Redshift) and **activation**
tools (MAP/ads) — scheduled or segment-triggered (`24 §6`, `27`). The portability backbone behind the
no-lock-in promise; suppression + visibility enforced at export.

## 6. Chrome extension

In-browser prospecting: on a company site / LinkedIn / Sales-Nav (HITL, `06 §8`), show a hover card,
**reveal** (metered), and **add-to-workspace/list** with dedup. Honors entitlements + per-team budgets +
suppression. (Scope-controlled; complements, not replaces, the app.)

## 7. SMS channel & messaging apps

- **SMS outreach** as an outreach channel (`05 §13`) via a provider (e.g. Twilio), consent + TCPA/`H5`
  gated, audited — extends sequences beyond email/LinkedIn.
- **Slack/Teams app**: notifications (replies, alerts, budget, automation) + light actions (reveal/lookup,
  approve AI draft, `23`/`H19`).

## 8. Export center & governance

Central surface for **CSV/Sheets** exports — one-off and **scheduled/recurring** — plus history. The
**generation mechanics** (streaming millions of rows off replicas/ClickHouse to S3 in bounded memory,
job staging, resumable parts) live in the shared bulk pipeline ([30](./30-bulk-import-export-pipeline.md),
[ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)); this section owns only the
**delivery, scheduling, and governance** layered on top. The export **results API contract** (`/exports`
create/status/download) is owned by [09 §3](./09-api-design.md#3-key-endpoints-sketch); throughput SLOs
(import/export enqueue p95, streamed-export budgets) by [18 §2/§6](./18-scalability-performance.md#2-slos--latency-budgets);
the actual **row-cap + frequency numbers** by [12 §3](./12-settings.md#3-workspace-settings-owneradmin--free-multi-workspace-team)
(placeholders pending pricing — never hardcoded here).

### 8.1 Scheduler & recurrence

- A **schedule** (`export_schedules` / `import_schedules`*) pins a saved query/list or import source to a
  **recurrence** (`cron` + IANA `timezone`, or a simple `frequency` enum — `daily/weekly/monthly`), a
  **destination** (§8.2), an output **format** (`csv` | `sheets`), and column/field mapping. A scheduler
  enqueues the run onto the bulk-job queue ([30](./30-bulk-import-export-pipeline.md)); the run rides the
  event backbone for at-least-once dispatch + idempotency (`20 §3/§5`).
- **Skip-if-running overlap guard:** each schedule holds **at most one active run**. Before enqueue, a run
  takes a per-schedule **lease** (advisory lock / unique `(schedule_id, status='running')`); if the prior
  run hasn't finished, the new tick is **skipped** (recorded `skipped_overlap` in history), never queued
  behind it — so a slow million-row job can't stack copies of itself.
- **History:** every tick (run/skip/fail) is recorded with row counts, duration, and outcome, surfaced in
  the export center and audited (`08 §5`).

### 8.2 Destinations

- **Download (default).** Emailed **expiring link** to a signed, short-TTL S3 object (`05 §12`); recurring
  runs email a fresh link per tick. Link expiry is policy-bounded; the object is lifecycle-pruned after TTL.
- **Google Sheets.** Per-workspace **OAuth** connect (`integrations` token, `12 §3`); the worker writes
  rows via the Sheets API into a target spreadsheet/tab (create-or-append), chunked to stay within Sheets
  API quotas and cell limits — large result sets fall back to a download link with a note.
- **S3 / SFTP drop.** Customer-owned bucket (assumed-role/bucket-policy) or SFTP endpoint as a recurring
  **export drop** *and* a recurring **import pickup** (poll a prefix/folder; ingest new files via the same
  staging pipeline, `30`). Credentials are stored as a workspace `integrations` connection; never logged.
- Reverse-ETL/warehouse destinations remain in §5; the scheduler is shared.

### 8.3 Governance

- **Policies** (per-workspace/team): **row caps + frequency limits + approval** for large exports/imports
  ([12 §3](./12-settings.md#3-workspace-settings-owneradmin--free-multi-workspace-team)). A job over the
  configured threshold enters an **approval gate** (`pending_approval`) and only runs once a workspace
  `admin`+ approves — applies equally to a large **import** ([30](./30-bulk-import-export-pipeline.md))
  and a large/recurring export. Approval, run, and link issuance are audited.
- **Per-tenant fairness:** bulk jobs share the per-tenant queue quotas + backpressure that keep one
  tenant from starving others ([18 §9](./18-scalability-performance.md#9-rate-limiting-quotas--backpressure)).
- Every export is **suppression-checked** (`H5`), **reveal-respecting** (only owned/revealed fields leave,
  `H1`), and **audited** (`08 §5`) — checks re-run **per tick**, not just at schedule creation, so policy
  changes between ticks take effect.

`*` `export_schedules` / `import_schedules` (+ `bulk_jobs`) are a follow-up [03](./03-database-design.md)
amendment owned by the bulk pipeline ([ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)).

## Links
- **Links to:** [05 §12/§14/§15](./05-features-modules.md), [09 §3/§8/§10](./09-api-design.md), [20](./20-event-driven-realtime-backbone.md),
  [24 §6](./24-advanced-search-exploration-ux.md), [27](./27-workflow-automation-engine.md), [12 §3/§5](./12-settings.md),
  [18 §2/§6/§9](./18-scalability-performance.md), [08 §5/§6](./08-compliance.md),
  [30](./30-bulk-import-export-pipeline.md), [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md),
  [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [05 §14](./05-features-modules.md), [09 §10](./09-api-design.md), README

## Open questions
1. Native CRM app scope (full in-CRM reveal vs. notifications) + marketplace listing timing.
2. Reverse-ETL build vs. partner (Hightouch/Census) for warehouse activation.
3. SMS compliance scope (TCPA consent capture, opt-out sync to suppression) before enablement.
4. Export scheduler scope at first ship — Google Sheets + download only, or S3/SFTP drop in the same
   milestone — and whether import pickup (§8.2) lands with it or follows ([30](./30-bulk-import-export-pipeline.md)).
