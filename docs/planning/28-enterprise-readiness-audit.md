# 28 — Enterprise Readiness Audit

> A **full-corpus audit** of the existing plan ([00](./00-overview.md)–[27](./27-workflow-automation-engine.md),
> [departments/](./departments/), ADR-0001–0027) against a category-leading enterprise-SaaS bar: millions of
> prospects/companies, **billions of activities**, thousands of concurrent agents, **10,000+ concurrent
> users**, multi-tenant, global, HA, near-real-time. Like [14](./14-phase-1-execution.md)/[15](./15-gap-remediation.md)
> this is an **overlay**: it records findings and recommendations — it changes **no** locked decision and
> invents **no** milestone scope. Each gap carries an ID (`G-…`) and a priority; the consolidated register is
> §12. The companion **settings + administration architecture** is [29](./29-settings-administration-architecture.md).

## 1. Scope, method & verdict

**Audited:** every planning doc (00–27), the 11 department modules, the ADR registry, and the wiring
points (decision log, feature↔milestone matrix, risk register, shared vocabulary).

**Method.** Each module is graded on the 20 audit dimensions — features, workflows, settings, permissions,
automation, AI, reports, APIs, enterprise features, performance, scalability, security, compliance, UX,
data, architecture. Per module: a **Current coverage** verdict, then a **gap table** whose `Class` column
names the dimension; **Recommended settings** live in [29](./29-settings-administration-architecture.md)
(referenced per module). Cross-cutting audits follow: automation (§4), AI (§5), scalability (§6),
performance (§7), observability (§8), enterprise readiness (§9), security/compliance controls (§10),
corpus consistency (§11), and the prioritized register (§12).

**Verdict (summary).** The plan is **unusually strong** for its stage — the money path, compliance gating,
tenancy/RLS, auth, event backbone, SLOs, and AI guardrails are specified to a depth most shipped products
lack. The audit still finds **~110 gaps**: **7 Critical**, **~35 High**. The Critical theme is consistent:
the plan is excellent at the *platform spine* and thin on **operating an enterprise customer at scale** —
record customization (custom fields/stages), the credit counter's audit/throughput ceiling, audit-enum
coverage of record/settings mutations, reply/mailbox ingestion for Inbox, breach-notification duty,
granular tenant administration, and i18n for global deployments.

| Priority | Count | Meaning |
|---|---|---|
| **Critical** | 7 | Blocks enterprise GA or contradicts a stated guarantee |
| **High** | ~35 | Expected by enterprise buyers / breaks at 10× scale |
| **Medium** | ~50 | Competitive completeness; schedule within named milestones |
| **Low** | ~20 | Differentiating polish; backlog |

## 2. Executive summary — the critical gaps

| ID | Gap | Why Critical | Suggested owner |
|---|---|---|---|
| G-REV-5 | **No custom fields** on contacts/accounts (definitions, types, validation, search/import/CRM mapping) | Table-stakes for any CRM-shaped product; blocks CRM sync fidelity (M10), import mapping, segments, automation conditions | new pre-M10 scope |
| G-CMP-1 | **Closed audit `action` enum omits record CRUD, settings, list/sequence/automation/AI admin events** — yet [02 §6](./02-architecture.md) promises "every mutating, externally-meaningful action is audited" | The compliance wedge is the brand; the enum as specified cannot satisfy the promise; SOC 2 evidence gap | M5 |
| G-BIL-1 | **Counter without ledger at enterprise GA** — acknowledged in [07 §2](./07-billing-credits.md) as a known risk, with no committed trigger date | Enterprise finance + SOC 2 auditors require replayable balance history; disputes are manual archaeology | commit ledger ≤ M11 |
| G-BIL-2 | **Tenant-counter hot row**: `FOR UPDATE` on one `tenants` row serializes *every* reveal tenant-wide | At thousands of concurrent agents in one tenant, reveal throughput collapses to single-row lock throughput | M12 |
| G-INT-1 | **No reply/mailbox-ingestion architecture** (Gmail/Microsoft OAuth sync or inbound routing, threading) | Inbox (M9) shows "unified replies" with no specified way for replies to enter the system | M9 design gate |
| G-AUTH-10 | **Tenant administration is one boolean** (`is_tenant_owner`); no granular org roles (billing/security/compliance admin) — [12 §1](./12-settings.md) already names a "billing admin" that has no schema | Enterprise delegated administration is a named buying gate; also a vocabulary drift | M11 |
| G-UX-1 | **No i18n/l10n architecture** (UI strings, locale formats, template localization) | "Global deployments" is a stated bar; retrofitting i18n is famously expensive | pre-M11 decision |

A breach-notification workflow (G-CMP-2) sits just below Critical only because it is procedural rather
than architectural — it is a **legal duty** (GDPR 72 h) and must exist before GA.

## 3. Module-by-module audit

Format per module: **Current coverage** (what the plan already does well) → gap table
(`Class` = audit dimension; `Prio` ∈ Critical/High/Medium/Low) → settings pointer → module priority.

### 3.1 Auth & identity ([17](./17-authentication.md), [05 §1](./05-features-modules.md))

**Current coverage — excellent.** Dedicated IdP origin + PKCE token exchange, progressive
identifier-first login, global identity/multi-org, MFA incl. passkeys + recovery codes, SAML/OIDC + JIT +
SCIM, trusted devices, strictest-wins auth policies, lockout/bot/impossible-travel layers, full auth audit
vocabulary. Few products plan auth this completely.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-AUTH-1 | No **user offboarding workflow**: removing/deactivating a member does not reassign owned records (`owner_user_id`), sequences, lists, tasks; no leaver checklist | Workflow | Define an offboarding flow: pick a successor → bulk-reassign ownership/enrollments → revoke sessions/keys → audit; wire as an automation recipe | High |
| G-AUTH-2 | Tenant/workspace admins cannot **list/revoke a member's sessions** or force re-auth (staff-only via [13 §3](./13-platform-admin.md)) | Permission | Add admin session management (`/settings/tenant/members/:id/sessions`) with `session.revoked` audit | High |
| G-AUTH-3 | **Email-change flow** for the global identity unspecified (re-verify old+new, grace window, notify both, SSO-domain implications) | Workflow | Specify in 17 §2; emit `user.email_changed` audit + security notification | Medium |
| G-AUTH-4 | **SCIM groups → teams/workspaces** mapping absent (SCIM does users only) | Enterprise | Support SCIM Groups push mapped to `teams`/`workspace_members` per a mapping table | High |
| G-AUTH-5 | No **service accounts** (non-human identities) for automations/integrations — only tenant-scoped `api_keys` | Security | Add scoped service accounts (own credentials, rotation, least-privilege, attributable audit actor) | Medium |
| G-AUTH-6 | No **break-glass org recovery** (all tenant owners locked out / left company) | Workflow | Documented verified-recovery procedure via platform staff with dual-control + audit | Medium |
| G-AUTH-7 | Progressive lockout has no **self-service or admin unlock** path | UX | Time-decay + verified-email unlock + admin unlock action | Medium |
| G-AUTH-8 | Risk signals (impossible travel, new geo) alert **only the user**, not tenant security admins | Security | Route high-risk auth events to tenant security-admin notifications + webhook `auth.event` | Medium |
| G-AUTH-9 | No **SIEM streaming** of audit/auth events (M11 has batch export only) | Enterprise | Push integration (HTTPS/HEC formats: Splunk, Datadog, Sentinel) on the event backbone | High |
| G-AUTH-10 | **Granular tenant admin roles missing** — `is_tenant_owner` boolean only; "billing admin" named in [12 §1](./12-settings.md) without schema | Permission | Introduce `tenant_members.org_role` (or capability set): `owner`, `billing_admin`, `security_admin`, `compliance_admin`, `member` — see [29 §18](./29-settings-administration-architecture.md) | **Critical** |
| G-AUTH-11 | No **terms/DPA acceptance tracking** (who accepted which version, when) | Compliance | `policy_acceptances` (user, tenant, doc, version, ts); platform manages versions ([13 §3](./13-platform-admin.md)) | Medium |

Settings: [29 §13](./29-settings-administration-architecture.md). **Module priority: High** (G-AUTH-10 Critical).

### 3.2 Workspaces, tenancy & org governance ([05 §2](./05-features-modules.md), [25](./25-departments-teams-workspaces.md))

**Current coverage — strong.** Tenant→workspace chain, RLS isolation proven at the DB layer, default
workspace, limits, switcher UX, teams layered as authz.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-WS-1 | **Workspace lifecycle** beyond "create/archive" ([12 §4](./12-settings.md)) undefined: archive semantics, read-only state, purge timeline, export-before-delete | Workflow | Define archive → read-only (N days) → purge, with export + audit + restore window | High |
| G-WS-2 | No **workspace templates** (clone settings/sequences/views/automations) — agencies onboard each client workspace by hand | Feature | Template = serialized config bundle; apply on create; ties [29 §1](./29-settings-administration-architecture.md) | Medium |
| G-WS-3 | No governed **cross-workspace record transfer** (agency loses a client → move book; team re-org) | Feature | Audited transfer job (re-links overlay rows; reveal-state policy decided per [07](./07-billing-credits.md)) | Medium |
| G-WS-4 | No **per-workspace data quotas** (contact-count / storage caps per plan) or usage meters | Scale | Add quota entitlements + meters; enforce at import; surface in settings | Medium |
| G-WS-5 | No **tenant merge/split** path (M&A; two tenants consolidate) | Enterprise | Staff-run runbook + tooling (re-parent workspaces, merge members/credits, audit) | Low |
| G-WS-6 | No **org hierarchy above tenant** (multi-subsidiary enterprises: consolidated billing/reporting) | Enterprise | Optional `organizations` umbrella for rollup billing/reporting; defer until demanded | Low |
| G-WS-7 | No **sandbox tenant/workspace** for safe testing (automations, integrations, API) | Feature | Sandbox flag: isolated data, no sends/reveals against real credits, sandbox API keys ([09 §8](./09-api-design.md)) | Medium |

