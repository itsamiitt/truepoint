---
title: "Platform Admin Audit — Platform Audit Log Tab"
tab: audit-log
status: read-only
last_audited: 2026-06-29
owner: platform-admin
---

## Executive Summary

The **Platform Audit Log** tab (`/audit-log`) is the read surface over `platform_audit_log` — the append-only, cross-tenant record of every privileged staff action in TruePoint. It is the *output* side of the audit machinery the rest of the console feeds: every `withPlatformTx(actor, action, fn, target)` call in `packages/db/src/client.ts` writes one row here in the same transaction as the mutation it records (both commit or both roll back). This tab is therefore the compliance officer's single pane onto "who did what, to which tenant, from which IP, when."

Status is **read-only** by design, and the implementation is genuinely solid for what it claims to be. Two endpoints — `GET /api/v1/admin/audit-log` (keyset-paginated, AND-filtered) and `GET /api/v1/admin/audit-log/export` (bounded CSV) — back `platformAuditReadRepository.{listPage,exportRows}`. The read path is correct on the fundamentals an auditor checks first: it runs on the BYPASSRLS owner connection through `withPlatformTx` (the *only* connection that may read the table — `leadwolf_app` is RLS deny-all + `REVOKE`d), it is bounded by `PLATFORM_READ_LIMIT = 500` with an opaque `(occurred_at, id)` base64url keyset cursor (no offset, no unbounded scan), the table is append-only at the database (a `BEFORE UPDATE OR DELETE` trigger raises for *every* role including the owner), the free-form `metadata` JSONB is deliberately withheld from the list projection (privacy), the CSV export neutralizes leading `=+-@` formula-injection characters, and **the export of the trail is itself an audited action** (`audit.export`). The `platformAuditCoverage.test.ts` drift guard holds the closed `platformAuditAction` vocabulary to a PENDING→WRITTEN attestation so no action string can be added or removed silently.

The gaps are not correctness gaps in the read path; they are **detective-control and investigative-depth** gaps — the difference between a *log viewer* and an *audit platform*. Filters are exact-match and AND-only (no OR, no free-text, no `metadata` search), so "show me every high-risk action by actor X OR Y in the last hour" is impossible. There is **no anomaly detection** on privileged actions — nobody is alerted when a `super_admin` issues ten `credit.adjust` grants at 3am, even though that is precisely the event an audit log exists to catch. There are **no saved views**, **no per-action analytics/dashboards**, **no SIEM/log-streaming export** (the trail lives and dies in one Postgres table — no S3, no Splunk, no immutable off-box copy), **no WORM/integrity attestation surfaced** to the auditor (the append-only trigger exists but the UI never proves it), and the actor/tenant filters take **raw UUIDs** with no entity picker. Finally, ADR-0031's tenant-less identity events (`login.failure`, `mfa.*`, `staff.login*`) are defined in the enum but remain **PENDING** — they route here in principle but most are not yet wired, so the audit log is presently blind to authentication-layer activity. None of the deferred items below (SIEM streaming, anomaly engine, integrity-digest export) are claimed to exist; they are specified as implementation-ready designs needing infra/security sign-off.

## Current Implementation Audit

**Frontend** (`apps/admin/src/features/audit-log/*`, 6 files, ~316 LOC):

| File | Role |
|---|---|
| `components/AuditLogPage.tsx` (~245 LOC) | The whole surface: header + Export CSV button, AND-combined filter bar (action / tenant id / actor id / from / to date), Apply/Reset, `DataTable` (Time / Action / Actor / Target / Tenant / IP), `StateSwitch` four-state, keyset "Load more" |
| `api.ts` | The data seam — `fetchAuditLog(filters, cursor?)` and `exportAuditLog(filters)` via `fetchWithAuth` against `/api/v1/admin/audit-log`; `PAGE_SIZE = 50`; export fetches the blob with the bearer token then triggers a client-side `<a download>` |
| `hooks/useAuditLog.ts` | Vanilla-React load hook holding `{entries, nextCursor, filters, loading, loadingMore, error}` with separate initial-load vs append flags — **no TanStack Query** |
| `types.ts` | `PlatformAuditEntry` view shape + `AuditLogFilters` — presentation mirrors of `@leadwolf/types` `platformAuditEntrySchema` |
| `format.ts` | Pure, DOM-free helpers: `shortDateTime` (UTC `YYYY-MM-DD HH:MM:SSZ`), `shortId` (first UUID segment), `targetLabel` (`type · id`) |
| `index.ts` | Public barrel: `export { AuditLogPage }` |

The route mounts at `apps/admin/src/app/(shell)/audit-log/page.tsx`. The page converts the two `<input type="date">` values to UTC day bounds (`dayStart` → `T00:00:00.000Z`, `dayEnd` → `T23:59:59.999Z`) before sending them as the `since`/`until` ISO datetimes the API expects.

**Backend** (`apps/api/src/features/admin/auditLog.ts`, 108 LOC) — `auditLogRoutes`, mounted under `/api/v1/admin/audit-log` (so the parent router has already applied authn (`pa` claim) + the coarse `platformAdmin` gate):

