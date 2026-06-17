# LeadWolf — Planning Workspace

This folder holds the complete design for **LeadWolf**, a **per-workspace multi-tenant prospecting
CRM** that lets sales teams **import, reveal, score, sequence, and send** to their own contacts and
accounts, on an **AWS-native self-hosted** stack.

> **Status:** Planning. No application code exists yet. These documents are the contract we agree on
> *before* implementation. Read them in order; each is self-contained but cross-links the others.

## How to read this

| # | Document | What it answers |
|---|---|---|
| 00 | [Overview](./00-overview.md) | What are we building, for whom, and why? Scope, personas, glossary, decision log. |
| 01 | [Tech Stack](./01-tech-stack.md) | What technologies, and how do they run on AWS? |
| 02 | [Architecture](./02-architecture.md) | How is the codebase and runtime organized? Services, data flow, tenancy. |
| 03 | [Database Design](./03-database-design.md) | The clean, smart schema: tenant/workspace tenancy, per-workspace entities, RLS, indexing, partitioning. |
| 04 | [UI/UX Design](./04-ui-ux-design.md) | The light/monochrome design system, IA, and key screens. |
| 05 | [Features & Modules](./05-features-modules.md) | Module-by-module functional specs. |
| 06 | [Enrichment Engine](./06-enrichment-engine.md) | Per-workspace provider enrichment, verification, lead-scoring, cost. |
| 07 | [Billing & Credits](./07-billing-credits.md) | Tenant credit counter, per-workspace reveal, Stripe top-ups, entitlements. |
| 08 | [Compliance](./08-compliance.md) | GDPR/CCPA, consent, suppression, DSAR, audit, retention. |
| 09 | [API Design](./09-api-design.md) | REST resource model, auth, idempotency, public-API seams. |
| 10 | [Roadmap](./10-roadmap.md) | Phased milestones (M0–M5 MVP + M7–M10 beyond), critical path, risks. |
| 11 | [Information Architecture](./11-information-architecture.md) | The customer-app surface: 6-destination single-page nav + per-surface features. |
| 12 | [Settings](./12-settings.md) | Tiered settings: user · workspace · tenant · developer (Billing & Credits here). |
| 13 | [Platform Admin](./13-platform-admin.md) | Internal super-admin console: tenants, billing, impersonation, abuse, data-quality. |
| 14 | [Phase 1 Execution](./14-phase-1-execution.md) | The build plan: how the M0 foundation + M1–M5 MVP get sequenced into a runnable app — scaffold order, per-milestone DoD, critical path, risks. |
| 15 | [Gap Remediation](./15-gap-remediation.md) | How the market-gap analysis maps to corpus decisions: 16 gaps + hidden opportunities + recommendations → remediation, ADR, milestone, status. |
| 16 | [Code Organization](./16-code-organization.md) | How source code is laid out on disk: app/package internals, the dependency graph, barrel strategy, naming, file-size, testing, config — the engineering conventions. |
| 17 | [Authentication](./17-authentication.md) | The `auth.truepoint.in` identity service: progressive identifier-first login, cross-domain tokens, MFA, SSO/SCIM, trusted devices, auth policy. |
| 18 | [Scalability & Performance](./18-scalability-performance.md) | SLOs/latency budgets, capacity model, caching, read-scaling, Citus cutover, backpressure, load tests. |
| 19 | [Observability & Reliability](./19-observability-reliability.md) | Telemetry, SLO/error budgets, alerting, incident response, DR, chaos, FinOps cost attribution. |
| 20 | [Event-Driven & Real-Time Backbone](./20-event-driven-realtime-backbone.md) | Domain events, transactional outbox, queues/DLQ, idempotency, CDC, SSE/WebSocket. |
| 21 | [Data Acquisition & Sourcing](./21-data-acquisition-sourcing.md) | Source channels, ingestion cadence, provider vetting/DPA, lawful-basis lineage, co-op. |
| 22 | [Data Quality, Freshness & Lifecycle](./22-data-quality-freshness-lifecycle.md) | `data_quality_score`, freshness SLAs, re-verification, coverage/ER targets, retention. |
| 23 | [AI & Intelligence Layer](./23-ai-intelligence-layer.md) | Claude behind `AiPort`: NL search, copilot, drafting, research agent, RAG, guardrails. |
| 24 | [Advanced Search & Exploration UX](./24-advanced-search-exploration-ux.md) | Search-box facets with typeahead from indexed values, abbreviation/synonym expansion (CEO→Chief Executive Officer), faceted filters, saved views, smart segments, instant masked search, result actions. |
| 25 | [Departments, Teams & Workspaces](./25-departments-teams-workspaces.md) | Teams-in-workspace, personas, record-visibility, per-team budgets, dashboards → departments/. |
| 26 | [Integrations & Data Delivery](./26-integrations-data-delivery.md) | CRM sync + native apps, webhooks, reverse-ETL, Chrome extension, SMS, export center. |
| 27 | [Workflow Automation Engine](./27-workflow-automation-engine.md) | Trigger→condition→action plays, recipe library, guardrails, `automation_runs`. |
| 28 | [Enterprise Readiness Audit](./28-enterprise-readiness-audit.md) | Full-corpus audit overlay: per-module gaps, automation/AI/scale/performance/observability audits, drift findings, prioritized gap register. |
| 29 | [Settings & Administration Architecture](./29-settings-administration-architecture.md) | The complete settings catalog (defaults, roles, impact, audit) + administration roles and approval workflows — companion to 28. |
| 30 | [Bulk Import/Export Pipeline](./30-bulk-import-export-pipeline.md) | How do million-row CSV imports/exports run accurately at scale? Async job via presigned/multipart upload + AV scan, streaming parse + COPY-to-staging + ON CONFLICT upsert, three-way per-row accounting + rejected-rows report, resumable/revertible job state machine, snapshot-consistent export, mapping templates. |
| 31 | [Bulk Enrichment Pipeline](./31-bulk-enrichment-pipeline.md) | Match-first bulk CSV enrichment at scale: upload → match against our data → enrich/verify → download (runs on the doc-30 job substrate). |
| — | [Audit-log Action Enum](./audit-log-enum.md) | Living reference for the closed `audit_log.action` vocabulary: as-built values, naming convention, write-path coverage, G-CMP-1 history, and the per-milestone evolution plan. |
| — | [Department Modules](./departments/) | Per-department specs: Sales, SDR, BDR, Marketing, CS, Support, Ops/RevOps, Compliance, Finance, HR, Admin. |
| — | [Brand Identity](./brand-identity.md) | Name/meaning, positioning, voice, logo, color, type — the LeadWolf brand system. |
| — | [Decisions (ADRs)](./decisions/) | The *why* behind load-bearing choices. |