Settings: [29 §3](./29-settings-administration-architecture.md). **Module priority: Medium.**

### 3.3 Import & ingestion ([05 §3](./05-features-modules.md), [21](./21-data-acquisition-sourcing.md))

**Current coverage — good.** CSV/XLSX + manual + providers, column mapping, blind-index dedup with
new-vs-matched summary, idempotent re-runs, provenance per import, lawful-basis snapshot.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-IMP-1 | No **pre-commit validation preview** or **rejected-rows error file** (row-level errors downloadable) | Workflow | Staging pass → preview (counts, errors, dupes) → commit; reject file in S3 | High |
| G-IMP-2 | No **import undo/rollback** (a bad mapping pollutes a workspace permanently) | Feature | Revert-by-batch using `source_imports` rows within a window; audited | High |
| G-IMP-5 | **Conflict policy on matched duplicates** is silent last-writer-wins ([06 §4](./06-enrichment-engine.md)); no keep-existing/overwrite/review choice | Setting | Per-import + workspace-default conflict policy; review queue option | High |
| G-IMP-3 | No **saved mapping templates** per source; no AI auto-mapping (despite `extract_fields` existing in [23 §2](./23-ai-intelligence-layer.md)) | AI | Mapping templates + Claude-suggested column mapping with confidence | Medium |
| G-IMP-4 | No **scheduled/recurring imports** (S3/SFTP drop, Google Sheets) | Automation | `schedule` trigger → import action in [27](./27-workflow-automation-engine.md); S3-drop listener | Medium |
| G-IMP-6 | No **resumable/chunked uploads** or published size/row limits per plan | Scale | Multipart resumable upload; limits as entitlements; chunked worker processing | Medium |
| G-IMP-7 | No **approval gate** for very large imports (mirrors export approvals, [26 §8](./26-integrations-data-delivery.md)) | Permission | Threshold-based approval per [29 §19](./29-settings-administration-architecture.md) | Low |

Settings: [29 §14](./29-settings-administration-architecture.md). **Module priority: High.**

### 3.4 Enrichment, verification & data quality ([06](./06-enrichment-engine.md), [22](./22-data-quality-freshness-lifecycle.md))

**Current coverage — excellent.** Provider waterfall + cache + breakers + budgets, independent verifier
driving the charge, freshness SLAs + `data_quality_score` formula + re-verify jobs, global ER with review
queue, coverage targets with alerts.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-ENR-1 | No customer-facing **auto-enrich policy** (enrich on create? on reveal? scheduled? which fields?) — enrichment is system-initiated only | Setting | Workspace policy: triggers, field allowlist, monthly budget; see [29 §3](./29-settings-administration-architecture.md) | High |
| G-ENR-6 | **In-workspace duplicate review + merge/unmerge is staff-only** ([13 §3](./13-platform-admin.md)); customers can't resolve fuzzy dupes in their overlay | Feature | Customer merge UI (suggested pairs from `is_duplicate_of`; field-pick survivorship; un-merge; audited) | High |
| G-ENR-2 | **BYO provider keys** named in [12 §3](./12-settings.md) with no design (vaulting, health, cost attribution, waterfall interplay) | Feature | Encrypted per-workspace keys; BYO calls bypass platform budget; mark provenance | Medium |
| G-ENR-4 | No customer-visible **enrichment job status** surface (queued/running/failed per record/batch) | UX | Jobs panel + `enrichment.completed`/failed events to UI via SSE | Medium |
| G-ENR-3 | No **enrichment preview/estimate** ("what will likely fill") before spending | UX | Estimate from provider hit-rate stats (`provider_calls`) | Low |
| G-ENR-5 | No per-workspace **waterfall preference overrides** (pin/exclude providers) | Setting | Optional ordered preference list, bounded by platform `provider_configs` | Low |

Settings: [29 §3/§12](./29-settings-administration-architecture.md). **Module priority: High.**

### 3.5 Search & exploration ([24](./24-advanced-search-exploration-ux.md), [05 §6](./05-features-modules.md))

**Current coverage — excellent.** Faceted rail with include/exclude + boolean groups, intent/technographic
/quality facets, instant masked search, saved searches/views, smart segments, virtualized grid, cursor
pagination, ClickHouse facet counts.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-SRCH-1 | No **search analytics** (zero-result queries, abandoned filters, facet usage) to tune relevance/coverage | Report | PostHog/ClickHouse search-analytics dashboard; feeds [21 §8](./21-data-acquisition-sourcing.md) coverage strategy | Medium |
| G-SRCH-2 | No **synonym/typo-tolerance configuration** (title synonyms: "Head of Eng" ≈ "VP Eng") | Setting | Curated synonym sets (platform) + per-workspace additions; index-level fuzziness config | Medium |
| G-SRCH-4 | **Lookalike search unsurfaced** — pgvector embeddings exist ([23 §4](./23-ai-intelligence-layer.md)) but "more like this account/contact" is not a UX feature | AI | "Find similar" action on record detail + segments seeded by lookalikes | Medium |
| G-SRCH-5 | Universe saved-search **alert cadence + per-tenant QPS quotas** are open ([24](./24-advanced-search-exploration-ux.md), [18](./18-scalability-performance.md)) | Scale | Close: default quotas per tier; alert dedup window | Medium |
| G-SRCH-3 | No **relevance tuning controls** (recency/quality boosts) | Setting | Per-view sort presets incl. composite boost; platform-side relevance config | Low |

Settings: [29 §6](./29-settings-administration-architecture.md). **Module priority: Medium.**

### 3.6 Reveal, record detail & record model ([05 §7](./05-features-modules.md), [07 §3](./07-billing-credits.md))

**Current coverage — excellent on the money path.** Idempotent suppression-gated reveal, first-reveal-wins,
charge-by-verified-result + credit-back, provenance panel, no-surprise-spend UX.
**Weak on the record model itself** — the biggest product gap cluster in the corpus:

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-REV-5 | **No custom fields** on contacts/accounts: no definitions, types, validation, required-ness, search/filter, import/CRM mapping, API exposure | Feature | `custom_field_definitions` (workspace-scoped, typed: text/number/date/enum/multi/user/url) + `custom_field_values` (or typed jsonb + GIN); first-class in search facets, import mapping, CRM sync, automation conditions, exports | **Critical** |
| G-REV-7 | **`outreach_status` is a closed enum** — teams cannot model their own stages/pipelines | Feature | Keep the canonical enum (load-bearing vocab) and add a **custom stage layer**: workspace-defined stages each mapping to one canonical status; UI/boards/reports use stages | High |
| G-REV-6 | **No tags** (lightweight, cross-list labels with governance) | Feature | `tags` + `record_tags`; filterable; bulk-taggable; per-workspace tag management | High |
| G-REV-3 | **No record change history** (field-level diffs: who changed title/owner/status when) | Feature | `record_revisions` (or audit metadata diffs) + history panel; pairs with G-CMP-1 | High |
| G-REV-1 | **No bulk-reveal governance**: export caps exist ([26 §8](./26-integrations-data-delivery.md)) but reveals have no per-user daily caps or threshold approvals (insider scraping via reveal+screen) | Security | Per-user/team daily reveal caps + approval above N per action; anomaly alert exists ([07 §6](./07-billing-credits.md)) — add the preventive control | High |
| G-REV-2 | **No optimistic locking** on record edits (`updated_at` only) — concurrent edits silently lose updates | Data | `version int` + compare-and-set on PATCH; 409 with merge UX | Medium |
| G-REV-4 | **No recycle bin** — `deleted_at` soft-delete is "where needed" with no restore window/UX | Feature | 30-day trash for contacts/accounts/lists/sequences; restore + purge; DSAR delete bypasses trash | Medium |
| G-REV-8 | **Notes are not an entity** (only `note_added` activities): no rich text, edit, pin, @mention storage | Feature | `notes` table (record-scoped, mentions → notifications, team visibility) | Medium |

Settings: [29 §6](./29-settings-administration-architecture.md). **Module priority: Critical** (G-REV-5).

### 3.7 Lists, saved views & segments ([05 §8](./05-features-modules.md), [24 §5/§6](./24-advanced-search-exploration-ux.md))

**Current coverage — good.** Static/dynamic lists, shareable views, smart segments with scheduled refresh
driving automation.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-LST-3 | Share/edit permissions on views/segments lack an explicit **role model + audit** (who may share workspace-wide vs team) | Permission | Owner/editor/viewer on shared views; share events audited | Medium |
| G-LST-1 | No list **size limits, folders, or ownership transfer** (orphaned lists after offboarding — ties G-AUTH-1) | UX | Folders + transfer-on-offboard; soft caps per plan | Low |
| G-LST-2 | Segment **staleness indicator** (last refresh, next refresh) unsurfaced | UX | Freshness badge + manual refresh (rate-limited) | Low |

**Module priority: Low.**

### 3.8 Intelligence / lead scoring ([05 §9](./05-features-modules.md), [ADR-0008](./decisions/ADR-0008-lead-scoring-model.md), [23 §5](./23-ai-intelligence-layer.md))