| Method + path | Gate | Audit action | Repo call | Notes |
|---|---|---|---|---|
| `GET /` | `requireCapability("audit:read")` | `admin.read_audit_log` (raw string) | `platformAuditReadRepository.listPage(tx, q)` | keyset page (`limit`+1 probe), newest-first, `metadata` not projected |
| `GET /export` | `requireCapability("audit:read")` | `audit.export` (**enum**, WRITTEN) | `platformAuditReadRepository.exportRows(tx, filters)` | CSV blob, bounded `AUDIT_EXPORT_CAP = 5000`, formula-escaped, filters recorded in the audit row's `metadata` |

`requireCapability("audit:read")` is applied once via `auditLogRoutes.use("*", ...)`, so even the *read* of the trail is restricted to the two roles accountable for it. Per `ROLE_CAPABILITIES` in `packages/types/src/staffCapability.ts`, `audit:read` belongs to **`compliance_officer`** and (by the super_admin short-circuit) **`super_admin`** — `support`, `billing_ops`, and `read_only` cannot read the audit log at all. `actorOf(c)` derives `{userId: claims.sub, ip: x-forwarded-for[0]}` server-side; the IP is never client-asserted in the body.

**Repository** (`packages/db/src/repositories/platformAuditReads.ts`, ~210 LOC): `platformAuditReadRepository` exposes `listRecent`, `listPage`, `exportRows`, and the customer-facing `listTenantStaffAccess`. `filterConds(q)` builds bound AND predicates (`action = $`, `tenant_id = $::uuid`, `actor_user_id = $::uuid`, `occurred_at >= $::timestamptz`, `occurred_at < $::timestamptz`). The keyset is row-value: `(occurred_at, id) < ($::timestamptz, $::uuid)` ordered `occurred_at DESC, id DESC`, encoded `base64url("<iso>|<uuid>")`. All reads use hand-written `sql` against the **raw** table (it is not in the Drizzle schema) and must run inside a `withPlatformTx` owner transaction.

**Table** (`packages/db/src/rls/platform.sql` + self-heal in `bootstrapAdmin.ts`): `platform_audit_log` — `id uuid PRIMARY KEY DEFAULT uuid_generate_v7()` (time-ordered UUID, which is what makes the `(occurred_at, id)` keyset stable), `actor_user_id uuid NOT NULL`, `action text NOT NULL`, `target_type text`, `target_id text`, `tenant_id uuid`, `workspace_id uuid`, `ip text`, `metadata jsonb`, `occurred_at timestamptz NOT NULL DEFAULT now()`. Lockdown posture: `ENABLE ROW LEVEL SECURITY` (not FORCE — the owner writer must stay exempt) with **no policy** (deny-all to `leadwolf_app`), a `BEFORE UPDATE OR DELETE` trigger `platform_audit_log_append_only()` that raises for every role, a blanket `REVOKE ALL` from `leadwolf_app` in `applyMigrations.ts` (defence-in-depth), and a partial index `idx_platform_audit_tenant_time ON (tenant_id, occurred_at DESC) WHERE tenant_id IS NOT NULL` for the customer staff-access read.

> **Correction to the brief.** The `id` column is a **time-ordered `uuid` (`uuid_generate_v7`)**, *not* `BIGSERIAL` — the keyset cursor casts `id::uuid` and the Zod `platformAuditEntrySchema.id` is `z.string().uuid()`. Treat the `uuid` shape as ground truth.

**Vocabulary & drift guard** (`packages/types/src/platformAudit.ts`, `platformAuditCoverage.test.ts`): the closed `platformAuditAction` enum is partitioned into WRITTEN (has a verified call-site — `tenant.suspend`, `credit.adjust`, `audit.export`, `password.reset.*`, …) and PENDING (defined, not yet wired — `impersonation.start/end`, `feature_flag.set`, `provider_config.update`, `staff.login*`, `login.failure`, `mfa.*`). The three tests assert WRITTEN ∪ PENDING exactly covers the enum, are disjoint, and contain no stale literal. The audit-log endpoints' own read action `admin.read_audit_log` is a **raw `admin.list_*`-style string** (deliberately *not* an enum mutation — reads are recorded but not part of the closed mutation vocabulary).

## Enterprise Benchmark Research

Grounded comparisons against named audit/observability/IAM products this tab can learn from:

1. **Salesforce Setup Audit Trail — 180-day retention + CSV download, and Shield Event Monitoring for the gaps.** Salesforce retains Setup Audit Trail entries for a rolling 180 days and lets an admin download the full window as CSV; field-level before/after values and login/API/export behaviour are explicitly *not* in the basic trail and require the paid **Shield Event Monitoring** add-on. TruePoint matches the CSV-download model but has **no stated retention/rotation policy** on `platform_audit_log` (it grows unbounded forever) and **no event-monitoring tier** for auth/login/export behaviour. (Source: Salesforce Help, *Monitor Setup Changes with Setup Audit Trail*; *Field Audit Trail*.)

2. **AWS CloudTrail — tamper-evident log file integrity validation (hash-chained, signed digest files).** CloudTrail emits an hourly *digest file* containing the SHA-256 hash of every delivered log file plus the digital signature of the *previous* digest, forming a hash chain so any modification or deletion after delivery is cryptographically detectable; the digest is signed SHA-256-with-RSA and validated with a public key. TruePoint's trail is append-only *at the database* (a trigger blocks UPDATE/DELETE), which is good, but there is **no cryptographic integrity attestation** — a DBA with owner access or a restore-from-backup could rewrite history with no detectable break, and nothing surfaces an integrity proof to the auditor. (Source: AWS CloudTrail User Guide, *Validating CloudTrail log file integrity*.)