## The one-paragraph pitch

Sales teams waste time on stale, incomplete contact data scattered across tools. LeadWolf gives each
team a **workspace** where they **import** contacts and accounts (CSV/CRM, Sales Navigator) and
**enrich** them through external providers (Apollo, ZoomInfo, Clearbit). Each workspace curates its own
**overlay** copies over a shared **global master graph** that everyone searches and reveals from
([ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)). Users spend **tenant credits** to **reveal** a contact's
verified email + phone (per-workspace, first-reveal-wins), **score** prospects by ICP fit and intent,
then **sequence** and **send** outreach from the built-in engine. **Suppression/DNC and GDPR/CCPA
compliance** (consent, unsubscribe, DSAR) gate both reveals and sends — built into the core, not
bolted on.

## Locked decisions (summary)

**Hono on Bun** (tRPC + REST) · Turborepo + Bun workspaces · Next.js 15 · **Drizzle + Aurora
PostgreSQL Serverless v2 + RDS Proxy** (Citus-sharded at scale) · ElastiCache Redis + BullMQ ·
**Typesense (overlay) + OpenSearch (global master graph)** ·
**Lucia auth (self-built)** · **shadcn/ui + Tailwind v4**, clean light theme · **per-workspace
tenancy** ([ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md)) · **tenant credit
counter** ([ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md)) · **outreach
send engine** ([ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md)) · GDPR+CCPA from
day one · **AWS-native self-hosted**
([ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md)) · **transparent no-lock-in billing**
([ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md)) ·
**charge-only-for-verified-data + credit-back**
([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)) · **trust & certification
program** ([ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md)) · **entity resolution via
Splink** ([ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md)) ·
**dedicated auth origin (`auth.truepoint.in` IdP) + cross-domain tokens**
([ADR-0016](./decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md)) ·
**progressive identifier-first login**
([ADR-0017](./decisions/ADR-0017-progressive-identifier-first-login-and-domain-tenant-routing.md)) ·
**auth policy / MFA enforcement** ([ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)) ·
**global identity + tenant membership**
([ADR-0019](./decisions/ADR-0019-global-identity-and-tenant-membership.md)) ·
**existence-revealing identifier-first + registration**
([ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md)) ·
**global master graph + per-workspace overlay**
([ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)) ·
**departments as intra-workspace teams**
([ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)) ·
**AI on Anthropic Claude**
([ADR-0023](./decisions/ADR-0023-ai-provider-and-intelligence-architecture.md)) ·
**performance SLOs & capacity**
([ADR-0024](./decisions/ADR-0024-performance-slos-and-capacity-model.md)) ·
**data-freshness lifecycle**
([ADR-0025](./decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md)) ·
**workflow automation engine**
([ADR-0026](./decisions/ADR-0026-workflow-automation-engine.md)) ·
**event backbone & real-time**
([ADR-0027](./decisions/ADR-0027-real-time-delivery-and-event-backbone.md)) ·
**record customization (custom fields/stages/tags)**
([ADR-0028](./decisions/ADR-0028-record-customization-layer.md)) ·
**credit ledger + leases**
([ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md)) ·
**tenant org roles**
([ADR-0030](./decisions/ADR-0030-granular-tenant-org-roles.md)) ·
**auth-event audit tenancy**
([ADR-0031](./decisions/ADR-0031-auth-event-audit-tenancy.md)) ·
**bootstrap platform super-admin** *(interim)*
([ADR-0034](./decisions/ADR-0034-bootstrap-platform-admin.md)) ·
**search query semantics + autocomplete + filter architecture** (typeahead from indexed values,
synonym/abbreviation expansion, ClickHouse facet counts)
([ADR-0035](./decisions/ADR-0035-search-query-and-filter-architecture.md)) ·
**bulk async import/export via staging-table pipeline** (presigned-S3 → stream-from-S3 →
COPY-to-staging → ON CONFLICT upsert; idempotent/checkpointed/resumable behind the imports queue + DLQ)
([ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)) ·
**match-first bulk CSV enrichment pipeline**
([ADR-0039](./decisions/ADR-0039-bulk-enrichment-pipeline.md)) ·
**bulk match-first resolution + candidate index**
([ADR-0037](./decisions/ADR-0037-bulk-match-first-resolution-and-candidate-index.md)) ·
**bulk enrichment billing, forecast & quota**
([ADR-0038](./decisions/ADR-0038-bulk-enrichment-billing-forecast-and-quota.md)).

