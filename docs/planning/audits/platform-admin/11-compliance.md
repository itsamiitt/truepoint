---
title: Platform Admin — Compliance Ops Tab Audit
tab: compliance
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

# Platform Admin — Compliance Ops Audit

## 1. Executive Summary

The Compliance Ops tab (13a Area 8, 13 §3.8) is the most genuinely **fully-wired** surface in the
platform-admin console: it ships three working surfaces — DSAR Oversight (read), Global Suppression
(read/write), and Retention Policies (read/write CRUD) — each backed by an audited, capability-gated
`apps/api` endpoint and a real platform table. Every mutation runs inside `withPlatformTx`, every
write is gated by `compliance:manage`, and the DSAR queue is **privacy-preserving by construction**:
the read projection in `platformComplianceReads.ts` deliberately omits `subject_email_enc`,
`subject_email_blind_index`, and `scope_report`, so staff oversight sees the request envelope (type,
state, timestamps) and never the subject's PII.

The defining gap is depth, not wiring. The DSAR queue is **read-only oversight** — there is no
in-console verify / assign / process / reject / complete actioning. The actual erasure machinery
(`packages/core/src/compliance/deleteFanout.ts`, the `dsar` BullMQ queue, `assembleAccessReport`)
exists and is robust (find-everywhere by blind index, per-copy tombstone + audit, global suppression,
verification scan gating `completed`), but it is enqueued by "the staff workflow (apps/admin later)"
that does not yet exist. A compliance officer can watch the queue but cannot move a request through it
from the console. Five enterprise-table-stakes capabilities are entirely absent: a **sub-processor /
vendor registry**, **legal holds**, **data-residency controls**, a **consent / lawful-basis UI**
(the `consent_records` table exists but has no admin surface), and a **Trust Center**. The spec
(08 §8, §10, §13) already designs all five — they are unbuilt, not undesigned.

This audit treats the tab as a strong foundation that must grow a workflow engine. Priorities: (P1)
UX/correctness quick wins — entity/field pickers from the existing enums, a DSAR detail drawer, an
SLA timer column, and capability render-gating already present but worth hardening; (P2) the DSAR
**actioning workflow** (verify → enqueue → reject → complete) with peer-review on irreversible
deletes; (P3) the consent/lawful-basis surface; (P4) the flag-gated enterprise depth — sub-processor
registry, legal holds, residency, Trust Center — which need product and legal sign-off.

## 2. Current Implementation Audit

**Route / shell.** `apps/admin/src/features/compliance/` (7 files, ~603 LOC) mounted at `/compliance`
via `app/(shell)/compliance/page.tsx`. Public surface is `CompliancePage` (the index re-exports only
it). Three surfaces render on one page: `CompliancePage` (DSAR table + status `TpSelect`),
`GlobalSuppression`, `RetentionPolicies`.

**Data access (frontend).** `api.ts` exposes seven typed `fetchWithAuth` calls; the console never
touches the DB. `useCompliance.ts` loads the DSAR queue with a status filter and `reload`.
`GlobalSuppression`/`RetentionPolicies` each own their own local load/error/busy state (no shared
hook). Four-state rendering is via `StateSwitch` (loading/empty/error/data) throughout.

**Backend.** `apps/api/src/features/admin/compliance.ts` (214 LOC). Router-level
`requireCapability("compliance:read")` on `*`; each write adds `requireCapability("compliance:manage")`.
Endpoints and their audited actions:

| Method · path | Capability | Audit action | Repository call |
|---|---|---|---|
| `GET /compliance/dsars?status&limit` | `compliance:read` | `admin.list_dsars` | `platformComplianceReadRepository.listDsarRequests` |
| `GET /compliance/suppression` | `compliance:read` | `admin.list_suppression` | `suppressionRepository.listGlobal` |
| `POST /compliance/suppression` | `compliance:manage` | `suppress.add.global` | `suppressionRepository.insert` (scope `global`, matchType `domain`) |
| `POST /compliance/suppression/:id/remove` | `compliance:manage` | `suppress.remove.global` | `suppressionRepository.removeGlobalById` |
| `GET /compliance/retention` | `compliance:read` | `admin.list_retention` | `retentionPolicyRepository.list` |
| `POST /compliance/retention` | `compliance:manage` | `retention.set` | `retentionPolicyRepository.create` |
| `PUT /compliance/retention/:id` | `compliance:manage` | `retention.set` | `retentionPolicyRepository.update` |
| `POST /compliance/retention/:id/active` | `compliance:manage` | `retention.set` | `retentionPolicyRepository.setActive` |