**Current coverage — strong.** Versioned scores + breakdown, intent signals, rules→ML path with model
card + A/B, ICP/weights setting.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-SCR-1 | No **scoring preview/backtest** ("if I change weights, what re-ranks?") or score-distribution report | Report | Dry-run re-score on a sample + distribution/drift dashboards | Medium |
| G-SCR-2 | No documented **GDPR Art. 21/22 stance** for scoring/profiling (automated decision-making disclosure + objection path) | Compliance | Position statement in [08](./08-compliance.md): human-in-the-loop outreach ⇒ not solely-automated decisions; objection → suppression; counsel review | Medium |
| G-SCR-4 | Scoring config is **workspace-level only** — departments can't run distinct ICP profiles ([25](./25-departments-teams-workspaces.md) personas imply they should) | Setting | Optional per-team scoring profile (weights + ICP), default inherits workspace | Medium |
| G-SCR-3 | No **composite-score decay** policy (intent is 30-day rolling; engagement/composite staleness unspecified) | Feature | Decay engagement component by recency; document in ADR-0008 follow-up | Low |

Settings: [29 §3](./29-settings-administration-architecture.md). **Module priority: Medium.**

### 3.9 Activities & timeline ([05 §10](./05-features-modules.md))

**Current coverage — adequate.** Unified typed timeline, system + manual logging, monthly partitions,
`last_activity_at` maintenance.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-ACT-1 | **Billions-of-activities serving** unplanned: monthly Aurora partitions alone won't serve billions (the stated bar) for timeline + reporting | Scale | Tier: hot partitions on Aurora → ClickHouse as the analytical/serving store for aged activity → S3/Iceberg archive; timeline reads page hot+cold transparently | High |
| G-ACT-3 | **No calendar integration** (Google/Microsoft) — `meeting_held` has no source of truth; no scheduling links despite "book-meeting" conversions ([11 §4.4](./11-information-architecture.md)) | Feature | Calendar OAuth + scheduling-link service (or partner integration); meetings sync to activities | High |
| G-ACT-2 | Activity `outcome` is free-form/enum-thin; no **custom outcomes taxonomy** per workspace | UX | Outcome sets per activity_type, workspace-configurable (pairs with G-REV-7 stage layer) | Low |

**Module priority: High.**

### 3.10 Credits & billing ([07](./07-billing-credits.md))

**Current coverage — strong on correctness.** Idempotent counter mutations, webhook-only grants,
charge-by-result + credit-back, reconciliation worker, abuse guards, team budgets, no-lock-in policy.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-BIL-1 | **Ledger reintroduction has no committed trigger** — the counter's missing `balance == SUM(delta)` invariant, refund history, and replayable audit are accepted risks ([07 §2/§8](./07-billing-credits.md)) that enterprise finance + SOC 2 will not accept | Architecture | Commit the append-only ledger (ADR-0004 revival per ADR-0007's *Revisit if*) **no later than M11** (enterprise settings); counter becomes the read cache | **Critical** |
| G-BIL-2 | **Tenant-counter hot row**: every reveal tenant-wide serializes on one `FOR UPDATE` row; same pattern on `team_credit_budgets` per team/period | Scale | Credit **leases/sub-pools** (workspace- or team-level pre-allocated blocks decremented locally, reconciled async) or sharded counter; keep invariants via the ledger (G-BIL-1) | **Critical** (at 100×; High now) |
| G-BIL-3 | No **enterprise procurement**: invoicing/PO + net-terms, multi-currency, tax (VAT/GST), billing contacts/addresses | Enterprise | Stripe Invoicing/Tax (or ERP export) + billing-contact roles (ties G-AUTH-10) | High |
| G-BIL-4 | No **per-user spend caps** or reveal-spend approval thresholds (budgets are team-level) | Setting | Optional per-member monthly cap + approval over threshold; [29 §3](./29-settings-administration-architecture.md) | Medium |
| G-BIL-5 | No **burn forecasting** (EOM projection, budget-exhaustion ETA) | AI | Forecast tile on Home/Finance dashboards; alert at projected overrun | Medium |
| G-BIL-6 | **Customer-side dunning** UX unspecified (platform-side exists, [13 §4](./13-platform-admin.md)): failed-payment notices, grace period, feature degradation order | Workflow | Document grace policy + in-app banners + restricted-mode definition | Medium |
| G-BIL-7 | Budget **rollover/transfer** policy between periods/teams undefined | Setting | Explicit rollover flag per budget; transfers audited (`credit.adjust`) | Low |

Settings: [29 §3](./29-settings-administration-architecture.md) (budgets) / [12 §4](./12-settings.md). **Module priority: Critical.**

### 3.11 Export, integrations & public API ([26](./26-integrations-data-delivery.md), [09](./09-api-design.md), [05 §12/§14/§15](./05-features-modules.md))

**Current coverage — strong direction.** Governed export center, bidirectional CRM + native apps,
reverse-ETL, Chrome extension, SMS, webhooks with signing/retries/DLQ, OpenAPI, CRM-neutral positioning.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-INT-1 | **Reply/mailbox ingestion architecture missing**: sends go out via SES/connected identity, but nothing specifies how replies are captured (Gmail API / Microsoft Graph OAuth sync, scopes, threading, polling vs push, dedup into `activities`/Inbox) | Architecture | Design doc before M9: mailbox connection service (OAuth, watch/subscriptions), thread matcher, bounce/auto-reply classification; `sending_identities` extended with read scopes | **Critical** |
| G-INT-2 | No customer-facing **integration health** (sync errors, last run, row counts, backlog) + failure alerting | Report | Health panel per connection + `integration.failed` notifications/webhooks | High |
| G-INT-4 | Public API lacks **batch endpoints** (bulk search/reveal/enrich), a customer **usage dashboard**, and published per-scope quotas | API | `/contacts/reveal:batch` (idempotent per item), usage page from metering, quota docs per tier | High |
| G-INT-6 | No **iPaaS connectors** (Zapier/Make/n8n) — cheapest breadth for SMB automation | Feature | Zapier app over public API + webhooks post-M10 | Medium |
| G-INT-3 | CRM **mapping governance** thin: mapping versioning, per-field direction, test/sandbox sync, dry-run diff | Setting | Mapping editor with dry-run diff + version history | Medium |
| G-INT-5 | Webhook **replay/self-test** missing (delivery log exists) | UX | Test-fire + redrive-from-log per subscription | Medium |
| G-INT-7 | Exports lack **traceability watermarking** (insider leak attribution) | Security | Per-export watermark columns/metadata + recipient binding | Low |

Settings: [29 §17/§14](./29-settings-administration-architecture.md). **Module priority: Critical** (G-INT-1).

### 3.12 Outreach sequencing, send & deliverability ([05 §13](./05-features-modules.md), [08 §6](./08-compliance.md))

**Current coverage — strong on compliance.** Suppression inside the send-tx, CAN-SPAM footer enforcement,
DKIM/SPF/DMARC + warm-up + reputation throttles, bounce/complaint → suppression + credit-back, HITL for
LinkedIn.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-OUT-1 | **No A/B step variants** in the sequence model — yet [departments/02 §6](./departments/02-sdr.md) already reports "sequence A/B" (drift) | Feature | Variants per step (% split), per-variant stats, auto-promote winner (manual confirm) | High |
| G-OUT-2 | No **recipient-timezone sending, quiet hours, or holiday/blackout calendars** (only schedule/throttle) | Feature | Per-sequence send windows in recipient-local time; workspace holiday calendar | High |
| G-OUT-4 | **Tracking infrastructure unspecified**: open/click pixels + redirect service, **custom tracking domains** (CNAME), per-workspace tracking toggle; no ePrivacy stance for tracking EU recipients (ties G-CMP-8) | Architecture | Tracking service design + custom domains; tracking default-off for EU jurisdictions pending counsel | High |
| G-OUT-3 | **Exit/goal rules** implicit only (status advances) — no configurable auto-exit (reply/meeting/ownership-change) or goal attribution | Feature | Per-sequence exit criteria + goal definition; reported in funnel | Medium |
| G-OUT-5 | **Warm-up build-vs-buy** undecided and inbox-placement/seed testing absent | Feature | Decide vendor vs build; add placement test job per sending domain | Medium |
| G-OUT-6 | No **preference center** (topic-level opt-outs) and RFC 8058 one-click-POST unconfirmed (List-Unsubscribe named only) | Compliance | Hosted preference page → granular suppression scopes; confirm 8058 compliance (Gmail/Yahoo bulk rules) | Medium |
| G-OUT-7 | No **sequence activation approval** (compliance/brand review) despite a Compliance department persona ([departments/08](./departments/08-compliance.md)) | Permission | Optional approval gate per workspace policy ([29 §19](./29-settings-administration-architecture.md)) | Medium |
| G-OUT-8 | No **send-time optimization** (per-recipient best window) | AI | Engagement-history model; assistive suggestion first | Low |

Settings: [29 §5/§7](./29-settings-administration-architecture.md). **Module priority: High.**

### 3.13 Inbox + tasks ([11 §4.4](./11-information-architecture.md))

**Current coverage — adequate surface spec** (assign/snooze/done, quick reply, convert), but it inherits
G-INT-1 (no reply ingestion design).

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-INB-2 | **Reply classification missing from the AI surface** — `ai_task_type` ([23 §2](./23-ai-intelligence-layer.md)) has no classify task, yet SDR triage ("positive reply → task") assumes it | AI | Add `classify_reply` (intent: positive/objection/OOO/unsub/bounce; confidence-gated automation) | High |
| G-INB-1 | No **assignment routing rules** (round-robin, load-based, OOO reroute, capacity) | Automation | Routing policies as automation actions + team capacity model | Medium |
| G-INB-3 | No **reply SLA timers** (time-to-first-response) + breach alerts | Report | SLA config per team; breach → notification/escalation | Medium |
| G-INB-4 | No inbox **macros/snippets** distinct from sequence templates | UX | Quick-reply snippet library | Low |