3. **Okta System Log — real-time Log Streaming to Splunk/S3 + 90-day API window.** Okta retains System Log events for 90 days and ships **Log Streaming**, which automatically forwards every event in real time to a Splunk Cloud HTTP Event Collector or an AWS account, after which the customer's SIEM retention applies. TruePoint has **no streaming/forwarding path at all** — the audit trail is captive in one Postgres table with no SIEM connector, no off-box immutable copy, and no way to alert or correlate in an external security tool. (Source: Okta Help, *Log streaming*; *Access and Export Okta System Log Events*.)

4. **Datadog Audit Trail — anomaly monitors on privileged actions.** Datadog's Audit Trail provides immutable records of admin activity and lets you build **Audit Trail monitors** that alert when an event type crosses a threshold or deviates anomalously (mass permission changes, off-hours logins), and feed events into Cloud SIEM for threat signals. TruePoint has **zero detective alerting** — no threshold, no anomaly, no off-hours rule on `credit.adjust`/`tenant.suspend`/`impersonation.start`; the log is purely forensic-after-the-fact, never proactive. (Source: Datadog Docs, *Audit Trail* and *Audit Trail Monitor*.)

## Gap Analysis

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | No anomaly/threshold alerting on privileged actions | Critical | No worker/monitor consumes `platform_audit_log`; Datadog/Okta both alert |
| G2 | No SIEM streaming / immutable off-box export (S3, Splunk) | High | Trail captive in one Postgres table; Okta Log Streaming is table-stakes |
| G3 | No cryptographic integrity / WORM attestation surfaced | High | Append-only trigger exists but no hash-chain proof (cf. CloudTrail) |
| G4 | Filters are exact-match + AND-only; no OR / free-text / `metadata` search | High | `filterConds` builds only `=` predicates joined by AND |
| G5 | Actor/tenant filters take raw UUIDs (no entity picker) | Medium | `TpInput placeholder="tenant UUID"` in `AuditLogPage.tsx` |
| G6 | No saved views / segments; filters reset every visit | Medium | `useAuditLog` starts from `{}`; nothing persisted |
| G7 | No per-action analytics / dashboard (counts, top actors, trends) | Medium | Only a flat table; no aggregation endpoint |
| G8 | ADR-0031 tenant-less identity events still PENDING (auth blind spot) | High | `login.failure`/`mfa.*`/`staff.login*` in PENDING set |
| G9 | No retention/rotation policy on the table (unbounded growth) | Medium | No TTL/partitioning; Salesforce caps at 180 days |
| G10 | Action filter has no enum dropdown (free-text, typo-prone) | Low | `placeholder="e.g. tenant.suspend"` raw string |
| G11 | No render-gate via `useStaffMe().canMaybe("audit:read")` on the nav/tab | Low | Server gates correctly; UI shows tab to non-readers then 403s |

## Functional Improvements

### F1 — Enum dropdown + entity pickers for filters

- **Current state:** action, tenant id, actor id are three free-text `TpInput`s; the user copy-pastes raw UUIDs and a typo silently returns zero rows.
- **Problem:** unusable for real investigation; no validation feedback; a mistyped UUID looks identical to "no matching events."
- **Enterprise best practice:** Datadog/Okta facet filters present a closed, searchable value list per field, not a free-text box.
- **Recommended implementation:** replace the action `TpInput` with a `TpSelect` populated from `platformAuditAction.options`; replace tenant/actor `TpInput`s with the shared async picker (the same one the Tenants/Users tabs use) that searches by name/email and emits the UUID. Keep the URL contract (`action`, `tenantId`, `actorUserId`) unchanged.
- **Expected impact:** investigations go from copy-paste-a-GUID to type-a-name; eliminates the silent-empty-result class of error.
- **Dependencies:** existing tenant/user search endpoints; `platformAuditAction` export.
- **Priority:** High

### F2 — Saved views / shareable filter URLs

- **Current state:** `useAuditLog` initializes filters to `{}` on every mount; nothing is persisted or shareable.
- **Problem:** a compliance officer re-types the same "all `credit.adjust` last 30 days" filter every session and cannot hand a colleague a link to the exact view.
- **Enterprise best practice:** Datadog/Splunk saved searches and shareable query URLs.
- **Recommended implementation:** mirror the active filters into the URL query string (`useSearchParams`), hydrate `useAuditLog` from it on mount, and add a small "saved views" list persisted per-staff (new `platform_saved_views` table or a JSON column on `platform_staff`). Phase 1 can ship URL-sync alone (no schema).
- **Expected impact:** repeatable, shareable investigations; deep-linkable evidence in incident tickets.
- **Dependencies:** none for URL-sync; a table for persisted views.
- **Priority:** Medium

### F3 — Metadata detail drawer (governed)