**Validation.** Shared Zod in `@leadwolf/types`: `platformDsarQuerySchema`, `addGlobalSuppressionSchema`
(domain `^[a-z0-9.-]+$`, reason ≤500), `retentionPolicyUpsertSchema` (entity enum, field ≤64,
`retentionDays` 1–36500), `retentionPolicySetActiveSchema`. View types `DsarOversightRow`,
`GlobalSuppressionView`, `RetentionPolicyView`. UUID path params re-checked with `UUID_RE` before the tx.

**Tables.** `dsar_requests` (`packages/db/src/schema/compliance.ts` — a RAW-of-Drizzle platform table:
`request_type` access|delete|rectify, `subject_email_enc` bytea, `subject_email_blind_index` bytea,
`status` received|verifying|processing|completed|rejected, `scope_report` jsonb, `requested_at` /
`verified_at` / `completed_at`; **no tenant FK** — a subject spans every tenant, 08 §4).
`retention_policies` (`schema/platformOps.ts` — entity, nullable field, `retention_days`, reason,
active, `created_by_user_id`, index on `(entity, id)`). `suppression_list` (`schema/billing.ts`;
the `global`-scope rows are the blocklist). `consent_records` (`schema/compliance.ts` — lawful basis
per contact × jurisdiction) **exists but has no admin UI**.

**Enforcement reach.** The `global` suppression rows written here are honored by the unbypassable
`assertNotSuppressed` gate (`packages/core/src/compliance/assertNotSuppressed.ts`) inside the reveal
and send transactions (`revealContact.ts`, `sendStep.ts`, `enrollContact.ts`) — a block added in the
console takes effect on the next reveal/send with no extra plumbing. The DSAR delete machinery
(`deleteFanout.ts`) runs under the privileged role, also writes a `global` suppression row keyed on
the blind index, and gates `completed` on a residual-PII verification scan.

**Capability gating (UI).** `useStaffMe().canMaybe("compliance:manage")` hides New/Edit/Retire/Block
controls when absent; the server still enforces (UI gate is convenience, not boundary). `compliance_officer`
holds `["audit:read","compliance:read","compliance:manage"]` in the `ROLE_CAPABILITIES` matrix;
`super_admin` implies all.

## 3. Enterprise Benchmark Research

Dedicated privacy platforms set the bar that a CRM compliance tab is measured against.