**Module priority: High** (with G-INT-1 Critical upstream).

### 3.14 Templates & content ([11 §4.3](./11-information-architecture.md))

**Current coverage — light.** Library + snippets + merge fields + AI draft + deliverability lint.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-TPL-1 | No **versioning or approval states** on templates (compliance/brand review; who changed what) | Feature | Versions + draft/approved states + team scoping | Medium |
| G-TPL-2 | No **localized template variants** (per-locale bodies; ties G-UX-1) | Feature | Locale variants selected by recipient locale/jurisdiction | Medium |
| G-TPL-3 | Lint covers deliverability only — no **claims/brand lint** (risky phrases, missing disclaimers) | Feature | Configurable content rules; AI-assisted check (human-final) | Low |

**Module priority: Medium.**

### 3.15 Home & Reports / analytics ([11 §4.1/§4.5](./11-information-architecture.md), [05 §20](./05-features-modules.md))

**Current coverage — good packs.** Pipeline/credit/deliverability/team/data-health/score dashboards,
department report packs, ClickHouse/PostHog backing, CSV export.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-RPT-1 | No **custom report builder** (metrics × dimensions × filters, saved custom reports) — fixed packs only | Feature | Governed semantic layer over ClickHouse + builder UI (Team+) | High |
| G-RPT-2 | No **scheduled report delivery** or subscriptions (email/Slack digests of a dashboard) | Feature | Schedule per report → rendered snapshot → channel delivery; audited | High |
| G-RPT-6 | No **customer-facing SLA/uptime reporting** though Enterprise tier sells an SLA ([12 §6](./12-settings.md)) | Enterprise | Per-tenant uptime/SLO page + SLA-credit process | High |
| G-RPT-3 | No **forecasting** (pipeline projection, credit burn, coverage trend) | AI | Start with statistical projections; ML later | Medium |
| G-RPT-4 | No **metric dictionary** (governed definitions — "reply rate" must mean one thing everywhere) | Data | Metrics catalog doc + semantic-layer definitions; prevents KPI drift | Medium |
| G-RPT-5 | Home widgets are **not user-customizable** (persona defaults only) | UX | Add/remove/reorder widgets per user; persisted layout | Medium |

Settings: [29 §16](./29-settings-administration-architecture.md). **Module priority: High.**

### 3.16 Notifications & alerts ([05 §17/§20](./05-features-modules.md), [12 §2](./12-settings.md))

**Current coverage — thin and flagged.** Channel prefs named; `notifications` storage is a pending
[03 §14](./03-database-design.md) amendment; alerts module deferred to Beyond.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-NTF-1 | **Notification architecture undefined**: event→notification matrix, digest batching, dedup/coalescing, quiet hours, locale, fan-out at 100K users | Architecture | Define `notifications` + preferences schema, digest engine on the event backbone ([20](./20-event-driven-realtime-backbone.md)); matrix in [29 §15](./29-settings-administration-architecture.md) | High |
| G-NTF-3 | **Slack/Teams routing** per event type partially implied ([26 §7](./26-integrations-data-delivery.md)) but unconfigurable | Setting | Per-event channel routing (in-app/email/Slack) per user + team defaults | Medium |
| G-NTF-2 | No **escalation policies** (unacked critical → manager after N hours) | Feature | Escalation rules for compliance/budget/deliverability alerts | Low |

**Module priority: High.**

### 3.17 Compliance ([08](./08-compliance.md))