- **Current state:** the rich `metadata` JSONB (e.g. impersonation reason, credit delta) is never surfaced; the list shows only the structured envelope.
- **Problem:** the *why* of an action lives in `metadata`, but an auditor cannot see it at all, defeating much of the trail's investigative value.
- **Enterprise best practice:** CloudTrail/Okta expand each event to its full JSON payload (access-controlled).
- **Recommended implementation:** add `GET /api/v1/admin/audit-log/:id` that returns the single row *including* `metadata`, gated by a new finer capability `audit:read:detail` (super_admin + compliance_officer only), itself audited as `admin.read_audit_detail`. A row click opens a `Drawer` rendering the envelope + pretty-printed `metadata`. The list endpoint still withholds `metadata`.
- **Expected impact:** turns the trail from "what happened" into "what and why" without broadening list exposure.
- **Dependencies:** new capability string; `withPlatformTx` route; design `Drawer`.
- **Priority:** Medium

## Backend Improvements

### B1 — Anomaly/threshold detection worker on privileged actions

- **Current state:** nothing consumes `platform_audit_log` after write; it is purely forensic.
- **Problem:** the single most valuable thing an audit log does — *catch* an abnormal privileged action while it is happening — is absent. A compromised `super_admin` issuing bulk `credit.adjust` or `impersonation.start` raises no alarm.
- **Enterprise best practice:** Datadog Audit Trail monitors (threshold + anomaly + off-hours); Okta detection rules.
- **Recommended implementation:** add an `apps/workers` BullMQ job `audit-anomaly-scan` (scheduled, e.g. every 5 min) that reads new rows via a dedicated owner-connection repo method `platformAuditReadRepository.sinceWatermark(tx, ts)` and evaluates rules from a config table `audit_alert_rules` (action pattern, window, count threshold, off-hours flag). Breaches emit a structured alert (PagerDuty/Slack via the ops notifier) and write an `audit.alert.raised` enum row. Watermark stored in Redis.
- **Expected impact:** converts the tab from after-the-fact forensics to active detection; directly closes G1.
- **Dependencies:** `apps/workers` + Redis/BullMQ; ops notification channel; new enum action + coverage attestation.
- **Priority:** Critical

### B2 — Wire the PENDING tenant-less identity events (ADR-0031)

- **Current state:** `login.failure`, `mfa.challenge/success/failure`, `staff.login`, `staff.login.failure` are defined in `platformAuditAction` but sit in the PENDING set — most are not written anywhere.
- **Problem:** the platform audit log is blind to authentication-layer activity; a brute-force or staff-login anomaly leaves no trace in the one place an auditor looks.
- **Enterprise best practice:** Okta System Log is overwhelmingly *authentication* events; an admin audit log without login events is half a log.
- **Recommended implementation:** wire `recordPlatformEvent`/`recordPlatformAuthEvent` (in `packages/db/src/client.ts`) at the auth seams in `apps/auth` and the staff-login path, per ADR-0031 §3. Move each action PENDING→WRITTEN in `platformAuditCoverage.test.ts` as it lands. Never log credentials/tokens (the type already forbids it by convention).
- **Expected impact:** auth visibility in the trail; unblocks B1 rules on `staff.login.failure`.
- **Dependencies:** `apps/auth` flows; ADR-0031; coverage test bookkeeping.
- **Priority:** High

### B3 — Aggregation endpoint for analytics

- **Current state:** only `listPage`/`exportRows` exist; the only way to count is to page the whole result.
- **Problem:** no "top 10 actors this week," "action volume by day," or "off-hours action count" — basic governance KPIs are impossible.
- **Enterprise best practice:** Datadog audit dashboards; Splunk stats over the audit index.
- **Recommended implementation:** add `platformAuditReadRepository.aggregate(tx, {groupBy, since, until})` (bounded `GROUP BY action|actor|date`, capped result) behind `GET /api/v1/admin/audit-log/stats`, gated `audit:read`, audited `admin.read_audit_stats`. Back it with the existing partial index; add a covering index on `(action, occurred_at)` if the planner needs it (see D-index below).
- **Expected impact:** powers the UX dashboard (U-section) and surfaces governance KPIs.
- **Dependencies:** new index; new capability-audited route.
- **Priority:** Medium

## Database Improvements

### D1 — Time partitioning + retention policy on `platform_audit_log`

- **Current state:** a single unpartitioned table that grows with *every* `withPlatformTx` call, forever, with no rotation.
- **Problem:** unbounded growth degrades the keyset scan and export over time; there is no retention story to point an auditor at (Salesforce caps at 180 days for the basic trail; enterprises expect a defined, defensible policy).
- **Enterprise best practice:** monthly range partitioning on `occurred_at` + a retention/archival policy (hot in Postgres, cold in object storage).
- **Recommended implementation:** convert to `PARTITION BY RANGE (occurred_at)` with monthly partitions, created idempotently in `rls/platform.sql`/`applyMigrations.ts`; add a worker that detaches + archives partitions older than the retention window to the S3 export (D2/B-stream) before drop. Keep the append-only trigger on each partition.
- **Expected impact:** bounded hot-table size, predictable query cost, a defensible retention policy.
- **Dependencies:** S3 export (B-stream) for archival; migration coordination (raw table).
- **Priority:** Medium

### D2 — Cryptographic integrity (hash-chain) column + digest job