- **OneTrust DSR Automation** runs the full lifecycle in-product: regulatory-aware intake templates,
  automated identity verification (including verification *via* targeted data discovery — scanning for
  the requestor's email/phone/logins to shorten ID checks), auto-assigned subtasks, secure-message
  portals, and out-of-box ticketing integrations (Jira, ServiceNow, Zendesk, Slack). It markets a
  ~99% reduction in cost-to-fulfill and a 99.95% platform SLA. ([onetrust.com](https://www.onetrust.com/products/data-subject-request-dsr-automation/))
- **Transcend DSR Automation** handles a request "from submission until final report delivery" with
  multiple ingestion paths (Privacy Center, API, admin dashboard), **preflight checks**, and identity
  enrichment — i.e., the actioning workflow TruePoint's queue lacks. ([transcend.io](https://transcend.io/glossary/data-subject-access-request))
- **DataGrail** connects to 2,000+ systems out of the box for live data discovery, and its consent
  product manages both web and in-app/marketing-automation consent — a programmatic **consent registry**.
  ([docs.datagrail.io](https://docs.datagrail.io/docs/consent/configuration-deployment/retrieve-consent-choices/))
- **Osano Vendor Risk** maintains a continuously-monitored sub-processor inventory: a 163-criterion
  vendor score, automated sub-processor *discovery* (via cookie/data-mapping scans), and lawsuit /
  breach / policy-change alerts with downstream sub-processor visibility. ([osano.com](https://www.osano.com/products/vendor-risk))
- **Salesforce Privacy Center / Setup Audit Trail** (well-known product behaviour, not from this
  search): centralizes consent and lawful-basis tracking on the record, and the Setup Audit Trail
  retains a long, field-level history of config changes — the platform analog of an end-to-end
  compliance ledger.

**What this tab lacks against the bar:** (1) an in-console **DSAR actioning workflow** with identity
verification and SLA tracking (OneTrust/Transcend); (2) a **sub-processor registry** with monitoring
(Osano); (3) a **consent / lawful-basis surface** over the `consent_records` it already stores
(DataGrail/Salesforce). These are explicitly designed in 08 §4/§8/§10 — the gap is build, not vision.

## 4. Gap Analysis

| Capability | State | Evidence |
|---|---|---|
| DSAR queue read (PII-free) | Built | `listDsarRequests` projection omits enc/blind-index/report |
| DSAR **actioning** (verify/assign/process/reject/complete) | **Missing** | no write endpoints; `dsar.ts` queue enqueued "by apps/admin later" |
| DSAR SLA timers / alerts | Missing | no deadline column; `requestedAt` only |
| Global domain suppression r/w | Built | `suppress.add.global` / `suppress.remove.global` |
| Email-level global suppression | Missing | schema notes blind-index path is "a separate slice" |
| Suppression reason taxonomy | Weak | free-text `reason`, no enum |
| Retention policy CRUD | Built | create/update/setActive, audited `retention.set` |
| Retention *enforcement* visibility | Partial | sweep worker is separate; no last-run/affected-rows surface |
| Consent / lawful-basis UI | **Missing** | `consent_records` table exists, no admin surface |
| Sub-processor / vendor registry | Missing | designed 08 §10, no table/UI |
| Legal holds | Missing | designed implicitly; no hold table or DSAR-block |
| Data-residency controls | Missing | designed 08 §8/§13 Q7; no UI |
| Trust Center content | Missing | designed 08 §10; no surface |
| DROP / objection processing UI | Missing | objection auto-suppression exists in core, no staff trigger |

## 5. Functional Improvements

### 5.1 DSAR actioning workflow (verify → process → reject → complete)

- **Current state:** the queue is read-only; `dsar.ts` BullMQ processor and `deleteFanout.ts` /
  `assembleAccessReport` exist but are enqueued by a non-existent staff workflow.
- **Problem:** a compliance officer cannot move a request through its lifecycle from the console; the
  statutory clock runs while the only path is a manual DB poke.
- **Enterprise best practice:** OneTrust/Transcend run intake → verification → fulfillment → secure
  delivery entirely in-product with auto-assignment and subtasks.
- **Recommended implementation:** add four audited mutations on `compliance.ts`: `POST /dsars/:id/verify`
  (set `verified_at`, status `verifying`→`processing`), `POST /dsars/:id/enqueue` (push to `DSAR_QUEUE`
  with the decrypted subject email obtained *inside* the privileged tx, never returned to the client),
  `POST /dsars/:id/reject` (status `rejected` + reason), and a `GET /dsars/:id` detail read returning
  the envelope + `scope_report` (still PII-free). New enum actions `dsar.verify`, `dsar.enqueue`,
  `dsar.reject` via the standard recipe (Zod + `platformAuditAction` + `platformAuditCoverage`
  PENDING→WRITTEN + repository method + `withPlatformTx` route + `compliance:manage` gate + admin drawer).
- **Expected impact:** closes the single biggest gap; makes the tab a working DSAR console, not a viewer.
- **Dependencies:** `dsar` queue, `deleteFanout`, decrypt-subject-email helper, peer-review (5.2).
- **Priority:** Critical.

### 5.2 Peer review on irreversible DSAR deletes

- **Current state:** `jit_elevations` has an `approved_by_user_id` column but peer approval is not
  enforced (self-service v1).
- **Problem:** an erasure fan-out is irreversible and cross-tenant; one staff member triggering it
  unilaterally is a destructive-action risk.
- **Enterprise best practice:** dual-control / maker-checker on irreversible privacy operations.
- **Recommended implementation:** require a *consumed JIT elevation* in-tx on `dsars/:id/enqueue` when
  `request_type='delete'` (mirror `tenant.suspend`/`credit.adjust`), and gate `enqueue` behind a
  `dsar.delete` elevation type; later promote to true peer-approval (a second `compliance_officer`
  approves) once the workflow lands. Audit `dsar.enqueue` carries `approvedBy` metadata.
- **Expected impact:** prevents unilateral irreversible erasure; satisfies SOC 2 change-control intent.
- **Dependencies:** JIT elevation system; peer-approval workflow (DEFERRED — needs security sign-off).
- **Priority:** High.

### 5.3 DSAR SLA timers and breach alerts

- **Current state:** the table shows `requestedAt` only; no deadline.
- **Problem:** GDPR (1 month) / CCPA (45 days) clocks are invisible; a breach is discovered after the fact.
- **Enterprise best practice:** OneTrust surfaces per-request deadlines and escalates aging requests.
- **Recommended implementation:** derive a `dueAt` from `requestedAt` + a jurisdiction-aware window;
  add a "Due" column with a `StatusBadge` (overdue=danger, <72h=warning); a worker emits a metric when
  a request crosses 75%/100% of its window (see §14).
- **Expected impact:** statutory deadlines become visible and alertable.
- **Dependencies:** §14 metrics; optional jurisdiction field on `dsar_requests`.
- **Priority:** High.

### 5.4 Consent / lawful-basis surface

- **Current state:** `consent_records` (lawful basis per contact × jurisdiction, withdrawal) is written
  by core but has no admin UI.
- **Problem:** staff cannot inspect or evidence lawful basis — the core GDPR Art. 6 control is invisible.
- **Enterprise best practice:** DataGrail/Salesforce surface consent and lawful basis as queryable records.
- **Recommended implementation:** a read-only `GET /compliance/consent?contactId|jurisdiction` (PII-free
  aggregate: jurisdiction, basis, validity window, withdrawn count) gated `compliance:read`, plus a
  Consent section in the page; mutations stay in core (objection auto-suppression).
- **Expected impact:** lawful-basis becomes auditable from the console.
- **Dependencies:** `consent_records`, a bounded read repository (PLATFORM_READ_LIMIT, keyset).
- **Priority:** Medium.

## 6. Backend Improvements

### 6.1 Decrypt-on-enqueue without ever returning PII

- **Current state:** the read path is PII-free by design; there is no path that touches the subject email.
- **Problem:** enqueueing a DSAR job needs the plaintext subject email (the `dsar` job carries it), but
  it must never cross the API boundary to the client.
- **Enterprise best practice:** decrypt inside the privileged boundary, hand straight to the worker.
- **Recommended implementation:** a `dsarRequestRepository.getSubjectEmailForJob(tx, id)` that decrypts
  `subject_email_enc` *inside* `withPlatformTx`/`withPrivilegedTx`, immediately enqueues, and returns
  only `{ok:true}` to the client. Wrap in the audited `dsar.enqueue` action.
- **Expected impact:** enables actioning while preserving the privacy invariant.
- **Dependencies:** KMS/decrypt helper (the enc/blind-index key path); §5.1.
- **Priority:** Critical.

### 6.2 Sub-processor registry table + repository

- **Current state:** none; 08 §10 designs a maintained sub-processor list.
- **Problem:** no system of record for enrichment providers / Stripe / AWS as DPA sub-processors.
- **Enterprise best practice:** Osano maintains a monitored sub-processor inventory.
- **Recommended implementation:** new platform table `sub_processors` via the recipe (`schema/platformOps.ts`
  + `bun generate` + `rls/platformOps.sql` deny-all + REVOKE in `applyMigrations.ts`); columns name,
  purpose, region, dpa_url, status, review_due_at. `subProcessorRepository` + audited `subprocessor.set`.
- **Expected impact:** a real vendor system of record; feeds a future Trust Center.
- **Dependencies:** §7 table recipe; product owner for the catalog.
- **Priority:** Medium.

### 6.3 Legal-hold table that blocks erasure

- **Current state:** none; `deleteFanout` always proceeds for a verified delete.
- **Problem:** an active legal hold must override a deletion request; today nothing can.
- **Enterprise best practice:** legal holds suspend retention/erasure for named subjects/scopes.
- **Recommended implementation:** `legal_holds` platform table (subject blind index or scope, reason,
  active, created_by); `deleteFanout` and the retention sweep check for an active hold and skip + record;
  audited `legal_hold.set`/`legal_hold.release`.
- **Expected impact:** erasure cannot violate a hold — a hard compliance requirement.
- **Dependencies:** §7; §5.1; blind-index helper.
- **Priority:** Medium.

## 7. Database Improvements

### 7.1 DSAR jurisdiction + due-by columns

- **Current state:** `dsar_requests` has no jurisdiction or deadline.
- **Problem:** SLA windows differ by regime and cannot be computed.
- **Enterprise best practice:** per-request regulatory context drives the SLA.
- **Recommended implementation:** add nullable `jurisdiction varchar(2)` and a generated/derived `due_at`
  (or compute in the view); migration via `bun generate`, no RLS change (already deny-all).
- **Expected impact:** enables §5.3 timers.
- **Dependencies:** migration; view update.
- **Priority:** High.

### 7.2 Suppression reason taxonomy

- **Current state:** `reason` is free-text on both `addGlobalSuppressionSchema` and the row.
- **Problem:** no aggregation/reporting of *why* domains are blocked (objection vs bounce vs abuse).
- **Enterprise best practice:** categorized suppression reasons.
- **Recommended implementation:** add a `reason_code` enum column (`objection|opt_out|bounce|complaint|abuse|other`)
  alongside free-text; Zod enum in `addGlobalSuppressionSchema`; backfill `other`.
- **Expected impact:** reportable blocklist; cleaner audit metadata.
- **Dependencies:** migration; `@leadwolf/types` enum; UI dropdown (§12).
- **Priority:** Medium.

### 7.3 Index for the status-filtered DSAR scan

- **Current state:** `listDsarRequests` filters by `status` and orders by `id` desc; no status index.
- **Problem:** at scale, the status filter is a heap scan.
- **Enterprise best practice:** index the queue's filter+sort.
- **Recommended implementation:** `create index dsar_requests_status_id_idx on dsar_requests(status, id desc)`.
- **Expected impact:** keyset-friendly, fast status filtering.
- **Dependencies:** migration.
- **Priority:** Low.

## 8. API Improvements

### 8.1 Keyset cursor + total on the DSAR read

- **Current state:** `listDsarRequests` caps at `min(limit,500)` and returns a flat array, no cursor.
- **Problem:** a large global queue can exceed 500 with no next page.
- **Enterprise best practice:** keyset pagination consistent with the platform's `PLATFORM_READ_LIMIT`
  base64url cursor (limit+1 probe).
- **Recommended implementation:** return `{dsars, nextCursor}` using the established keyset pattern on
  `id`; accept `?cursor=`.
- **Expected impact:** the queue scales past one page.
- **Dependencies:** none new (pattern exists in `platformAdminReads`).
- **Priority:** Medium.

### 8.2 Idempotency-Key on suppression/retention writes

- **Current state:** no idempotency key on any compliance mutation.
- **Problem:** a retried "Block domain" or "New policy" double-writes.
- **Enterprise best practice:** Idempotency-Key on side-effecting POSTs (Stripe model).
- **Recommended implementation:** accept `Idempotency-Key`, persist a key→result map in the platform tx,
  short-circuit replays. (DEFERRED at program level — same infra as the credit endpoint; needs the
  idempotency store.)
- **Expected impact:** safe retries; no duplicate blocks/policies.
- **Dependencies:** idempotency store (DEFERRED — infra sign-off).
- **Priority:** Medium.

## 9. Dependency Mapping

- **DB tables:** `dsar_requests`, `consent_records` (`schema/compliance.ts`); `retention_policies`
  (`schema/platformOps.ts`); `suppression_list` (`schema/billing.ts`, `global` rows);
  `platform_audit_log` (raw, written by every mutation); `jit_elevations` (for §5.2 deletes).
- **Services / repositories:** `platformComplianceReadRepository.listDsarRequests`;
  `suppressionRepository.{listGlobal,insert,removeGlobalById}` (+ `findMatch` in the gate);
  `retentionPolicyRepository.{list,create,update,setActive}`; `withPlatformTx`/`withPrivilegedTx`
  (`packages/db/src/client.ts`); `dsarRequestRepository`, `dsarFanoutRepository` (core fan-out).
- **API endpoints:** the eight `/api/v1/admin/compliance/*` routes in §2.
- **Event flow:** console → `fetchWithAuth` → Hono chain (authn `pa` → platformAdmin → `compliance:read`
  → `compliance:manage` on writes) → `withPlatformTx` (audit row + fn atomic) → repository → Postgres
  owner connection (BYPASSRLS). A global suppression write is then read by `assertNotSuppressed` inside
  the next reveal/send tx.
- **Background workers:** `dsar` BullMQ queue (`apps/workers/src/queues/dsar.ts`) running `deleteFanout`
  / `assembleAccessReport`; the retention **sweep** worker (separate, consumes `retention_policies`).
- **Queue dependencies:** Redis/BullMQ for `DSAR_QUEUE`; the queue is the only async path off this tab.
- **Permission/capability dependencies:** `compliance:read` (router), `compliance:manage` (writes);
  `compliance_officer` role grants both + `audit:read`; `super_admin` implies; re-checked per request.
- **Feature-flag dependencies:** none today; §17 introduces `compliance.dsar_actioning`,
  `compliance.consent_ui`, `compliance.subprocessors`, `compliance.legal_holds`, `compliance.residency`.
- **External integrations:** KMS/decrypt for `subject_email_enc` (enqueue path); none in the current
  read/suppression/retention paths.
- **Cross-module dependencies:** the reveal engine (`revealContact.ts`), outreach send (`sendStep.ts`,
  `enrollContact.ts`), and email governance (`governance.ts`) all consume `global` suppression rows;
  the audit-log tab reads `admin.list_*` / `suppress.*` / `retention.set` actions; `@leadwolf/types`
  owns the Zod contracts and the `platformAuditAction` enum guarded by `platformAuditCoverage.test.ts`.

## 10. Security Review

- **Privacy-preserving reads — strong.** `listDsarRequests` and `listGlobal` omit `subject_email_enc`,
  `subject_email_blind_index`, and `scope_report`; HMACs of PII never leave the DB. Keep this invariant
  in any new read (§5.4 consent, §6 detail).
- **Isolation — correct.** `dsar_requests` and `retention_policies` are platform tables, deny-all to
  `leadwolf_app` (RLS ENABLE + REVOKE in `applyMigrations.ts`), reachable only via the owner connection
  inside `withPlatformTx`. `removeGlobalById` pins `scope='global'` so a tenant/workspace suppression
  row can never be deleted through the staff path — good.
- **Untrusted input.** Domain regex + length caps, `retentionDays` bounds (1–36500), UUID re-check on
  path params. Add the `reason_code` enum (§7.2) to stop free-text drift.
- **Destructive-action control — gap.** The future DSAR delete enqueue is irreversible and cross-tenant;
  it MUST consume a JIT elevation in-tx (§5.2) and SHOULD require peer approval (DEFERRED — security
  sign-off). The decrypt-on-enqueue helper (§6.1) must never return plaintext to the client.
- **Legal hold as a safety interlock (DEFERRED).** Until §6.3 lands, nothing prevents an erasure that
  violates a hold; document as a known risk (§15) with security ownership.
- **Audit completeness.** Every mutation is audited; reads are `admin.list_*`. New actions must pass the
  `platformAuditCoverage` PENDING→WRITTEN attestation before merge.

## 11. Performance Review

- The DSAR read is a single bounded query (`limit ≤ 500`, order by `id`); add the `(status, id desc)`
  index (§7.3) and keyset cursor (§8.1) before the global queue grows.
- `listGlobal` is bounded to 500 and ordered by `created_at` desc — fine for a curated blocklist; if it
  grows, add `(scope, created_at)` and a cursor.
- `retentionPolicyRepository.list` is capped at 200 with an `(entity, id)` index — adequate.
- Each surface fires its own load on mount (three independent fetches). Acceptable; consider a single
  `/compliance/overview` aggregate only if the page becomes fetch-heavy.

## 12. UX/UI Improvements

### 12.1 DSAR detail drawer

- **Current state:** the table truncates `id` to 8 chars; no row detail; no `scope_report` view.
- **Problem:** an officer cannot inspect a request's state, timeline, or erasure proof.
- **Enterprise best practice:** a request detail pane with timeline and audit trail.
- **Recommended implementation:** a `Dialog`/drawer on row click showing full id, status timeline,
  `scope_report` (PII-free), and the matching `platform_audit_log` entries; copy-id affordance.
- **Expected impact:** real oversight, not just a list.
- **Dependencies:** `GET /dsars/:id` (§5.1); audit-log read by `targetId`.
- **Priority:** High.

### 12.2 Field picker keyed to the selected entity

- **Current state:** retention `field` is a free `TpInput` placeholder "e.g. email".
- **Problem:** a typo (`emial`) silently creates a policy that matches nothing.
- **Enterprise best practice:** dependent dropdowns from a known schema.
- **Recommended implementation:** drive the field `TpSelect` from a per-entity field map (`contact →
  [email, phone, …]`), with "whole entity" as the default; keep free-text only behind an "advanced" toggle.
- **Expected impact:** no silently-dead policies.
- **Dependencies:** an entity→field map in `@leadwolf/types`.
- **Priority:** Medium.

### 12.3 Suppression reason-code dropdown

- **Current state:** free-text reason on the block form.
- **Problem:** unaggregatable, inconsistent.
- **Enterprise best practice:** categorized reasons.
- **Recommended implementation:** a `TpSelect` of `reason_code` (§7.2) plus optional free-text note.
- **Expected impact:** reportable, consistent blocklist.
- **Dependencies:** §7.2 enum.
- **Priority:** Medium.

### 12.4 Harden capability render-gating + read-only banner

- **Current state:** controls hide via `canMaybe("compliance:manage")`; a `read_only`/`support` viewer
  sees tables with no controls and no explanation.
- **Problem:** silent absence reads as a bug.
- **Enterprise best practice:** explicit "view-only" affordance.
- **Recommended implementation:** when `!canManage`, show a small "View-only — compliance:manage required"
  note on each section header; keep server enforcement authoritative.
- **Expected impact:** clearer RBAC UX.
- **Dependencies:** `useStaffMe`.
- **Priority:** Low.

## 13. Automation Opportunities

- **Auto-suppression already exists in core** (objection/opt-out → `global` suppression row): surface a
  staff "record objection" action that triggers it from a contact/subject context rather than only via
  the user-facing path.
- **SLA escalation worker:** a scheduled job that flags DSARs crossing 75%/100% of their window and
  emits a metric/alert (§5.3, §14).
- **Retention sweep dry-run preview:** before a policy goes active, compute affected-row counts so an
  officer sees the blast radius (read-only, bounded).
- **Sub-processor review reminders:** when §6.2 lands, a job that flags `review_due_at` lapses.

## 14. Monitoring & Logging

- **Audit (have):** every mutation writes `platform_audit_log` (action, actor, target, reason metadata)
  atomically; reads logged as `admin.list_dsars|list_suppression|list_retention`.
- **Add:** metrics `dsar_open_total{status}`, `dsar_sla_breach_total`, `dsar_age_seconds` histogram;
  `suppression_global_total`; `retention_policy_active_total`. Emit a structured warn when a DSAR
  crosses an SLA threshold and when a delete fan-out's verification scan finds residuals (it already
  computes `liveCopies/piiOnTombstones/dependents`).
- **Alerting:** page on `dsar_sla_breach_total > 0` and on any fan-out that fails to reach `completed`
  after N retries.

## 15. Risks

- **DSAR statutory-clock risk (High):** no actioning UI and no SLA timer means deadlines can lapse
  unseen. Mitigate with §5.1 + §5.3.
- **Irreversible erasure without dual control (High):** once §5.1 lands, a single officer can trigger a
  cross-tenant erase; mitigate with §5.2 JIT-elevation + peer review (DEFERRED).
- **Legal-hold violation (Medium):** erasure cannot currently be blocked by a hold; mitigate with §6.3.
- **Lawful-basis invisibility (Medium):** `consent_records` is unauditable from the console; §5.4.
- **Free-text reason drift (Low):** §7.2/§12.3.
- **Queue growth past 500 (Low):** mitigate with §8.1/§7.3.

## 16. Technical Debt

- `consent_records` is a built table with **no surface** — schema-product debt.
- DSAR oversight is read-only while the fan-out engine is complete — a half-wired workflow whose other
  half ("apps/admin later") was deferred and never scheduled.
- `retention.set` is reused for create/update/setActive — coarse audit granularity; acceptable but
  consider `retention.create|update|toggle` if forensic precision is later required.
- Three independent per-section fetches with duplicated load/error/busy state — minor; a shared hook
  would dedupe.
- Idempotency-Key absent on writes — same deferred infra gap as the credit endpoint.

## 17. Multi-Phase Implementation Plan

### Phase 1 — UX & correctness quick wins (High)

- **Objectives:** make the existing surfaces safe and legible without new infra.
- **Scope:** DSAR detail drawer (read), entity→field picker, suppression reason-code enum, view-only
  banner, `(status,id)` index + keyset cursor on the DSAR read.
- **Deliverables:** `GET /compliance/dsars/:id`; field map + `reason_code` enum in `@leadwolf/types`;
  UI dropdowns + drawer; migration for index + `reason_code` + jurisdiction/due columns.
- **Technical tasks:** add Zod + view types; repository detail method; UI `Dialog`; migration via
  `bun generate`; wire keyset cursor from `platformAdminReads`.
- **Risks:** low; additive.
- **Dependencies:** none new.
- **Testing requirements:** itests for the detail read (PII-free assertion), cursor paging, enum
  validation; `platformAuditCoverage` unchanged (read-only additions).
- **Estimated complexity:** S–M.
- **Success criteria:** an officer can open a DSAR, see its timeline, and filter/paginate; no free-text
  field/reason reaches the DB.

### Phase 2 — DSAR actioning workflow (Critical)

- **Objectives:** turn oversight into a working DSAR console.
- **Scope:** verify / enqueue / reject / complete; decrypt-on-enqueue; JIT-elevation on delete; SLA timer.
- **Deliverables:** `POST /dsars/:id/verify|enqueue|reject`; `dsar.verify|enqueue|reject` enum actions;
  `getSubjectEmailForJob` privileged decrypt; SLA "Due" column + escalation metric/worker.
- **Technical tasks:** full recipe per mutation (Zod + enum + `platformAuditCoverage` PENDING→WRITTEN +
  repository + `withPlatformTx` route + `compliance:manage` gate + drawer action); enqueue to `DSAR_QUEUE`;
  consume elevation in-tx when `request_type='delete'`.
- **Risks:** irreversible erasure (mitigate: elevation + dry-run + verification scan already gates
  `completed`); PII leakage on enqueue (mitigate: decrypt inside privileged tx, return `{ok:true}`).
- **Dependencies:** KMS/decrypt; `dsar` queue; JIT elevations; peer review (DEFERRED).
- **Testing requirements:** itests that enqueue never returns plaintext; delete requires a consumed
  elevation; reject/verify transitions; coverage attestation for all new actions.
- **Estimated complexity:** L.
- **Success criteria:** a verified delete request flows console → fan-out → `completed` with full audit
  and no PII over the wire.

### Phase 3 — Consent & lawful-basis surface (Medium)

- **Objectives:** make lawful basis auditable from the console.
- **Scope:** read-only consent surface over `consent_records`; record-objection action.
- **Deliverables:** `GET /compliance/consent`; bounded PII-free repository; page section; objection action
  that triggers the existing core auto-suppression.
- **Technical tasks:** repository with keyset + PLATFORM_READ_LIMIT; Zod view; `compliance:read` gate;
  audited `consent.objection.record` if a mutation is added.
- **Risks:** PII exposure (mitigate: aggregate/PII-free projection).
- **Dependencies:** `consent_records`; core objection path.
- **Testing requirements:** PII-free projection itest; objection→suppression integration.
- **Estimated complexity:** M.
- **Success criteria:** an officer can evidence lawful basis and record an objection from the console.

### Phase 4 — Enterprise depth (flag-gated) (Medium/Low)

- **Objectives:** sub-processor registry, legal holds, residency, Trust Center.
- **Scope:** `sub_processors` + `legal_holds` platform tables and surfaces; residency controls; Trust
  Center content; legal-hold interlock in `deleteFanout`/sweep.
- **Deliverables:** two new platform tables (full table recipe: `schema/platformOps.ts` + `bun generate`
  + `rls/platformOps.sql` deny-all + REVOKE); `subProcessorRepository`/`legalHoldRepository`; audited
  `subprocessor.set`, `legal_hold.set|release`; flags `compliance.subprocessors`,
  `compliance.legal_holds`, `compliance.residency`.
- **Technical tasks:** schema + RLS + migrations; hold check in fan-out and sweep; residency policy model
  (needs product/legal); Trust Center static surface.
- **Risks:** scope/ownership ambiguity (mitigate: ship behind flags, table-first); legal-hold correctness
  (mitigate: deny-by-default — a hold blocks erasure).
- **Dependencies:** product owner for the sub-processor catalog; **legal/security sign-off** for residency
  and hold semantics; peer-approval and KMS (DEFERRED items) where relevant.
- **Testing requirements:** RLS deny-all itests for both tables; "active hold blocks erasure" itest;
  coverage attestation for new actions.
- **Estimated complexity:** L.
- **Success criteria:** a hold provably blocks a delete; a sub-processor inventory exists with review
  reminders; residency is a documented, flag-gated control.

## 18. Final Recommendations

### 18.1 Ship the DSAR actioning workflow (Critical)

- **Current state:** read-only queue over a complete-but-unreachable fan-out engine.
- **Problem:** the statutory workflow has no console path; deadlines lapse unseen.
- **Enterprise best practice:** OneTrust/Transcend run the full DSR lifecycle in-product.
- **Recommended implementation:** Phase 2 — verify/enqueue/reject, decrypt-on-enqueue, JIT-elevation on
  delete, SLA timers.
- **Expected impact:** the single highest-leverage change; makes the tab functionally complete.
- **Dependencies:** KMS/decrypt, `dsar` queue, JIT elevations, peer review (DEFERRED).
- **Priority:** Critical.

### 18.2 Land Phase-1 correctness/UX before depth (High)

- **Current state:** free-text field/reason, no detail drawer, no SLA column, no cursor.
- **Problem:** small footguns and blind spots in a high-stakes surface.
- **Enterprise best practice:** typed, paginated, inspectable compliance UIs.
- **Recommended implementation:** Phase 1.
- **Expected impact:** removes silent-failure modes cheaply; unblocks Phase 2.
- **Dependencies:** none new.
- **Priority:** High.

### 18.3 Enforce dual control on irreversible erasure (High)

- **Current state:** elevations exist but peer approval is not enforced; deletes would be unilateral.
- **Problem:** irreversible cross-tenant erasure with single control is a SOC 2 / safety risk.
- **Enterprise best practice:** maker-checker on irreversible privacy ops.
- **Recommended implementation:** consume a JIT elevation in-tx now; promote to peer approval when ready.
- **Expected impact:** prevents catastrophic unilateral erasure.
- **Dependencies:** peer-approval workflow (DEFERRED — security sign-off).
- **Priority:** High.

### 18.4 Close the schema-product gaps behind flags (Medium)

- **Current state:** `consent_records` unsurfaced; no sub-processor/legal-hold/residency tables.
- **Problem:** designed controls (08 §8/§10) are absent from the product.
- **Enterprise best practice:** Osano/DataGrail registries and consent surfaces.
- **Recommended implementation:** Phases 3–4, flag-gated, table-first, with legal/security sign-off on
  residency and hold semantics.
- **Expected impact:** moves TruePoint from "DSAR viewer" toward an enterprise privacy console.
- **Dependencies:** product + legal/security; KMS; DEFERRED items as noted.
- **Priority:** Medium.

**Bottom line:** the Compliance tab is correctly built and uniquely complete on its read/suppression/
retention paths, with a strong privacy-by-construction posture. Its value gap is the **DSAR actioning
workflow** — wiring the console to the fan-out engine that already exists — followed by surfacing the
consent data it already stores and, behind flags, the sub-processor/legal-hold/residency depth that
08 §8/§10 already designed.