**Current coverage — flagship-grade.** In-tx suppression on reveal+send, golden-identity DSAR fan-out with
verification scan, DROP intake, lawful-basis lineage, retention schedule, residency tags, Trust program.
The gaps are the *operational* duties around the engineered controls:

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-CMP-1 | **Audit enum coverage**: the closed `action` enum ([08 §5](./08-compliance.md)) has no record CRUD (`contact.create/update/delete`, list/sequence/template changes), no `settings.update`, no automation/AI admin actions — contradicting [02 §6](./02-architecture.md)'s "every mutating action audited" | Compliance | Extend the closed enum (`contact.*`, `account.*`, `list.*`, `sequence.*`, `template.*`, `settings.update`, `automation.rule.*`, `ai.config.*`, `report.export`); H-vocab propagation per doc-map | **Critical** |
| G-CMP-2 | **No breach-notification workflow** (GDPR 72 h; US state laws): detection → severity/assessment → DPA/regulator + customer notify, roles, evidence | Compliance | Privacy-incident runbook joined to [19 §5](./19-observability-reliability.md) incident response; counsel-reviewed templates; GA gate | **Critical** |
| G-CMP-3 | **Legal hold** exists only as a console bullet ([13 §3](./13-platform-admin.md)) — no design (hold objects, retention override, DSAR-delete conflict rules, tenant-visible holds) | Enterprise | `legal_holds` design: scope (tenant/workspace/subject), overrides purge, documented DSAR-conflict policy (counsel) | High |
| G-CMP-4 | **DSAR identity verification** method unspecified (evidence types, anti-fraud, per-regime deadlines + extension letters) | Workflow | Verification ladder (email proof → document) + deadline tracking with statutory clocks | High |
| G-CMP-8 | **ePrivacy posture for open/click tracking** of EU recipients unaddressed (ties G-OUT-4) | Compliance | Counsel review; default tracking off for EU jurisdictions until resolved | High |
| G-CMP-5 | No **ROPA / DPIA artifact management** (balancing test exists as prose; no lifecycle/owner/review cadence) | Compliance | Compliance-ops artifacts in [13 §3](./13-platform-admin.md) with review reminders | Medium |
| G-CMP-6 | **Sub-processor change notification** + objection window missing (list is published; changes aren't pushed) | Compliance | Trust-Center subscription → notify N days before adding a sub-processor | Medium |
| G-CMP-7 | No **consent expiry/refresh** mechanics (validity window exists on `consent_records`; nothing re-permissions) | Feature | Expiring-consent report + re-permission play (automation recipe) | Medium |
| G-CMP-9 | **US state-law breadth**: GPC (Global Privacy Control) signal handling + universal opt-out beyond CCPA unplanned | Compliance | Honor GPC on public surfaces; map state-law matrix in the Trust track | Medium |
| G-CMP-10 | **Hash-chained audit log** still an open question — it is SOC 2 evidence gold | Security | Commit at Trust-track readiness (M5+); S3 Object-Lock anchor for `platform_audit_log` | Medium |
| G-CMP-11 | No **BYOK/CMEK** option (per-tenant KMS keys) for regulated enterprise | Enterprise | Per-tenant KMS key envelope for PII columns; Enterprise tier | Medium |
| G-CMP-12 | **No-PII-in-logs is asserted, not enforced** ([19 §1](./19-observability-reliability.md)) | Security | Log-scrubber middleware + CI PII-pattern tests + sampled audits | Medium |

**Module priority: Critical** (G-CMP-1/2).

### 3.18 Settings & customer admin ([12](./12-settings.md))

**Current coverage — good skeleton, four scopes, tier-tagged.** But it is a list of panels, not a settings
*system*. The full target catalog is [29](./29-settings-administration-architecture.md).

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-SET-1 | **No settings registry/audit**: no `settings.update` audit action, no change history, no who-changed-what, no effective-value resolution API | Architecture | Typed settings registry + audit + history + `GET /settings/effective`; [29 §1](./29-settings-administration-architecture.md) | High |
| G-SET-2 | **Setting-level RBAC** is coarse (scope-level editors only); no per-setting role matrix or lock-by-parent ("tenant locks workspace override") | Permission | Per-setting `editableBy` + `lockable` in the registry; strictest-wins for security-class settings (mirrors [ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)) | High |
| G-SET-3 | No **config-as-code** (export/import a workspace's settings; policy packs for agencies/enterprise) | Enterprise | JSON bundle export/apply with diff preview (ties G-WS-2) | Low |

**Module priority: High.**

### 3.19 Platform admin (internal) ([13](./13-platform-admin.md))

**Current coverage — excellent.** Separate app/auth/role, JIT, immutable platform audit, impersonation
controls, 14 console areas incl. data-ops and AI ops.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-PAD-1 | **Peer approval (four-eyes)** for highest-risk staff actions is an open question — decide it | Security | Require dual-control for: full impersonation, GDPR delete, credit grants > threshold, retention changes | High |
| G-PAD-2 | **Access-review automation** (quarterly staff attestation w/ evidence export) unspecified though reviews are promised | Compliance | Review campaigns + sign-off records feeding SOC 2 evidence | Medium |
| G-PAD-3 | **Customer visibility of impersonation** undecided (notify/opt-out stance) — GA-gating per [08 §14](./08-compliance.md) | Compliance | Decide: post-session notification + tenant setting to require consent | Medium |
| G-PAD-4 | No **tenant health/CS cockpit** (activation, usage trends, churn-risk flags for success teams) | Report | Health score from PostHog/ClickHouse signals in the tenants directory | Low |

**Module priority: Medium.**

### 3.20 Departments & teams ([25](./25-departments-teams-workspaces.md), [departments/](./departments/))

**Current coverage — good.** Teams/roles/visibility/budgets, personas over the 6 destinations, 11 modules,
recipe libraries.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-DEP-1 | No **territory model** (geo/segment/account-band ownership rules feeding routing + reporting) — assignment is manual or generic automation | Feature | Territory definitions (rules over account fields) → auto-assignment + conflict handling | Medium |
| G-DEP-2 | No **team capacity/working-hours calendars** (routing, SLA timers, send windows all need them) | Feature | Per-team calendars (working hours, holidays, member OOO) | Low |
| G-DEP-3 | "Dials" KPI in [departments/02 §3](./departments/02-sdr.md) with telephony out of scope — see G-TEL-1 + drift §11 | Feature | Resolve with the telephony decision | — |

**Module priority: Medium.**

### 3.21 Workflow automation engine ([27](./27-workflow-automation-engine.md))

**Current coverage — strong core.** Trigger/condition/action, suppression-gated + idempotent + audited,
dry-run, per-team policies, recipes, loop guards. Depth audit in §4; headline gaps:

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-AUT-1 | **Trigger/action vocabulary incomplete** for the recipes already promised (see §4 matrix): no freshness/budget/deliverability/task-overdue/segment-exit triggers; no suppress/pause-sequence/unenroll/request-approval/notify-channel actions | Feature | Extend `automation_trigger`/`automation_action` enums (H21 propagation) | High |
| G-AUT-2 | No **rule versioning / change audit / rollback** (a manager edits a live play silently) | Feature | Versioned rules; activate-by-version; `automation.rule.*` audit (ties G-CMP-1) | High |
| G-AUT-3 | No **per-rule error policy** (retry/skip/auto-disable after N failures + owner notification) | Feature | Error policy fields + failure notifications; DLQ already exists | High |
| G-AUT-4 | No **backtest/simulation** against historical events (dry-run is forward-only) | Feature | Replay last-N-days events through a rule in shadow mode | Medium |
| G-AUT-5 | No **activation approval** option (policy hook exists; approval flow doesn't) | Permission | Optional approval gate per [29 §19](./29-settings-administration-architecture.md) | Medium |

**Module priority: High.**

### 3.22 AI & intelligence layer ([23](./23-ai-intelligence-layer.md))

**Current coverage — excellent governance.** `AiPort` + routing, grounding/citations, HITL, eval harness,
budgets/metering, DSAR scope. Depth audit in §5; headline gaps:

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-AI-1 | **Missing task types** the corpus itself assumes or the market expects: reply classification (G-INB-2), next-best-action/task generation, forecasting, churn/pipeline-risk, data-anomaly detection | AI | Extend `ai_task_type` + capability rows (see §5 missing-AI table) | High |
| G-AI-2 | No **feedback loop** capture (accept/edit/reject on drafts/answers → eval sets + routing) | AI | Review-state telemetry already exists (`pending/approved/edited/rejected`) — wire it into `ai_evals` | Medium |
| G-AI-3 | **Tenant-level AI controls** missing (workspace toggle only): compliance-driven org-wide disable, data-sharing terms surface | Compliance | Tenant AI policy (enable/disable, allowed tasks, residency acknowledgment) | Medium |
| G-AI-4 | **Embedding lifecycle** unspecified (re-embed on record change, TTL, index hygiene at 100M+) | Data | Re-embed on `record.updated` via outbox; staleness sweep | Medium |
| G-AI-5 | **AI data-residency stance** for the EU split unstated (Anthropic processing region vs EU tenant promise) | Compliance | Document region posture in the DPA + 08 §8 residency plan | Medium |

**Module priority: High.**

### 3.23 Event backbone, realtime & SRE ([20](./20-event-driven-realtime-backbone.md), [19](./19-observability-reliability.md))

**Current coverage — excellent.** Outbox, idempotent consumers, DLQ/backpressure, per-entity ordering,
SSE with RLS-scoped channels, SLO/error budgets, DR drills, chaos, FinOps.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-EVT-1 | **Pre-M12 durability window**: BullMQ-on-Redis carries money-adjacent side-effects (suppression sync, credit-back) before the outbox lands; Redis loss = silent event loss | Architecture | Pull the outbox forward for compliance/money-adjacent events (suppression, credit-back, DSAR) or document the accepted loss window + reconciliation sweep | High |
| G-EVT-3 | **LISTEN/NOTIFY** ([02 §3.4](./02-architecture.md)) is a known Postgres bottleneck at high churn and is conceptually superseded by outbox+Redis — retirement unplanned | Scale | Plan its retirement at M12 (gateway consumes the relay, not NOTIFY) | Medium |
| G-EVT-2 | **Outbox relay** is a single-poller design — a throughput ceiling and a head-of-line risk | Scale | Partitioned relay (by hash of entity key) preserving per-entity order | Medium |
| G-EVT-4 | **Event schema governance** (versioning/compat rules, registry of payload schemas) unstated beyond `version` field | Architecture | Schema registry in `packages/types` + additive-only compat policy | Medium |
| G-EVT-5 | No **DLQ redrive tooling** (inspect/fix/replay) for staff | Feature | Console DLQ browser + redrive with audit ([13 §9](./13-platform-admin.md)) | Medium |

**Module priority: High.**

### 3.24 Telephony / dialer — the absent module

**Current coverage — none, by decision.** [00 §4](./00-overview.md) explicitly excludes dialer/telephony.
Yet: the SDR module reports **"Dials"** ([departments/02 §3](./departments/02-sdr.md)), `activities` model
`call_made/call_connected`, phone reveals are a monetized type, and the stated bar includes "thousands of
concurrent agents" with call distribution/coaching expectations. Competitors (Apollo, Outreach, Salesloft)
all ship dialers.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-TEL-1 | **No calling module**: click-to-call/power dialer, number provisioning + rotation + spam-likely remediation, recording with per-jurisdiction consent (two-party states), transcription → conversation intelligence, TCPA/DNC-registry checks, quiet hours, voicemail drop, callback scheduling, coaching (listen/whisper/barge) | Feature | **Make the decision explicit**: (a) schedule a CPaaS-based module (Twilio/Telnyx behind a `CallPort`, reusing suppression/consent/audit/budget rails) as a post-M16 milestone, or (b) re-affirm exclusion and fix the SDR "Dials" KPI + position phone reveals as export-to-your-dialer. Either way resolve the contradiction (§11) | High (decision) |

If built, its settings/admin surface is pre-specified in [29 §9](./29-settings-administration-architecture.md).

### 3.25 Cross-cutting frontend & UX ([04](./04-ui-ux-design.md), [11](./11-information-architecture.md))

**Current coverage — strong system.** Tokens, 6-destination shell, panels, cmdk, density toggle, masked-PII
discipline, virtualized grid, keyboard-first, WCAG AA intent.

| ID | Gap | Class | Recommendation | Prio |
|---|---|---|---|---|
| G-UX-1 | **No i18n/l10n architecture** (UI strings, date/number/currency locales, RTL, template localization) despite a global-deployment bar and a `locale` profile field | Architecture | Pick the i18n stack pre-M11 (message catalogs in `packages/ui`, ICU formats); en-only launch is fine, *architecture* must exist | **Critical** |
| G-UX-2 | No **frontend performance telemetry** (RUM / Core Web Vitals) — §8; 19 observes the server only | Performance | Add RUM (CloudWatch RUM or PostHog web vitals) with per-screen budgets (§7) | High |
| G-UX-3 | **Bulk operations lack history/undo** (bulk reveal is irreversible by nature, but bulk edit/list-add/status changes need an operations log + revert) | UX | Bulk-ops history panel + revert where reversible | Medium |
| G-UX-4 | **Dark theme** deferred indefinitely ("later option") — a top-quartile user ask | UX | Token architecture already supports it; schedule post-MVP | Medium |
| G-UX-5 | No **keyboard-shortcut customization** or shortcut-cheatsheet surface | UX | `?` overlay + remapping in user prefs | Low |
| G-UX-6 | **Accessibility verification cadence** unstated (AA is asserted) | UX | Axe CI checks + periodic manual audit; a11y statement page | Medium |
| G-UX-7 | **Offline/poor-network behavior** unspecified (SPA shell; no retry/queue UX conventions) | UX | Standard stale-while-revalidate + retry toasts + connection banner | Low |

**Module priority: High** (G-UX-1 Critical).

## 4. Automation audit (deep)

The engine ([27](./27-workflow-automation-engine.md)) is sound. This table audits **every automation the
platform needs**, including the corpus's own promises, against the six required attributes. **Bold** items
are missing or incomplete today.

| Automation | Trigger | Conditions | Actions | Exceptions | Monitoring | Recovery |
|---|---|---|---|---|---|---|
| Lead assignment / routing | `record_created` / `list_entered` | ICP/territory match, **team capacity** | `assign_owner`/`assign_team` | suppression n/a; **no-capacity fallback queue missing** | `automation_runs` | idempotent on re-delivery |
| **Lead recycling** | **`schedule` + status-age condition (recipe missing)** | `outreach_status ∈ nurture/disqualified` + age > N | re-enroll / `add_to_list` / reset owner | excluded: unsubscribed/suppressed | runs + recycle report | re-run safe (idempotent) |
| Data cleanup / hygiene | `schedule` (Ops recipe) | `freshness_status`, completeness | `update_field`, **start_verification (action missing)** | legal-hold records skipped (**needs G-CMP-3**) | DQ dashboards | resumable batch |
| Deduplication | `import.completed` / ER events | match confidence | flag `is_duplicate_of`; **customer merge queue (G-ENR-6)** | low-confidence → human review | ER queue metrics | un-merge reversible |
| Data enrichment | `record_created` / `reveal.completed` / `schedule` | **auto-enrich policy (G-ENR-1)**, budget | enrich fields | budget exhausted → skip+warn | provider dashboards | cache-first retry |
| Campaign/sequence scheduling | `schedule`, `list_entered`, segment refresh | segment rules, **send windows (G-OUT-2)** | `enroll_sequence` | suppression + consent gates (in-tx) | enrollment stats | idempotent enroll |
| Call distribution | — | — | — | — | — | **n/a until G-TEL-1 decided** |
| Email follow-up | step delay / `reply_received` | reply intent (**needs G-INB-2**) | next step / `create_task` | replied → **auto-exit rule (G-OUT-3)** | sequence stats | per-entity ordered |
| Compliance validation | every reveal/send/export (in-tx) | suppression scopes, consent, footer | block + audit | none — unbypassable by design | `reveal.blocked` audit metrics | n/a (synchronous gate) |
| List/segment processing | segment scheduled refresh | segment rules | membership update, downstream plays | rate-limited | refresh lag metric | full re-evaluate safe |
| Import processing | upload / **scheduled drop (G-IMP-4)** | mapping + conflict policy (**G-IMP-5**) | dedup-upsert + provenance | **rejected-rows file (G-IMP-1)** | import history | re-run idempotent; **undo (G-IMP-2)** |
| Reporting | **`schedule` (G-RPT-2 missing)** | subscription def | render + deliver email/Slack | visibility-scoped | delivery log | re-render safe |
| Notifications | all domain events | user/team prefs (**matrix G-NTF-1**) | in-app/email/Slack | quiet hours, digests | delivery metrics | dedup/coalesce |
| Bounce/complaint handling | SES SNS→SQS | hard vs soft | suppression add + credit-back + status | guarantee window check | deliverability cockpit | idempotent on event id |
| Re-verification | freshness SLA via `verification_jobs` | decay priority, budget | verify → status/credit-back | budget circuit breaker | verification dashboards | resumable batch |
| DSAR / DROP processing | intake / 45-day poll | identity verified (**G-CMP-4**) | fan-out delete + verify scan | legal hold conflict (**G-CMP-3**) | DSAR SLA tracker | idempotent re-run gated on scan |

**Engine-level findings** (beyond G-AUT-1..5): add **per-rule rate budget** (max actions/day), a
**global pause switch** per workspace (incident brake), and **ownership transfer** of rules on offboarding
(ties G-AUTH-1).

## 5. AI audit (deep)

Existing capabilities ([23 §3](./23-ai-intelligence-layer.md)) audited against the six required attributes
— all six pass for the seven shipped capabilities (inputs/outputs are specified; "training data" is
correctly *none* — API models + golden eval sets; user controls = enable/budgets/BYO key; explainability =
citations/`score_breakdown`/review states; cost = budgets/caching/routing). The deficit is **missing
capabilities**:

| Missing AI feature | Inputs | Outputs | Training data | User controls | Explainability | Cost controls |
|---|---|---|---|---|---|---|
| **Reply classification** (G-INB-2) | reply body/thread, sequence context | intent label + confidence → Inbox triage/automation | golden labeled replies (`ai_evals`) | per-workspace toggle; confidence threshold for auto-actions | label + matched phrases shown | Haiku-class; cache per thread |
| **Next-best-action / task generation** | record state, score, signals, activity recency | suggested tasks ("call X — funding signal") into Inbox | none (heuristics + LLM); feedback loop G-AI-2 | suggest-only default; per-user opt-out | "why this" rationale with cited signals | batch nightly + on-event cap |
| **Forecasting** (pipeline/credit/coverage) | historical funnel + burn series (ClickHouse) | projections + confidence bands on Reports/Home | statistical first (no LLM); ML later w/ model card | visibility per role | method + interval disclosed | cheap (no LLM) |
| **Churn-risk prediction** (CS persona) | engagement/activity trends per account | risk flag + driver list → CS plays ([27 §8](./27-workflow-automation-engine.md)) | labeled outcomes when available; rules first | CS-team toggle | top drivers listed | batch scoring |
| **Pipeline-risk detection** | stage age, reply sentiment, activity gaps | at-risk deals/contacts list | rules first | manager-only view | rule trace | batch |
| **Anomaly detection** (data + usage) | DQ metrics, reveal/export volumes, bounce rates | anomaly alerts (admin/Ops) | seasonal baselines | thresholds configurable | baseline-vs-actual chart | cheap (statistical) |
| **Email-thread summarization** | inbox thread | TL;DR + suggested reply points | golden sets | per-user toggle | quoted-span grounding | Haiku-class |
| **Send-time optimization** (G-OUT-8) | per-recipient engagement history | suggested send window | aggregate engagement stats | suggest-only; sequence-level toggle | window rationale | batch precompute |

**Cross-cutting AI findings:** add the **feedback loop** (G-AI-2), **tenant-level policy** (G-AI-3),
**embedding lifecycle** (G-AI-4), **residency stance** (G-AI-5), and an **AI disclosure** decision
(whether/where generated-content labeling is required — EU AI Act trajectory; counsel input).

## 6. Scalability audit

Tiers below are **registered users** (with the corpus's own ratios: large-workspace concurrency ≥ 5,000,
[18 §1](./18-scalability-performance.md)). The stated bar of **10,000+ platform-concurrent users** is not
explicitly a row in 18 §1 — recommend adding it.

| Tier | What breaks first | Notes |
|---|---|---|
| **10K users** | Nothing structural. Watch: per-workspace Typesense collection strategy (G-SCALE-2), notification fan-out (G-NTF-1) | MVP architecture holds |
| **50K users** | Tenant credit hot-row on the largest tenants (G-BIL-2); CDC single-slot lag (G-SCALE-3); BullMQ durability window (G-EVT-1) | First enterprise tenants are exactly the hot-row tenants |
| **100K users** | Outbox relay (G-EVT-2); audit/activity partition bloat on Aurora (G-ACT-1, G-SCALE-4); SSE gateway ceilings (open Q in 18) | M12 scope must land before this tier |
| **500K users** | Citus cutover (planned, [18 §8](./18-scalability-performance.md)); Redis cluster + idempotency-store sizing; notification/digest fan-out; reporting concurrency on ClickHouse | Mostly planned; G-SCALE items below close the rest |

**Bottleneck register** (Risk / Impact / Solution / Strategy):

| ID | Bottleneck | Risk & impact | Solution | Scaling strategy |
|---|---|---|---|---|
| G-BIL-2 | `tenants.reveal_credit_balance` `FOR UPDATE` | All reveals in a tenant serialize; lock queues at 1000s of concurrent agents → reveal p95 blowout | Credit leases per workspace/team reconciled async; ledger (G-BIL-1) preserves invariants | Lease size adaptive to burn rate |
| G-SCALE-1 | `team_credit_budgets` row per team/period | Same hot-row pattern at team grain | Include in the lease design | — |
| G-SCALE-2 | **Typesense multi-tenancy model unspecified** (collection-per-workspace explodes at 100K workspaces; one shared collection needs strict filter injection) | Index sprawl or cross-tenant leak risk | Decide: shared collection + mandatory `workspace_id` filter injected server-side (test-enforced), shard by workspace hash | Re-shard plan + per-collection caps |
| G-SCALE-3 | **Single logical-replication slot** for CDC | Sync lag breaks the <5 s freshness SLO; slot failure stalls all projections | Multiple slots/publications by table group; lag alerting exists | Debezium parallelization at M12 |
| G-SCALE-4 | `audit_log`/`activities` on Aurora at billions | Storage cost + partition maintenance + slow scans | Tier old partitions to S3/Athena (audit) and ClickHouse (activities, G-ACT-1); keep hot window on Aurora | Partition-lifecycle automation ([13 §13](./13-platform-admin.md)) |
| G-SCALE-5 | **Idempotency-key store** as a Postgres table (M3) | Write amplification on every money call at 10K rps | Move to Redis with TTL + async archive | Already-shaped: header + replay |
| G-SCALE-6 | **OpenSearch reindex** at billions (mapping changes) | Days-long reindex; staleness | Zero-downtime alias-swap reindex pipeline + dual-write window | Documented runbook ([19 §5](./19-observability-reliability.md) list) |
| G-SCALE-7 | Notification fan-out (e.g. segment refresh notifying 50K users) | Thundering herd on `notifications` + email | Digest/coalesce engine (G-NTF-1); per-event fan-out caps | Batch insert + async channel delivery |
| G-SCALE-8 | Import bursts (10M-row files) | Worker starvation of interactive jobs | Separate bulk queue class + AWS Batch offload (exists) + per-tenant concurrency caps | Backpressure per [20 §6](./20-event-driven-realtime-backbone.md) |
| G-SCALE-9 | Webhook storms (segment refresh → 100K events to one slow endpoint) | Retry amplification, DLQ floods | Per-endpoint concurrency + circuit breaker + event coalescing | Exists partially (retries/DLQ); add breaker |
| G-SCALE-10 | DSAR verification scans across shards | Cost/SLA at billions (open question [08 §13](./08-compliance.md)) | Blind-index lookup tables make find-everywhere O(copies); bound scan via index-only proof | Track per-DSAR cost metric |
| G-SCALE-11 | Export streaming (1M+ rows) | Memory blowups, timeouts | Cursor-streamed worker exports to S3 multipart (replica-fed, exists) — enforce streaming-only | Row caps per plan (exists, [26 §8](./26-integrations-data-delivery.md)) |
| G-EVT-2/3 | Outbox relay + LISTEN/NOTIFY | Event lag → freshness SLO breach | Partitioned relay; retire NOTIFY | §3.23 |

## 7. Performance audit

Server-side budgets exist ([18 §2](./18-scalability-performance.md)). **Missing: screen-level (client)
targets and frontend telemetry (G-UX-2).** Recommended screen budgets (p75, warm cache):

| Screen | First load (TTI) | Interaction API p95 | Search-as-you-type | Export start | Import feedback | Report render |
|---|---|---|---|---|---|---|
| Prospect (grid) | < 2.0 s | 150 ms (page) / 200 ms (search) | < 250 ms end-to-end | enqueue < 100 ms | — | — |
| Record detail (slide-over) | < 400 ms open | 150 ms | — | — | — | — |
| Reveal confirm→result | — | 300 ms (tx) | — | — | — | — |
| Home | < 1.5 s | 150 ms per widget | — | — | — | — |
| Sequences (builder) | < 2.0 s | 150 ms | — | — | — | — |
| Inbox | < 1.5 s | 150 ms; new-reply push < 5 s (SSE) | — | — | — | — |
| Reports | < 2.5 s | — | — | CSV < 30 s for 100K rows | — | dashboard < 3 s |
| Import wizard | < 1.5 s | — | — | — | preview < 10 s for 50K rows | — |
| Settings | < 1.0 s | 100 ms | — | — | — | — |

**Optimization findings:**

- **Slow-query candidates:** unindexed `ORDER BY last_activity_at` over big workspaces (composite index
  exists — verify covering); list-membership joins at 1M-member lists (paginate by `list_members` PK);
  timeline reads must be partition-pruned by `occurred_at` (enforce in repo layer); facet counts must never
  fall back to Postgres `COUNT(*)` (already routed to ClickHouse — add a guard).
- **Payloads:** masked-grid rows should be a projection (covering index exists in [03 §12](./03-database-design.md));
  enforce column selection on tRPC list endpoints; gzip/brotli on API (unstated — add).
- **Unnecessary requests:** facet re-fetch on every keystroke (debounce specified at ~150 ms — also cache
  facet results per filter-hash); Home widgets should batch into `/home/summary` (exists — keep).
- **Cache opportunities:** entitlements/budgets (specified); add **JWKS** and **settings-effective** caches
  with invalidate-on-write; HTTP `ETag` on slow-moving resources (templates, views).
- **Lazy/virtualization:** feature-slice lazy loading + grid virtualization specified — extend
  virtualization to timeline and Inbox thread lists; lazy-load the sequence builder and report packs.
- **Frontend bundle:** no bundle-size budget exists — add per-slice budget (e.g. < 250 KB gz initial shell)
  to CI.

## 8. Observability audit

Strong base ([19](./19-observability-reliability.md)). Per-module KPI coverage check:

| Module | Business KPIs | Error metrics | Perf metrics | Capacity metrics | Gaps |
|---|---|---|---|---|---|
| Reveal/credits | reveals/day, charge-rate, credit-back rate | 402/403/409 rates | reveal p95 | counter lock wait | **lock-wait metric missing** (G-BIL-2 signal) |
| Search | searches/user, zero-result rate | query errors | search p95, sync lag | index size/QPS | **zero-result rate missing** (G-SRCH-1) |
| Import | rows/day, dedup ratio | reject rate | rows/sec | queue depth | reject-file metrics (G-IMP-1) |
| Enrichment | hit-rate, cost/reveal | provider error/breaker | provider latency | budget burn | covered ([06 §10](./06-enrichment-engine.md)) |
| Outreach | sends, reply/bounce/complaint | send failures | dispatch lag | domain throughput | **per-step variant stats** (G-OUT-1) |
| Inbox | time-to-first-reply | sync failures | reply-ingest lag | mailbox backlog | **all pending G-INT-1** |
| Automation | runs, action mix | failure rate per rule | reaction p95 (< 30 s) | queue depth | rule-level error policy (G-AUT-3) |
| AI | usage by task, review accept-rate | safety blocks | first-token p95 | budget burn | accept-rate ties G-AI-2 |
| Compliance | DSAR SLA, suppression adds | fan-out failures | scan duration | DROP poll status | DSAR statutory-clock alerting (G-CMP-4) |
| Billing | MRR, gross credits | webhook failures | recon drift | — | **recon-drift alert** (formalize from [07 §8](./07-billing-credits.md)) |

**Missing platform-wide:** browser **RUM** (G-UX-2); **per-tenant observability API** for enterprise
customers (their usage/limits/events); **audit-log anomaly detection** (spike in reveals/exports per actor
— preventive twin of G-REV-1); **synthetic checks for the auth-origin token exchange** (the highest-risk
flow, risk #17) — extend CloudWatch Synthetics beyond login/search/reveal.

## 9. Enterprise readiness audit

| Capability | Status | Gap / action | Prio |
|---|---|---|---|
| SSO (SAML 2.0 / OIDC) | ✅ M11, wizard + test-connection | — | — |
| SCIM | ✅ M11 (scope open) | Close scope Q; add **groups→teams** (G-AUTH-4) | High |
| Audit logs | ✅ append-only + export | **Enum coverage** (G-CMP-1); **SIEM streaming** (G-AUTH-9); hash-chaining (G-CMP-10) | Critical |
| Data retention | ✅ schedule per class | Windows need legal sign-off (open); tenant-visible config exists ([12 §4](./12-settings.md)) | Medium |
| Legal hold | 🔶 named only | Full design (G-CMP-3) | High |
| IP restrictions | ✅ tenant/workspace CIDR | — | — |
| Device restrictions | 🔶 trusted devices only | **Managed-device requirement** (block untrusted) as an Enterprise auth-policy option | Medium |
| Session controls | ✅ timeout/cap/revoke | Tenant-admin revoke UI (G-AUTH-2) | High |
| Approval workflows | 🔶 exports + staff JIT only | Matrix in [29 §19](./29-settings-administration-architecture.md): bulk reveal, suppression removal, automation/sequence activation, budget/retention changes | High |
| Delegated administration | ❌ boolean owner | Granular org roles (G-AUTH-10); custom roles later | Critical |
| Data residency | 🔶 designed (tags), US-only | EU split timing open; **per-workspace region** + AI residency (G-AI-5) | High |
| Backup strategy | ✅ PITR + S3 CRR + verified restore | Add **ClickHouse backups** + Redis/queue durability statement (G-EVT-1) | Medium |
| Disaster recovery | ✅ RTO 1 h / RPO 5 m + drills | Multi-region active-active only if a future SLA requires 99.99% | Low |
| Business continuity | ❌ not documented | BCP beyond infra-DR: vendor outage playbooks (Stripe/Anthropic/providers exist as breakers — write the plan), people/process continuity | Medium |
| SLA reporting | ❌ | Customer-facing uptime/SLA-credit mechanics (G-RPT-6) | High |
| Support tiers | 🔶 documented commitment ([15 §4](./15-gap-remediation.md)) | Response-time SLAs + tooling still open | Medium |
| Security reviews / questionnaires | ❌ | Trust-Center artifacts cover most; add CAIQ/SIG answer pack to the Trust track | Low |
| BYOK / CMEK | ❌ | G-CMP-11 (Enterprise) | Medium |
| Custom roles (RBAC) | ❌ fixed roles | After G-AUTH-10: custom role builder (permission sets as data) — Enterprise, post-M15 | Medium |
| Sandbox environments | ❌ | G-WS-7 + sandbox API keys (named in [09 §8](./09-api-design.md)) | Medium |

## 10. Security & compliance control audit (consolidated)

Controls present and strong: RLS fail-closed isolation, envelope-encrypted PII + blind indexes, masked
search, scoped/hashed keys, in-tx gates, privileged-role separation + immutable platform audit, WAF/Shield,
secrets management, signed images, auth security layers. **Missing controls:**

| ID | Missing control | Recommendation | Prio |
|---|---|---|---|
| G-SEC-1 | **Secure-development pipeline**: SAST/DAST, dependency + container scanning, secrets scanning in CI ([01 §6](./01-tech-stack.md) has lint/test/sign only) | Add scanners + fail thresholds; SBOM per image; vuln-fix SLAs by severity | High |
| G-SEC-2 | **Pen-test cadence + bug bounty/VDP** (one pre-GA pen-test is named in risk #5 only) | Annual pen-test + continuous VDP; scope includes auth origin + admin | High |
| G-SEC-3 | **Blind-index HMAC key rotation impossibility** ([14 §5](./14-phase-1-execution.md): rotating breaks dedup) — a compromised key is unrotatable without a plan | Versioned blind-index scheme (key-id column + dual-index migration runbook) | High |
| G-SEC-4 | **Vulnerability management program** (tracking, SLAs, patching cadence for self-hosted Typesense/OpenSearch/ClickHouse/GlitchTip/PostHog) | Patch calendar + image-rebuild automation; the self-hosted fleet is the soft underbelly of ADR-0010 | High |
| G-SEC-5 | **DLP on egress** (exports/webhooks/reverse-ETL carry PII to arbitrary targets) | Export policies exist; add destination allowlists per tenant + PII-class rules | Medium |
| G-SEC-6 | **Dual control** for destructive customer-data ops (staff) — open Q | Decide yes (G-PAD-1) | High |
| G-SEC-7 | **Data classification policy** (what counts as PII/sensitive/internal; drives logging, exports, AI grounding) | Short policy doc + tags in `packages/types` | Medium |
| G-SEC-8 | **Tenant-facing security events** (their audit anomalies, e.g. mass export by a member) | Security-alerts feed per tenant (ties §8 anomaly detection) | Medium |
| G-SEC-9 | **CSP/security headers for the app domain** (specified for `auth.*` only, [17 §1](./17-authentication.md)) | Extend header set to `app.*` + API | Medium |

Compliance-control gaps are G-CMP-1…12 (§3.17). Together these constitute the SOC 2 control backlog the
Trust track ([ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md)) will need anyway.

## 11. Corpus consistency findings (plan-weaver audit mode)

Checklist run per `consistency-checklist`: **verdict `warn`** — no broken links found in sampled link
checks; the issues below are numbering/vocabulary drift needing small fixes (reported, **not** applied):

> **Status — Remediation Pass 1 (2026-06-10): all nine findings closed.** F-1 fixed (duplicate rows
> renumbered **#23/#24**, moved to the register tail — the [15 §6](./15-gap-remediation.md) "risk rows
> 13–16" citation stays valid); F-2 fixed (17 open questions now 1–6); F-3 fixed (DDL comment aligned to
> the [12 §6](./12-settings.md) tiers); F-4 resolved by
> [ADR-0030](./decisions/ADR-0030-granular-tenant-org-roles.md); F-5 reworded ("calls logged") pending
> the G-TEL-1 decision ([00 §8 Q13](./00-overview.md)); F-6 fixed (doc-map + checklist updated); F-7
> footnoted in [10](./10-roadmap.md) sequencing notes; F-8 closed by the audit-enum extension
> ([03 §7](./03-database-design.md) + [08 §5](./08-compliance.md)); F-9 closed (`classify_reply` added to
> [23 §2/§3](./23-ai-intelligence-layer.md)). The table below is preserved as the audit record.

```
consistency: warn
checks:
  A link-integrity:   pass (sampled)
  B heading-number:   warn — see F-2
  C decision-tripod:  pass
  D matrix↔roadmap:   pass (05 §21 ↔ 10 M-set agrees, incl. M12–M16)
  E risk↔DoD:         warn — see F-1 (numbering only; mitigations present)
  F vocab-drift:      fail — see F-3, F-4, F-5
  H open-questions:   warn — see F-2
  K doc-map currency: warn — see F-6
```

| # | Finding | Location | Fix |
|---|---|---|---|
| F-1 | **Risk register numbers duplicated**: two risks numbered 15 and two numbered 16 (data-broker + billions-infra vs compliance-wedge + pricing) | [10](./10-roadmap.md) register | Renumber 15–22 → 15–24 and update the one inbound reference style ("risk #17" for auth remains correct as the *cross-domain* row — verify after renumber) |
| F-2 | **Open-questions numbering out of order** (1,2,3,6,4,5) | [17](./17-authentication.md) open questions | Renumber sequentially |
| F-3 | **`tenants.plan` enum drift**: DDL comment says `free\|starter\|growth\|enterprise`; the tier matrix and shared vocab say Free/Pro/Team/Enterprise | [03 §4](./03-database-design.md) vs [12 §6](./12-settings.md) | Align the DDL comment to the 12 §6 vocabulary (or vice-versa) and propagate per doc-map §5 |
| F-4 | **"Billing admin" role named without schema** ("tenant owner / billing admin" editor) — only `is_tenant_owner` exists (H8) | [12 §1](./12-settings.md) | Resolve via G-AUTH-10 (granular org roles) or strike the phrase |
| F-5 | **"Dials" KPI vs telephony exclusion**: SDR dashboard reports dials; [00 §4](./00-overview.md) excludes dialer/telephony | [departments/02 §3](./departments/02-sdr.md) | Resolve via the G-TEL-1 decision; if exclusion stands, reword to "calls logged" |
| F-6 | **doc-map staleness**: README adjacency row says "00–17"; hazard section is titled "H1–H10" but lists H1–H23; consistency-checklist's milestone set says "M0–M5 + M7–M10" predating M11–M16 | `plan-weaver` reference files | Update doc-map rows + checklist milestone set |
| F-7 | **M6 does not exist** (M5 → M7 jump) — historical, but every new reader trips on it | [10](./10-roadmap.md) | Add a one-line footnote ("M6 retired/merged") or renumber (not recommended) |
| F-8 | **Audit-enum vs audit promise**: [02 §6](./02-architecture.md) promises all mutations audited; the closed enum can't express record/settings mutations | [08 §5](./08-compliance.md), [03 §7](./03-database-design.md) | G-CMP-1 (enum extension) — also a vocab-drift fix |
| F-9 | `ai_task_type` lacks the classification task the SDR module's triage assumes | [23 §2](./23-ai-intelligence-layer.md) vs [departments/02 §4](./departments/02-sdr.md) | G-AI-1 / G-INB-2 |

## 12. Prioritized gap register (consolidated)

> **Status — Remediation Pass 1 (2026-06-10).** The seven Criticals are now wired into the plan:
> **G-REV-5/6/7** → [ADR-0028](./decisions/ADR-0028-record-customization-layer.md) (record customization,
> M8); **G-BIL-1/2** → [ADR-0029](./decisions/ADR-0029-credit-ledger-and-lease-decrement.md) (ledger M11,
> leases M12; risk #2 updated); **G-AUTH-10** →
> [ADR-0030](./decisions/ADR-0030-granular-tenant-org-roles.md) (org roles, M11; H8 propagated);
> **G-CMP-1** → audit-enum extension ([03 §7](./03-database-design.md), [08 §5](./08-compliance.md), M5);
> **G-CMP-2** → [08 §16](./08-compliance.md) breach-notification workflow + checklist + Trust-track
> readiness; **G-INT-1** → M9 design gate ([10](./10-roadmap.md), [03 §14](./03-database-design.md),
> [00 §8 Q11](./00-overview.md)); **G-UX-1** → M11 decision gate ([00 §8 Q12](./00-overview.md));
> **G-TEL-1** → [00 §8 Q13](./00-overview.md) (exclusion stands until decided). G-INB-2 landed early
> (`classify_reply`, [23 §2](./23-ai-intelligence-layer.md)). **High/Medium/Low gaps below remain open**
> — Pass 2 candidates, sequenced per the recommendation at the end of this section.

**Critical (7).**

| ID | Gap | Module | Suggested owner |
|---|---|---|---|
| G-REV-5 | Custom fields | Record model | new scope pre-M10 |
| G-CMP-1 | Audit-enum coverage of record/settings mutations | Compliance | M5 |
| G-BIL-1 | Append-only credit ledger commitment | Billing | ≤ M11 |
| G-BIL-2 | Tenant-counter hot-row throughput | Billing/Scale | M12 |
| G-INT-1 | Reply/mailbox-ingestion architecture | Inbox/Integrations | M9 design gate |
| G-AUTH-10 | Granular tenant admin roles | Auth/Governance | M11 |
| G-UX-1 | i18n/l10n architecture | Frontend | decision pre-M11 |

**High (35).** G-AUTH-1, G-AUTH-2, G-AUTH-4, G-AUTH-9 · G-WS-1 · G-IMP-1, G-IMP-2, G-IMP-5 · G-ENR-1,
G-ENR-6 · G-REV-1, G-REV-3, G-REV-6, G-REV-7 · G-ACT-1, G-ACT-3 · G-BIL-3 · G-INT-2, G-INT-4 · G-OUT-1,
G-OUT-2, G-OUT-4 · G-INB-2 · G-RPT-1, G-RPT-2, G-RPT-6 · G-NTF-1 · G-CMP-2 (legal duty — treat as
GA-gating), G-CMP-3, G-CMP-4, G-CMP-8 · G-SET-1, G-SET-2 · G-PAD-1 · G-AUT-1, G-AUT-2, G-AUT-3 · G-AI-1 ·
G-EVT-1 · G-TEL-1 (decision) · G-UX-2 · G-SEC-1, G-SEC-2, G-SEC-3, G-SEC-4, G-SEC-6 · G-SCALE-2, G-SCALE-3.

**Medium (~50) and Low (~20)** are itemized in their module tables (§3) and §10; they do not need central
restating. Sequencing recommendation: fold Critical+High items into the existing milestone spines — M5
(audit enum, breach runbook), M9 (mailbox sync, A/B, send windows, tracking), M10 (custom fields before
CRM sync), M11 (org roles, ledger, procurement, SIEM, SLA reporting), M12 (credit leases, CDC slots,
relay partitioning), M13 (merge UI, auto-enrich policy), M14 (reply classification, feedback loop), M16
(automation hardening) — plus the standing security program (G-SEC-*) on the Trust track.

## Links
- **Links to:** every planning doc [00](./00-overview.md)–[27](./27-workflow-automation-engine.md),
  [departments/](./departments/), and the cited ADRs — notably
  [ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md) (counter risks this audit
  asks to close), [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md),
  [ADR-0014](./decisions/ADR-0014-trust-and-certification-program.md),
  [ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md),
  [ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)–
  [ADR-0027](./decisions/ADR-0027-real-time-delivery-and-event-backbone.md);
  companion catalog [29](./29-settings-administration-architecture.md).
- **Linked from:** [README](./README.md) (index), [29](./29-settings-administration-architecture.md).

## Open questions

1. **Telephony decision (G-TEL-1)** — schedule a CPaaS calling module or re-affirm exclusion and fix the
   SDR KPI wording; this also settles call-related settings ([29 §9](./29-settings-administration-architecture.md)).
2. **Ledger timing (G-BIL-1)** — accept the ≤ M11 recommendation, or earlier if enterprise deals demand it?
3. **Custom-fields scope (G-REV-5)** — typed columns-per-definition vs typed-jsonb storage; field count
   caps per plan tier.
4. **Mailbox-sync approach (G-INT-1)** — direct Gmail/Microsoft Graph integration vs a unified email API
   vendor (mirrors the Merge.dev question in [09 §11](./09-api-design.md)).
5. **i18n timing (G-UX-1)** — which locales at GA; UI-only vs UI+template localization first.
6. **Concurrency bar** — raise [18 §1](./18-scalability-performance.md) to an explicit platform-wide
   ≥ 10,000 concurrent-user target (the per-workspace ≥ 5,000 row implies but does not state it)?
7. **Drift fixes (§11 F-1…F-9)** — apply as a follow-up corpus pass (small, mechanical; plan-weaver change
   mode)?