- **Current state:** the table is append-only via trigger, but a backup restore or owner-level write could rewrite history undetectably; the brief's "immutability/WORM attestation" is not surfaced.
- **Problem:** an auditor cannot *prove* the trail is intact — append-only is enforced but not attested.
- **Enterprise best practice:** CloudTrail's signed, hash-chained digest files.
- **Recommended implementation:** add `prev_hash text` + `row_hash text` (SHA-256 over the canonical row + `prev_hash`) computed in `withPlatformTx`'s insert (so the chain is built at write time), plus an hourly digest worker that signs the latest `row_hash` and writes the digest to the S3 export. Surface a "verify integrity" action in the UI that recomputes and checks the chain.
- **Expected impact:** tamper-evidence the trail currently lacks; closes G3.
- **Dependencies:** KMS/signing key (deferred — needs security sign-off); S3 export; `withPlatformTx` change touches every audited write (high blast radius — gate behind a flag).
- **Priority:** High *(needs security/infra sign-off — does NOT exist today)*

### D3 — Supporting indexes for action/actor filters

- **Current state:** only `idx_platform_audit_tenant_time (tenant_id, occurred_at DESC) WHERE tenant_id IS NOT NULL` exists — tuned for the *customer* staff-access read, not the platform viewer's action/actor filters.
- **Problem:** filtering by `action` or `actor_user_id` with the `(occurred_at, id)` keyset has no supporting index; at volume it degrades to a scan + sort.
- **Enterprise best practice:** index the columns the primary access pattern filters/orders on.
- **Recommended implementation:** add `CREATE INDEX idx_platform_audit_action_time ON platform_audit_log (action, occurred_at DESC, id DESC)` and `idx_platform_audit_actor_time ON (actor_user_id, occurred_at DESC, id DESC)` in `rls/platform.sql` (idempotent). Validate with `EXPLAIN` against representative volume.
- **Expected impact:** keeps filtered keyset reads index-only as the trail grows.
- **Dependencies:** D1 partitioning (indexes apply per partition).
- **Priority:** Medium

## API Improvements

### A1 — `metadata` detail endpoint with finer capability

- **Current state:** no single-row endpoint; `metadata` is unreachable from the API surface the console uses.
- **Problem:** see F3 — the *why* is invisible.
- **Enterprise best practice:** per-event detail view, access-controlled separately from list.
- **Recommended implementation:** `GET /api/v1/admin/audit-log/:id` → full row incl. `metadata`, gated `audit:read:detail`, audited `admin.read_audit_detail` via `withPlatformTx`; add `platformAuditReadRepository.getById(tx, id)`.
- **Expected impact:** governed deep inspection.
- **Dependencies:** new capability string in `staffCapability.ts` + `ROLE_CAPABILITIES`; coverage attestation if the audit action is enum'd.
- **Priority:** Medium

### A2 — Stats endpoint (`GET /audit-log/stats`)

- **Current state:** none.
- **Problem:** no server-side aggregation for the dashboard.
- **Enterprise best practice:** dedicated aggregation API behind the same gate.
- **Recommended implementation:** as B3 — bounded `GROUP BY` with capped output, `audit:read`, audited.
- **Expected impact:** powers U2 dashboard without client-side aggregation over paged data.
- **Dependencies:** D3 index; B3 repo method.
- **Priority:** Medium

### A3 — Export hardening: async export + Idempotency-Key parity

- **Current state:** export is synchronous, capped at `AUDIT_EXPORT_CAP = 5000`; a wider range is silently truncated, and a double-click fires two audited `audit.export` rows.
- **Problem:** truncation is invisible to the user (no "5000 of N" signal), and the export is the most likely double-submit on the page.
- **Enterprise best practice:** Salesforce/Okta large exports are async jobs with a download link; mutating-ish actions carry idempotency keys.
- **Recommended implementation:** (a) return a header/JSON field stating whether the cap was hit so the UI can warn; (b) for large ranges, enqueue an async export worker that writes the CSV to S3 and emails/links it (one `audit.export` row per job); (c) accept an `Idempotency-Key` on the export request and de-dupe the audited row within a short window.
- **Expected impact:** no silent truncation, no duplicate audit noise, scalable exports.
- **Dependencies:** S3 (B-stream); `apps/workers`; the shared idempotency middleware.
- **Priority:** Medium

## Dependency Mapping