See [00-overview.md](./00-overview.md#7-decision-log) for the full decision log with rationale links,
and the [ADR index](./decisions/) for [ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md),
[ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md),
[ADR-0008](./decisions/ADR-0008-lead-scoring-model.md),
[ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md),
[ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md),
[ADR-0012](./decisions/ADR-0012-transparent-no-lock-in-commercial-policy.md),
[ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md),
[ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md),
[ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md),
[ADR-0016](./decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md),
[ADR-0017](./decisions/ADR-0017-progressive-identifier-first-login-and-domain-tenant-routing.md),
[ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md),
[ADR-0019](./decisions/ADR-0019-global-identity-and-tenant-membership.md),
[ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md),
[ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md),
[ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md),
[ADR-0023](./decisions/ADR-0023-ai-provider-and-intelligence-architecture.md),
[ADR-0024](./decisions/ADR-0024-performance-slos-and-capacity-model.md),
[ADR-0025](./decisions/ADR-0025-data-freshness-decay-and-reverification-lifecycle.md),
[ADR-0026](./decisions/ADR-0026-workflow-automation-engine.md),
[ADR-0027](./decisions/ADR-0027-real-time-delivery-and-event-backbone.md),
[ADR-0028](./decisions/ADR-0028-record-customization-layer.md),
[ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md),
[ADR-0030](./decisions/ADR-0030-granular-tenant-org-roles.md),
[ADR-0035](./decisions/ADR-0035-search-query-and-filter-architecture.md),
[ADR-0039](./decisions/ADR-0039-bulk-enrichment-pipeline.md),
[ADR-0037](./decisions/ADR-0037-bulk-match-first-resolution-and-candidate-index.md), and
[ADR-0038](./decisions/ADR-0038-bulk-enrichment-billing-forecast-and-quota.md).
