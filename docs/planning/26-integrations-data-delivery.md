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

- Central export surface: CSV/Sheets, scheduled exports, history; **policies**: per-workspace/team **row
  caps + frequency limits + approval** for large exports (closes the export-governance gap, `12`).
- Every export is suppression-checked, audited (`08 §5`), and delivered via signed expiring S3 URLs
  (`05 §12`).

## Links
- **Links to:** [05 §12/§14/§15](./05-features-modules.md), [09 §8/§10](./09-api-design.md), [20](./20-event-driven-realtime-backbone.md),
  [24 §6](./24-advanced-search-exploration-ux.md), [27](./27-workflow-automation-engine.md), [12 §3/§5](./12-settings.md),
  [08 §5/§6](./08-compliance.md), [ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [05 §14](./05-features-modules.md), [09 §10](./09-api-design.md), README

## Open questions
1. Native CRM app scope (full in-CRM reveal vs. notifications) + marketplace listing timing.
2. Reverse-ETL build vs. partner (Hightouch/Census) for warehouse activation.
3. SMS compliance scope (TCPA consent capture, opt-out sync to suppression) before enablement.