- **DB tables:** `platform_audit_log` (raw, append-only, owner-write) — primary; `users` (joined for actor display in future enrichment); `platform_staff` (read by `requireCapability` to resolve the active role); *(new)* `audit_alert_rules`, `platform_saved_views`, partitioned children (proposed).
- **Services / repositories:** `platformAuditReadRepository.{listRecent,listPage,exportRows,listTenantStaffAccess}` (`packages/db/src/repositories/platformAuditReads.ts`); `withPlatformTx` / `recordPlatformEvent` (`packages/db/src/client.ts`); `platformStaffRepository.getActiveRole` (authz).
- **API endpoints:** `GET /api/v1/admin/audit-log`, `GET /api/v1/admin/audit-log/export` (live); proposed `GET /audit-log/:id`, `GET /audit-log/stats`.
- **Event flow:** every `withPlatformTx(actor, action, fn, target)` across the admin features inserts one row in the same tx as the mutation → this tab reads them back. The export endpoint *also* writes an `audit.export` row. Reads write `admin.read_audit_log` (raw string).
- **Background workers:** none today. Proposed: `audit-anomaly-scan` (B1), `audit-archive`/digest (D1/D2), `audit-export-async` (A3) — all in `apps/workers`.
- **Queue dependencies:** none today; proposed workers use BullMQ on Redis (the existing `apps/workers` queue infra).
- **Permission/capability dependencies:** `audit:read` (super_admin + compliance_officer) gates both live endpoints; coarse `platformAdmin` (`pa===true`) + authn applied by the parent router. Proposed: `audit:read:detail`.
- **Feature-flag dependencies:** none today. Proposed flags (via the platform `feature_flag.set` machinery once F-flags wire): `audit.anomaly_alerts`, `audit.siem_streaming`, `audit.integrity_chain`, `audit.async_export` — each gating a security-sensitive addition.
- **External integrations:** none today. Proposed: S3 (off-box export/archival), Splunk/SIEM HEC (streaming), KMS (digest signing), PagerDuty/Slack (anomaly alerts) — all deferred, infra-dependent.
- **Cross-module dependencies:** consumes the audit rows produced by *every* admin feature (tenants, users, billing, pricing, provider configs, compliance, announcements, staff, impersonation, elevations); shares the `platformAuditAction` vocabulary + `platformAuditCoverage.test.ts` drift guard; `listTenantStaffAccess` feeds the customer-facing "staff looked at your data" transparency surface in `apps/web`.

## Security Review

- **Read authorization is correct and tight.** `audit:read` is restricted to `compliance_officer` + `super_admin`; `support`/`billing_ops`/`read_only` cannot read the trail. The gate is re-resolved per request via `platformStaffRepository.getActiveRole`, so a revoked role loses access on the next call (no stale-JWT window).
- **Connection isolation is correct.** The table is readable *only* on the BYPASSRLS owner connection inside `withPlatformTx`; `leadwolf_app` is RLS deny-all (ENABLE, no policy) + `REVOKE ALL`. The customer app role cannot read or write the platform trail.
- **Append-only is enforced at the database**, not just by convention — a `BEFORE UPDATE OR DELETE` trigger raises for every role including the owner. **But it is not attested** (no hash chain) — D2 closes this; a restore-from-backup is the residual tamper vector.
- **`metadata` is correctly withheld from the list** (it can carry impersonation reasons / internal detail). F3/A1 must keep the deep-inspection path behind a *separate, stricter* capability and audit the detail read itself.
- **CSV formula-injection is mitigated** (`csvField` prefixes a leading `=+-@` with `'`) — matches the import-side guard. Good.
- **The export is itself audited** (`audit.export`) with the filters recorded in `metadata` — exporting the trail leaves a trace, which is the correct posture.
- **PII/IP exposure:** the platform list surfaces `ip`; the customer-facing `listTenantStaffAccess` correctly omits `ip` and `metadata`. Keep that asymmetry — staff IPs are internal context.
- **Residual risk (deferred):** no SIEM/off-box copy means a sufficiently privileged insider who can also reach backups is the trust boundary; the integrity chain (D2) + streaming (B2-stream) are the mitigations and both need security sign-off.

## Performance Review

- **Reads are bounded and keyset-paginated** — `LIMIT min(limit, 500)+1`, opaque `(occurred_at, id)` cursor, no offset. This is the correct shape and will not degrade on page depth.
- **The order/keyset is well-supported only for the unfiltered and tenant-filtered cases.** The lone index is `(tenant_id, occurred_at DESC) WHERE tenant_id IS NOT NULL` — tuned for the customer read. Filtering by `action` or `actor_user_id` has **no supporting index**, so at volume those become scan+sort. D3 adds `(action, occurred_at DESC, id DESC)` and `(actor_user_id, …)`.
- **Export caps at 5000 rows** — bounded, but synchronous and silently truncating; A3 makes wide exports async and signals truncation.
- **Unbounded table growth** is the long-horizon performance risk; D1 partitioning keeps the hot set bounded.
- **No N+1**: the list is a single SQL projection; actor/tenant are shown as short-IDs (no per-row join). If F1's pickers or display enrichment add names, resolve them client-side from the picker, not per-row server-side.

## UX/UI Improvements

### U1 — Capability render-gate + enum/picker inputs

- **Current state:** the tab and its filters render for anyone who reaches the route; the action filter is free-text and the actor/tenant filters are raw-UUID boxes. A non-`audit:read` staffer sees the tab, then 403s.
- **Problem:** confusing dead-end for non-readers; typo-prone, GUID-paste filtering for readers.
- **Enterprise best practice:** hide what you can't do; closed, searchable facet values.
- **Recommended implementation:** gate the nav entry + page with `useStaffMe().canMaybe("audit:read")` (UI-only; server stays the boundary); ship F1's `TpSelect` action dropdown + entity pickers. Add a sticky "showing N entries · filters active" summary.
- **Expected impact:** clean role-appropriate UI; far faster, error-free filtering.
- **Dependencies:** `useStaffMe`; F1 endpoints.
- **Priority:** High

### U2 — Audit dashboard (counts, top actors, off-hours, trend)

- **Current state:** a flat table only.
- **Problem:** no at-a-glance governance signal — you must already know what you're looking for.
- **Enterprise best practice:** Datadog/Splunk audit dashboards (volume by action, top actors, anomalies).
- **Recommended implementation:** a header strip of small stat cards (today's count, top action, top actor, off-hours count) + a sparkline, backed by `GET /audit-log/stats` (A2). Clicking a card applies the matching filter.
- **Expected impact:** turns the tab into a monitoring surface, not just a search box.
- **Dependencies:** A2/B3; `@leadwolf/ui` stat-card + chart.
- **Priority:** Medium

### U3 — Row detail drawer + integrity badge

- **Current state:** rows are inert; no detail, no integrity signal.
- **Problem:** can't see `metadata`; can't prove the trail is intact.
- **Enterprise best practice:** expandable event JSON (CloudTrail/Okta); integrity-verified badge.
- **Recommended implementation:** row click → `Drawer` (A1 detail); once D2 lands, show a "chain verified" badge + a "Verify integrity" action.
- **Expected impact:** investigative depth + visible tamper-evidence.
- **Dependencies:** A1; D2 (deferred).
- **Priority:** Medium

## Automation Opportunities

- **Anomaly/threshold alerting (B1)** — the headline automation: scheduled scan over new rows, rule-driven alerts to ops, self-audited as `audit.alert.raised`.
- **Async + scheduled export to S3** — nightly snapshot of the day's trail to immutable object storage (the off-box copy Okta provides via streaming) and on-demand large exports (A3).
- **Integrity digest job (D2)** — hourly hash-chain digest, signed, written off-box (CloudTrail model).
- **Partition lifecycle (D1)** — auto-create next month's partition, auto-archive+detach partitions past retention.
- **Coverage-drift CI gate** — `platformAuditCoverage.test.ts` already automates the PENDING→WRITTEN attestation; extend it to fail CI if a new `withPlatformTx` call uses an action string absent from the enum *or* the read-string allow-list.

## Monitoring & Logging

- **The tab is monitoring** — but only passively. The audit rows it reads are the system's own activity log; the missing piece is *alerting on* them (B1) and *forwarding them off-box* for correlation (SIEM streaming).
- **Self-instrumentation:** both endpoints write audit rows (`admin.read_audit_log`, `audit.export`), so reads/exports of the trail are themselves observable in the trail — recursive but correct.
- **Recommended additions:** emit metrics (count by action, anomaly-alert count, export count/size, integrity-verify pass/fail) to the platform metrics pipeline; alert on integrity-chain breaks (Critical), anomaly-rule breaches (High), and export-cap-hit spikes (informational). Wire `staff.login.failure` once B2 lands so failed staff logins are both *logged here* and *alertable*.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Insider with owner + backup access rewrites history undetectably | Low | Critical | D2 hash-chain + off-box digest; restrict backup access |
| Privileged-action abuse goes unnoticed (no alerting) | Medium | High | B1 anomaly worker |
| Audit log blind to auth activity (PENDING events) | High | Medium | B2 wire ADR-0031 events |
| Unbounded table growth degrades reads/exports | Medium (time) | Medium | D1 partitioning + retention |
| `metadata` detail endpoint over-exposes internal context | Low | High | A1 finer `audit:read:detail` cap + audited reads |
| SIEM/streaming work blocked on infra/security sign-off | High | Medium | Specify now (deferred), gate behind flags |
| D2 changes `withPlatformTx` insert → blast radius across every audited write | Medium | High | Flag-gate; extensive itest before enabling |

## Technical Debt

- **`admin.read_audit_log` is a raw string**, not in the `platformAuditAction` enum, so the read action is *not* covered by the coverage drift guard (consistent with the `admin.list_*`/`admin.read_*` convention, but it means read-string typos aren't caught — extend the guard, see Automation).
- **Brief drift:** `id` is `uuid` (v7), not BIGSERIAL; the brief's file-split claim (`Page/api/hook/types/format`) is roughly right here (6 files incl. `components/AuditLogPage.tsx` + `hooks/useAuditLog.ts`).
- **`listRecent` is dead-ish** relative to the viewer (the page uses `listPage`); keep it only if a non-filtered recent-feed consumer exists, else prune.
- **Action filter free-text** duplicates the enum knowledge already in `platformAuditAction` — F1 removes the duplication.
- **No covering index for action/actor filters** — latent perf debt that only bites at volume (D3).
- **Single-table, single-region trail** — no DR/off-box story; acceptable pre-prod, debt at scale.

## Multi-Phase Implementation Plan

### Phase 1 — UX & correctness quick wins (High)

- **Objectives:** make the tab usable and role-appropriate without schema change.
- **Scope:** F1 (enum dropdown + entity pickers), U1 (capability render-gate), action-filter validation, export truncation signal (A3 part a).
- **Deliverables:** `TpSelect` action filter from `platformAuditAction.options`; tenant/actor pickers reusing existing search endpoints; `canMaybe("audit:read")` gate on nav + page; "cap hit" warning on export.
- **Technical tasks:** swap inputs in `AuditLogPage.tsx`; wire `useStaffMe`; add a `capHit` flag to the export response header + a toast.
- **Risks:** picker reuse coupling — keep the URL contract unchanged.
- **Dependencies:** existing tenant/user search; `useStaffMe`.
- **Testing requirements:** component tests for the gated render + picker→UUID emission; an itest asserting filters still hit the same query params.
- **Estimated complexity:** Low.
- **Success criteria:** non-readers don't see the tab; no raw-UUID typing required; truncated exports warn.

### Phase 2 — Investigative depth (Medium)

- **Objectives:** detail + analytics + saved views.
- **Scope:** A1 (`GET /audit-log/:id` + `audit:read:detail`), F3/U3 (metadata drawer), B3/A2/U2 (stats endpoint + dashboard), F2 (URL-sync saved views), D3 (action/actor indexes).
- **Deliverables:** detail endpoint + drawer; stats endpoint + dashboard strip; URL-synced filters; supporting indexes.
- **Technical tasks:** new capability in `staffCapability.ts` + `ROLE_CAPABILITIES`; `getById`/`aggregate` repo methods; `idx_platform_audit_action_time`/`_actor_time` in `rls/platform.sql`; `useSearchParams` hydration.
- **Risks:** `metadata` over-exposure (mitigate with the stricter cap + audited reads); index bloat (validate with `EXPLAIN`).
- **Dependencies:** Phase 1 pickers; `@leadwolf/ui` drawer/chart.
- **Testing requirements:** authz itests (only super_admin/compliance_officer reach `:id`); aggregation correctness; isolation test that `leadwolf_app` still cannot read.
- **Estimated complexity:** Medium.
- **Success criteria:** an auditor can open any event's `metadata` and see top-actor/off-hours KPIs at a glance.

### Phase 3 — Detective controls (Critical, flag-heavy, deferred infra/security sign-off)

- **Objectives:** active detection + immutability + off-box durability.
- **Scope:** B1 (anomaly worker, flag `audit.anomaly_alerts`), B2 (wire ADR-0031 auth events), D2 (integrity hash chain + signed digest, flag `audit.integrity_chain`), SIEM streaming + S3 export (flag `audit.siem_streaming`/`audit.async_export`), D1 (partitioning + retention).
- **Deliverables:** `audit-anomaly-scan` worker + `audit_alert_rules`; wired `login.failure`/`mfa.*`/`staff.login*`; `prev_hash`/`row_hash` + digest worker; S3/Splunk forwarder; partitioned table + archival worker.
- **Technical tasks:** BullMQ jobs in `apps/workers`; `withPlatformTx` insert change (hash chain) behind a flag; KMS signing key; SIEM HEC connector; new enum actions + coverage attestation; partition DDL in `applyMigrations.ts`.
- **Risks:** `withPlatformTx` change touches *every* audited write (highest blast radius — flag + full itest); KMS/SIEM/S3 are infra-dependent and need security sign-off; alert tuning to avoid noise.
- **Dependencies:** `apps/workers`/Redis; KMS; S3; SIEM; feature-flag machinery; ops notifier.
- **Testing requirements:** anomaly-rule unit + integration; integrity-chain verify/tamper-detect itest; isolation tests preserved across partitioning; load test on the hot table.
- **Estimated complexity:** High.
- **Success criteria:** a simulated off-hours `credit.adjust` burst alerts within the scan window; a tampered row fails integrity verification; events appear in the SIEM in real time; the hot table stays bounded.

## Final Recommendations

The Platform Audit Log tab is a **correct, well-isolated read surface** — owner-only reads, append-only at the DB, bounded keyset pagination, formula-safe and self-audited export. As a *log viewer* it is done. The work ahead is to make it an *audit platform*.

1. **Phase 1 (High, now):** enum dropdown + entity pickers + capability render-gate + export-truncation signal. Pure UX/correctness, no schema, immediate investigator value.
   - **Current state / Problem / Best practice / Implementation / Impact / Dependencies / Priority:** as F1/U1/A3(a) above — **Priority: High.**
2. **Phase 2 (Medium):** metadata detail drawer behind a stricter `audit:read:detail` cap, a stats endpoint + dashboard, saved/URL-synced views, and the missing action/actor indexes. Turns search into investigation. **Priority: Medium.**
3. **Phase 3 (Critical, deferred):** the detective controls that distinguish an audit *system* — anomaly alerting (B1), wired auth events (B2), cryptographic integrity (D2), SIEM streaming + S3 archival, and partitioning/retention (D1). All gated behind flags and **explicitly requiring infra + security sign-off**; none of this exists today and this audit does not claim it does. **Priority: Critical** (B1 first — it is the single highest-leverage gap, the one capability a benchmark like Datadog has and this tab lacks entirely).

The recipe for every addition is the established one: a new audited read/mutation = `@leadwolf/types` Zod schema + (if a mutation) a `platformAuditAction` enum entry + `platformAuditCoverage.test.ts` PENDING→WRITTEN attestation + a `platformAuditReadRepository`/`platformAdminWriteRepository` method + a `withPlatformTx` route + a `requireCapability` gate + the admin UI surface; a new platform table = `schema/platformOps.ts` (or raw in `rls/platform.sql`) + `bun generate` + `rls/*.sql` deny-all + `REVOKE` in `applyMigrations.ts`. Follow it and the trail stays as trustworthy as the read path already is.
