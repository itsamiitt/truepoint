---
title: Platform Admin — Retention Tab Audit
tab: retention
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

# Platform Admin — Retention Tab Audit

## 1. Executive Summary

The Retention tab is the platform-admin control plane for TruePoint's per-data-class, time-based retention engine. It is **fully wired**: a `super_admin` reads and writes global per-class policies (TTL + `disabled|shadow|enforce` mode), and any view-only staff tier reads the cross-tenant **shadow evidence** (the runs ledger) that operators must review before flipping a class to permanent deletion. The design is conservative by construction — **shadow-first, off-by-default, double-gated**: a class only ever deletes rows when (a) the per-tenant `retention_engine_enabled` flag is on AND (b) the class's `mode === 'enforce'`. With shipped defaults nothing deletes.

Surface map (verified):

- Frontend: `apps/admin/src/features/retention/*` (9 files, ~532 LOC), route `/retention` (`apps/admin/src/app/(shell)/retention/page.tsx`), nav entry in `apps/admin/src/components/shell/navConfig.ts:41` (`Timer` icon).
- API: `GET /api/v1/admin/retention-policies`, `PUT /api/v1/admin/retention-policies`, `GET /api/v1/admin/retention-runs` (all in `apps/api/src/features/admin/routes.ts`).
- Data: tables `retention_class_policies` + `retention_runs` (`packages/db/src/schema/retention.ts`); repos `retentionClassPolicyRepository`, `retentionRunRepository`, `retentionScanRepository`, and `platformAdminRepository.recentRetentionRuns` (`packages/db/src/repositories/platformAdminReads.ts:434`).
- Engine: `runRetentionSweepForTenant` (`packages/core/src/retention/runRetentionSweep.ts`) driven by the `data_retention_sweep` worker (`apps/workers/src/queues/dataRetentionSweep.ts`).
- Audit: every write runs inside `withPlatformTx(..., "retention_policy.set", ...)`; the read records `admin.list_retention_policies` / `admin.list_retention_runs`.

**Critical clarification (two distinct surfaces, both real).** There is a *second*, unrelated retention surface under the **Compliance** tab: entity/field policies in table `retention_policies` (note: singular naming distinct from `retention_class_policies`), repo `retentionPolicyRepository`, audit action `retention.set`, capability `compliance:manage` (`apps/api/src/features/admin/compliance.ts`, `apps/admin/src/features/compliance/components/RetentionPolicies.tsx`). The two were renamed apart on the main-merge to avoid a collision (see `packages/types/src/platformAuditCoverage.test.ts:43`). **They are not the same feature** — this audit covers ONLY the data-class engine on the Retention tab. The Compliance entity/field policies are documented in the compliance audit.

The dominant gaps are scope and previewability, not correctness: the engine is **global-only** (no per-tenant override, exception, or legal hold), the data-class vocabulary is **backend-defined free text in the UI** (no dropdown), the enforce flip has **no dry-run / impact preview** beyond reading historical runs, the write is **role-gated not capability-gated** (`requireStaffRole("super_admin")` rather than a `retention:write` capability), and there is **no per-class `retention:write` capability** in the matrix at all.

## 2. Current Implementation Audit

**Frontend (`apps/admin/src/features/retention/`).**

| File | Role |
|---|---|
| `components/RetentionPage.tsx` | Host shell: title + `Tabs` (`policies` / `runs`); pure composition, no data state. |
| `components/RetentionPoliciesPage.tsx` | `DataTable` of policies via `StateSwitch`; `super_admin`-only Edit affordance (render-gate). |
| `components/EditPolicyDialog.tsx` | Edit TTL + mode; **two-step confirm** when flipping to `enforce` (arms deletion). |
| `components/RetentionRunsPanel.tsx` | Cross-tenant runs table (tenant, class, mode, "would delete", deleted, cutoff, last run). Not render-gated; relies on server `requireStaffRole`. |
| `hooks/useRetentionPolicies.ts`, `useRetentionRuns.ts` | `useState`/`useEffect` loaders (vanilla React, NO TanStack — per house convention). |
| `hooks/useIsSuperAdmin.ts` | Wraps `verifySuperAdmin` (`lib/adminGate`) for the render-gate. |
| `api.ts` | `listRetentionPolicies`, `updateRetentionPolicy`, `listRetentionRuns` via `fetchWithAuth` (Bearer, ADR-0016). |
| `types.ts` | Re-exports shared `@leadwolf/types` contract; defines `RetentionPolicyPatch`, `RetentionRunRow` view-model. |

The enforce-arming guard is genuinely good: `EditPolicyDialog` computes `armsDeletion = mode === "enforce" && policy.mode !== "enforce"` and routes that transition through a red, copy-explicit confirm step — never a silent save.

**API (`apps/api/src/features/admin/routes.ts`).**

- `GET /retention-policies` — `requireStaffRole("super_admin", "compliance_officer", "read_only")`; `withPlatformTx(actorOf(c), "admin.list_retention_policies", listPolicies)`; response `retentionPolicySchema.array().parse(...)` before it leaves the boundary (line ~794).
- `PUT /retention-policies` — `requireStaffRole("super_admin")` only; body `retentionPolicyUpdateSchema.safeParse`; `withPlatformTx(actorOf(c), "retention_policy.set", upsertPolicy, { targetType: "retention_policy", targetId: policy.dataClass, metadata: { ttlDays, mode } })` (lines ~805–818).
- `GET /retention-runs` — `requireStaffRole("super_admin", "compliance_officer", "read_only")`; `withPlatformTx(actorOf(c), "admin.list_retention_runs", recentRetentionRuns)`; counts-only, bounded by `PLATFORM_READ_LIMIT` (lines ~669–677).

**Data.** `retention_class_policies` (PK `data_class` varchar(50), `ttl_days` int nullable, `mode` varchar(20) with CHECK `IN ('disabled','shadow','enforce')`, `created_at`/`updated_at`). `retention_runs` (uuid v7 PK, `tenant_id` FK cascade, `data_class`, `mode`, `candidate_count`, `deleted_count`, `cutoff`, `run_started_at/finished_at`, `created_at`; index `idx_retention_runs_tenant_class` on `(tenant_id, data_class, created_at)`). RLS (`packages/db/src/rls/retention.sql`): policies table is `ENABLE + FORCE` with a **SELECT-only** policy for `leadwolf_app` (no write policy → writes denied, owner path only); runs table is `ENABLE + FORCE` with **SELECT + INSERT only**, tenant-scoped on the `app.current_tenant_id` GUC — **append-only, immutable** (no UPDATE/DELETE policy).

**Engine.** `runRetentionSweepForTenant` enforces the four-gate safety order (per-tenant flag → per-class mode → null TTL → v1-wired class), counts via `retentionScanRepository.countExpiredByClass`, purges (enforce only) via `deleteExpiredByClass` (batched, owner connection, explicit tenant predicate, lockstep count/delete WHERE), and appends one immutable `retention_runs` row per class. The wired v1 set is 7 classes (`RETENTION_V1_CLASSES`): `email_event`, `provider_calls`, `enrichment_job_rows`, `import_job_rows`, `data_quality_snapshots`, `verification_jobs`, `activities`. The remaining 5 classes in the vocabulary (`contact_reveals`, `source_imports`, `consent_records`, `contacts`, `audit_log`) are deferred (contact-cascade / legal-proof; `contacts` and `audit_log` ship `ttlDays: null`).

> Note: `apps/workers/src/queues/retentionSweep.ts` is the **email idempotency** sweep (`email_retention_sweep`, 30-day key reclaim) — NOT the data-class engine. The data-class engine is `dataRetentionSweep.ts` (`data_retention_sweep`). Do not conflate them.

## 3. Enterprise Benchmark Research

Four grounded comparisons against named products. Where a claim is from documented behaviour rather than a fetched spec, it is marked.

- **Salesforce Shield — Field Audit Trail.** Standard Salesforce retains field history 18 months in-org (24 via API); **Field Audit Trail (Shield)** lets you set retention **up to 10 years** and raise tracked fields from 20 to 60, with the `HistoryRetentionPolicy` metadata type making per-object retention a declarative, versioned artifact ([Salesforce Help — Field History Retention](https://help.salesforce.com/s/articleView?id=release-notes.rn_general_field_tracking_retention.htm), [HistoryRetentionPolicy metadata](https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_historyretentionpolicy.htm)). TruePoint has no per-object/per-field retention granularity and no declarative policy-as-metadata.
- **OneTrust / BigID — automated retention + violation detection.** OneTrust operationalizes retention by **discovering over-retained data, flagging retention violations, and driving deletion workflows with audit-ready documentation** ([OneTrust — Automate Data Retention](https://www.onetrust.com/blog/automate-data-retention-policies/)); BigID added **end-to-end retention with native deletion** in 2025 ([BigID vs OneTrust](https://www.enzuzo.com/alternatives/onetrust-vs-bigid)). TruePoint's shadow runs are the seed of "violation detection," but there is no alerting on over-retention and no deletion-approval workflow.
- **AWS S3 Lifecycle.** S3 lifecycle rules support **transition + expiration actions, per-prefix/tag scoping, and noncurrent-version expiration with a retain-N-versions cap (1–100)** ([AWS — Object lifecycle management](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)). The analogue TruePoint lacks: **scoped exceptions** (rule applies to a subset) and **archive-before-delete tiering** (cold-store before purge) — relevant for the deferred `source_imports` "archive-before-purge" class.
- **HubSpot — per-category configurable retention.** HubSpot exposes a retention UI where **each data category has its own configurable period via dropdowns/numeric fields**, plus a configurable **inactive-contact** definition ([HubSpot — Manage data retention](https://knowledge.hubspot.com/privacy-and-consent/manage-data-retention-policy-settings)). TruePoint matches the per-class period model but, unlike HubSpot, surfaces the class list as free-text rather than a fixed, documented picker, and has no per-tenant differentiation.

**Legal hold** (well-known behaviour, not a single fetched citation): S3 Object Lock and every mature compliance platform (OneTrust, Microsoft Purview) support a **legal hold** that *suspends* deletion for matching records regardless of policy. TruePoint has no legal-hold concept — a hard gap for any tenant under litigation/regulatory hold.

## 4. Gap Analysis

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | Write is role-gated, not capability-gated; no `retention:write` capability exists | High | `routes.ts:805` `requireStaffRole("super_admin")`; `staffCapability.ts` has no retention cap |
| G2 | Data-class field is free-text in UI (no dropdown of the closed enum) | High | `EditPolicyDialog.tsx` edits TTL+mode but class comes from row; new-policy path would be free text; enum lives in `retention.ts:19` |
| G3 | Global-only — no per-tenant override / exception / SLA | High | `retention_class_policies` PK is `data_class` only; no `tenant_id` |
| G4 | No legal-hold interplay — enforce can delete records under hold | Critical | no hold table/column; sweep has no hold check |
| G5 | No dry-run / impact preview before the enforce flip (beyond historical runs) | High | `EditPolicyDialog` confirm is copy-only; no count preview |
| G6 | No scheduled-purge preview / "next run will delete N" projection | Medium | runs are retrospective; no forward projection endpoint |
| G7 | No Idempotency-Key on `PUT /retention-policies` | Medium | route reads raw body; double-submit re-audits |
| G8 | Runs panel has no class/mode/tenant filter or keyset pagination | Medium | `recentRetentionRuns` is a flat top-`PLATFORM_READ_LIMIT` list |
| G9 | No alerting when a shadow candidate count spikes / when enforce deletes a large volume | Medium | sweep logs only; no metric/alert |
| G10 | 5 of 12 classes deferred (no deleter); UI can set them to `enforce` (no-op, silently) | Medium | `RETENTION_V1_CLASSES` is 7; sweep skips non-v1 silently |
| G11 | No peer-approval / dual-control on the enforce flip | High | route comment notes it as FUTURE; self-service only |

## 5. Functional Improvements

### 5.1 Data-class picker + deferred-class awareness
- **Current state:** `EditPolicyDialog` edits TTL + mode for an existing row; the class is implicit, and any new-policy flow would expose the class as free text. v2/deferred classes can be set to `enforce` with no UI signal that nothing will happen.
- **Problem:** Free-text class invites typos that fail the server enum (poor UX) and the silent no-op on deferred classes erodes operator trust.
- **Enterprise best practice:** HubSpot exposes a fixed, documented per-category picker.
- **Recommended implementation:** Drive a `TpSelect` from `retentionDataClass.options` (`@leadwolf/types`). Tag each option v1/deferred from `RETENTION_V1_CLASSES`; when a deferred class is set to `enforce`, render an inline warning ("No deleter is wired for this class yet — this will record shadow runs only").
- **Expected impact:** Eliminates invalid writes; sets correct expectations on deferred classes.
- **Dependencies:** `retentionDataClass`, `RETENTION_V1_CLASSES` export to admin.
- **Priority:** High.

### 5.2 Enforce-flip impact preview (dry-run count)
- **Current state:** The confirm dialog is copy-only — it states deletion will occur but shows no number.
- **Problem:** An operator flips `enforce` blind to blast radius; the only evidence is whatever shadow runs already exist.
- **Enterprise best practice:** OneTrust surfaces over-retained volume before enforcement; AWS shows affected scope.
- **Recommended implementation:** New `GET /retention-policies/:dataClass/impact` returning the *current* candidate count across flag-enabled tenants (sum of `retentionScanRepository.countExpiredByClass` per active tenant, bounded, owner connection). Render "This will delete ~N rows across M tenants on the next sweep" in the confirm step.
- **Expected impact:** Informed, auditable enforce decisions; fewer accidental large purges.
- **Dependencies:** 5.1; bounded fan-out (cap tenants, reuse `listActiveTenants`).
- **Priority:** High.

### 5.3 Runs panel filtering + keyset pagination
- **Current state:** `RetentionRunsPanel` renders the top `PLATFORM_READ_LIMIT` runs, no filter.
- **Problem:** At fleet scale, the evidence you need (one tenant, one class) is buried.
- **Enterprise best practice:** All audit UIs filter by subject/action/time and paginate.
- **Recommended implementation:** Add `?dataClass=&mode=&tenantId=&cursor=` to `GET /retention-runs`; keyset cursor (base64url, `(created_at,id)` descending, limit+1 probe) mirroring the established platform-read cursor idiom; UI filter row + "Load more".
- **Expected impact:** Usable evidence review at scale.
- **Dependencies:** `recentRetentionRuns` signature change; index `idx_retention_runs_tenant_class` already supports class/tenant filtering.
- **Priority:** Medium.

## 6. Backend Improvements

### 6.1 Granular `retention:write` capability
- **Current state:** `PUT /retention-policies` gates on `requireStaffRole("super_admin")`.
- **Problem:** Inconsistent with the capability model used by tenants/billing/compliance; `super_admin` is all-or-nothing and can't be delegated to a `compliance_officer` without granting everything.
- **Enterprise best practice:** Least-privilege, capability-per-action (Okta/Azure-AD entitlements).
- **Recommended implementation:** Add `retention:write` to `staffCapability` enum (`packages/types/src/staffCapability.ts`), bundle it under `super_admin` (implicit) and optionally `compliance_officer`; swap the route to `requireCapability("retention:write")`. Surface it in `/admin/me` so the UI render-gate uses `useStaffMe().canMaybe("retention:write")` instead of the `verifySuperAdmin` probe.
- **Expected impact:** Consistent RBAC; delegable; tighter audit attribution.
- **Dependencies:** `staffCapability`, `ROLE_CAPABILITIES`, `requireCapability` middleware, `useIsSuperAdmin` → `useStaffMe`.
- **Priority:** High.

### 6.2 Forward purge projection job
- **Current state:** `retention_runs` is purely retrospective.
- **Problem:** No "what will the next sweep delete" view; operators discover scale only after the fact.
- **Enterprise best practice:** Lifecycle previews (S3 inventory + lifecycle simulation).
- **Recommended implementation:** A daily projection pass (reuse the shadow count path) writes a `projected_count` alongside each run, or a lightweight `GET /retention-runs/projection` computing next-cutoff candidate counts on demand (bounded). No deletes — count only.
- **Expected impact:** Proactive blast-radius awareness; feeds alerting (§14).
- **Dependencies:** `retentionScanRepository.countExpiredByClass`; bounded tenant fan-out.
- **Priority:** Medium.

### 6.3 Deferred-class delete wiring (v2)
- **Current state:** 5 classes have no deleter; sweep silently skips them.
- **Problem:** `contacts`/`source_imports`/`consent_records`/`contact_reveals`/`audit_log` can never enforce; the policy store implies a capability that doesn't exist.
- **Enterprise best practice:** Archive-before-purge tiering (S3 Glacier transition) for high-value/legal records.
- **Recommended implementation:** Per design 16 §2, wire deleters one class at a time with dependents-before-tombstone cascade order and archive-before-purge for `source_imports`. Each must add a `RetentionClassMeta` entry with lockstep count/delete WHERE. Ship each shadow-first.
- **Expected impact:** Completes the engine; honours storage-limitation for PII-bearing classes.
- **Dependencies:** legal sign-off on periods for `contacts`/`audit_log`; archive store for `source_imports`.
- **Priority:** Medium (legal-gated → some sub-items Low until counsel decides).

## 7. Database Improvements

### 7.1 Per-tenant policy override table
- **Current state:** Policies are global (`retention_class_policies`, PK `data_class`).
- **Problem:** No tenant can have a longer/shorter TTL or a class disabled for contractual reasons; enterprise contracts routinely require this.
- **Enterprise best practice:** Per-tenant retention SLAs; HubSpot/Salesforce per-org policy.
- **Recommended implementation:** New `retention_tenant_overrides (tenant_id, data_class, ttl_days nullable, mode, reason, created_by_user_id, updated_at)`, PK `(tenant_id, data_class)`. Sweep resolves effective policy = override ?? global. New table follows the recipe: `schema/retention.ts` + `bun generate` + `rls/retention.sql` (tenant-scoped read, owner-only write) + `REVOKE`/grant documentation in `applyMigrations.ts`.
- **Expected impact:** Unblocks enterprise retention SLAs (G3).
- **Dependencies:** sweep resolution change; admin override UI (a per-tenant sub-view).
- **Priority:** High.

### 7.2 Legal-hold table
- **Current state:** No hold concept; enforce deletes unconditionally.
- **Problem:** A tenant/record under litigation hold can be permanently destroyed — a compliance and legal-liability defect (G4).
- **Enterprise best practice:** S3 Object Lock legal hold; OneTrust/Purview holds suspend deletion.
- **Recommended implementation:** `retention_legal_holds (id, tenant_id, scope ['tenant'|'data_class'], data_class nullable, reason, placed_by_user_id, placed_at, released_at nullable)`. Sweep checks for an active hold per `(tenant, class)` and **forces shadow** (counts, deletes nothing) while held, recording `mode='shadow'` with a `held=true` annotation. RLS owner-write, tenant-scoped read.
- **Expected impact:** Closes the most serious correctness gap; defensible compliance posture.
- **Dependencies:** sweep gate addition (a 5th, outermost-after-flag gate); audit action `retention.hold.place`/`release`.
- **Priority:** Critical.

### 7.3 Audit `cutoff`/`held` columns on runs
- **Current state:** `retention_runs` records counts + cutoff + window.
- **Problem:** A held-but-counted run is indistinguishable from a normal shadow run; no `policy_was_override` flag.
- **Recommended implementation:** Add `held boolean default false` and `source varchar` ('global'|'override') to `retention_runs` (additive, nullable/defaulted — safe migration).
- **Expected impact:** Evidence completeness for audits.
- **Dependencies:** 7.1, 7.2.
- **Priority:** Medium.

## 8. API Improvements

### 8.1 Idempotency-Key on `PUT /retention-policies`
- **Current state:** Route reads raw body; a double-submit re-audits and re-upserts.
- **Problem:** Network retry / double-click writes two `retention_policy.set` audit rows for one intent.
- **Enterprise best practice:** Stripe-style `Idempotency-Key` on every mutating endpoint.
- **Recommended implementation:** Accept `Idempotency-Key` header; reuse the platform idempotency middleware (`idempotencyRepository`) keyed on `(actor, key)` → cached result. **Deferred** pending the shared admin-mutation idempotency rollout (same gap flagged across tenants/credits); mark needs-infra.
- **Expected impact:** Exactly-once policy writes; clean audit trail (G7).
- **Dependencies:** shared admin idempotency middleware (deferred — needs infra sign-off).
- **Priority:** Medium.

### 8.2 Impact + projection endpoints
- **Current state:** No count-preview endpoints.
- **Problem:** UI can't show blast radius (5.2) or forward projection (6.2).
- **Recommended implementation:** `GET /retention-policies/:dataClass/impact` and `GET /retention-runs/projection`; both `requireStaffRole("super_admin","compliance_officer","read_only")` (read), bounded, audited as `admin.list_*`, counts-only.
- **Expected impact:** Powers 5.2/6.2.
- **Dependencies:** `retentionScanRepository`; bounded fan-out.
- **Priority:** High (impact) / Medium (projection).

### 8.3 Enforce-flip requires fresh JIT elevation
- **Current state:** Enforce flip is `super_admin` + audit + UI confirm; no elevation consume.
- **Problem:** The single most destructive platform action (arming permanent deletion) is not behind a step-up like `credit.adjust`/`tenant.suspend`.
- **Enterprise best practice:** Step-up auth for irreversible actions.
- **Recommended implementation:** When the write transitions a class to `enforce`, consume a JIT elevation in-tx (`jit_elevations`, `FOR UPDATE SKIP LOCKED`, ~10-min TTL) or 403 `elevation_required`, mirroring the sensitive-action pattern.
- **Expected impact:** Raises the bar on the irreversible action; ties deletion to a time-boxed, audited elevation.
- **Dependencies:** `jitElevationRepository`; UI elevation-request flow.
- **Priority:** High.

## 9. Dependency Mapping

- **DB tables:** `retention_class_policies` (global policy), `retention_runs` (per-tenant append-only evidence), `tenants` (join for name + active enumeration), `feature_flags` (the `retention_engine_enabled` per-tenant gate), `platform_audit_log` (raw, owner-only). Proposed: `retention_tenant_overrides`, `retention_legal_holds`.
- **Services / repositories:** `retentionClassPolicyRepository` (list/get/upsert), `retentionRunRepository` (recordRun/recentRuns), `retentionScanRepository` (count/delete/listActiveTenants), `platformAdminRepository.recentRetentionRuns` (cross-tenant read). Engine: `runRetentionSweepForTenant` (`@leadwolf/core`). Client: `lib/adminGate.verifySuperAdmin`.
- **API endpoints:** `GET /api/v1/admin/retention-policies`, `PUT /api/v1/admin/retention-policies`, `GET /api/v1/admin/retention-runs`. Proposed: `GET .../:dataClass/impact`, `GET .../retention-runs/projection`.
- **Event flow:** operator edits policy → `PUT` (Zod → `withPlatformTx("retention_policy.set")` → `upsertPolicy`) → daily `data_retention_sweep` leader-locked job → `runRetentionSweepForTenant` per active tenant → flag gate → per-class count (+enforce purge) → append `retention_runs` → staff reads via `GET /retention-runs`.
- **Background workers:** `data_retention_sweep` (`apps/workers/src/queues/dataRetentionSweep.ts`, leader-locked, daily, ≤1000 tenants/tick). Distinct from `email_retention_sweep` (idempotency reclaim).
- **Queue dependencies:** BullMQ on Redis; `withLeaderLock` (Redis lock `leader:data_retention_sweep`, 10-min TTL).
- **Permission / capability dependencies:** `requireStaffRole("super_admin")` (write), `requireStaffRole("super_admin","compliance_officer","read_only")` (reads); render-gate `verifySuperAdmin`. Proposed: `retention:write` capability + `requireCapability`; JIT `jit_elevations` for the enforce flip.
- **Feature-flag dependencies:** `retention_engine_enabled` (per-tenant, default false) — the outermost engine gate; resolved via `isFlagEnabledForTenant`.
- **External integrations:** none today. Proposed: archive/cold store (S3-class) for `source_imports` archive-before-purge.
- **Cross-module dependencies:** retention engine reaches into `email_event`, `provider_calls`, `enrichment_job_rows`, `import_job_rows`, `data_quality_snapshots`, `verification_jobs`, `activities` schemas (via `retentionClassMeta`); `workspaces` (for `workspace_join`-scoped classes); `feature_flags`; `tenants`. The Compliance tab's `retention_policies` (entity/field) is a **separate** module — do not couple.

## 10. Security Review

- **Tenant isolation (sweep):** strong. Both count and delete run on the owner connection but **never rely on RLS** — every closure carries an explicit `tenant_id = $t` (or `workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = $t)`) predicate, and count/delete WHERE are lockstep so the purge targets exactly the counted rows (`retentionScanRepository.ts`). Missing-`tenantId` throws.
- **RLS on tables:** `retention_class_policies` SELECT-only for the app role (writes owner-path only); `retention_runs` SELECT+INSERT only, GUC-tenant-scoped → append-only/immutable. Platform reads use the BYPASSRLS owner path via `withPlatformTx`, bounded by `PLATFORM_READ_LIMIT`.
- **Authz:** read tiers correct; **write is role-gated not capability-gated** (G1) — functionally safe (`super_admin` only) but inconsistent and non-delegable. Render-gate is UI-only; server is the boundary (correct).
- **Irreversibility:** enforce arms permanent deletion. Controls today: `super_admin` + audit + UI two-step confirm. **No step-up elevation** (recommend 8.3), **no peer approval** (G11 — `approved_by_user_id` exists on `jit_elevations` but peer-approval is not enforced, self-service v1), **no legal hold** (G4/7.2). The enforce flip is the highest-blast-radius action in the entire console and currently has the thinnest gating relative to that risk.
- **PII exposure:** `retention_runs` is counts-only — no contact rows leave the boundary; the cross-tenant read is privacy-safe by construction.
- **Audit coverage:** `retention_policy.set` is enum-tracked and attested in `platformAuditCoverage.test.ts` (drift guard). Reads use `admin.list_*` strings (not enum mutations) by design. Proposed hold/override actions must follow the PENDING→WRITTEN attestation recipe.

## 11. Performance Review

- **Reads:** policies read is a small full-table scan (≤12 rows) — trivial. Runs read is `ORDER BY created_at DESC LIMIT ≤500` with an inner join to `tenants`; bounded, but **no covering index on `retention_runs.created_at` alone** — the existing index is `(tenant_id, data_class, created_at)`, which does not serve the cross-tenant `ORDER BY created_at DESC` efficiently. Recommend a `(created_at DESC)` index for the platform read, or `(created_at, id)` for keyset (8.2/5.3).
- **Sweep:** fans out ≤1000 tenants/tick, best-effort per tenant; counts are bounded scalar `count()` per class; deletes are batched (≤5000/statement, drained loop) so no long table lock. The per-tenant flag gate short-circuits cheaply (most tenants off). At fleet scale the cost is `tenants × wired_classes` count queries/day — acceptable but worth a metric (§14).
- **Risk:** `countExpiredByClass` on the high-volume `*_rows` ledgers via `workspace_join` is the heaviest query; ensure the aging columns (`created_at`/`occurred_at`) are indexed on those tables.

## 12. UX/UI Improvements

### 12.1 Capability render-gate (replace super-admin probe)
- **Current state:** `useIsSuperAdmin` makes a probe via `verifySuperAdmin`.
- **Problem:** An extra round-trip and a coarse signal; inconsistent with the `useStaffMe().canMaybe(cap)` pattern used elsewhere.
- **Enterprise best practice:** Single capabilities payload from `/admin/me`.
- **Recommended implementation:** After 6.1, gate the Edit affordance with `useStaffMe().canMaybe("retention:write")`.
- **Expected impact:** Fewer requests, consistent gating, correct attribution.
- **Dependencies:** 6.1.
- **Priority:** High.

### 12.2 Enforce-flip blast-radius in the confirm dialog
- **Current state:** Confirm step is copy-only.
- **Problem:** No number to anchor the decision (5.2).
- **Recommended implementation:** Render the live impact count + affected-tenant count (from 8.2) inside the existing red confirm panel; disable the destructive button until the count loads.
- **Expected impact:** Materially safer enforce decisions.
- **Dependencies:** 5.2 / 8.2.
- **Priority:** High.

### 12.3 Runs filters + empty/loaded affordances
- **Current state:** Single flat table, four-state via `StateSwitch`.
- **Problem:** No filter row; no "held"/"override" badges; no per-tenant drilldown.
- **Recommended implementation:** Add a filter row (class/mode/tenant), badges for `held`/`override` (after 7.3), and link tenant → tenant detail. Keep WCAG 2.2 AA tone+label pairing already used (`StatusBadge` tone never colour-alone).
- **Expected impact:** Evidence review becomes operational, not just a dump.
- **Dependencies:** 5.3, 7.3.
- **Priority:** Medium.

## 13. Automation Opportunities

- **Over-retention alerting:** when a shadow candidate count for a class exceeds a threshold (absolute or week-over-week delta), emit an alert — the seed of OneTrust-style violation detection.
- **Auto-shadow-before-enforce guard:** refuse an `enforce` flip for a class that has zero shadow runs in the last N days (no evidence) — enforce a "measure first" policy in the API, not just convention.
- **Scheduled projection digest:** a weekly summary of "what each class would/will delete next sweep" to the platform-ops channel (feeds 6.2).
- **Deferred-class readiness checks:** CI assertion that every class with `mode='enforce'` in any environment has a wired deleter (`isRetentionV1Class`), preventing a silent no-op enforce.

## 14. Monitoring & Logging

- **Today:** sweep logs `data-retention sweep: runs recorded {count, deleted}` and per-tenant failures (`log.error`); the immutable `retention_runs` rows are the durable evidence; `retention_policy.set` lands in `platform_audit_log`.
- **Gaps:** no metrics (candidates/deleted per class per run, sweep duration, tenants processed, per-tenant failures), no alert on a large `deleted_count`, no dashboard of enforce-mode classes by tenant.
- **Recommend:** counters `retention.candidates{class}`, `retention.deleted{class}`, `retention.sweep.duration`, `retention.sweep.tenant_failures`; an alert when `deleted_count` for any run exceeds a threshold (a large purge should page); a dashboard listing every `(tenant, class)` currently in `enforce`. Tie alerts to the operations runbook (truepoint-operations).

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Enforce flip deletes records under (non-existent) legal hold | Medium | Critical (legal liability) | Build legal-hold table 7.2 before broad enforce rollout |
| Operator flips enforce blind to blast radius | Medium | High (irreversible mass delete) | Impact preview 5.2 + JIT step-up 8.3 |
| Deferred class set to `enforce` → silent no-op, false sense of compliance | Medium | Medium | Picker warning 5.1 + CI readiness check (§13) |
| Cross-tenant runs read scales poorly without a `created_at` index | Low | Medium | Add index; keyset 5.3 |
| Per-tenant SLA demands force a rushed override design | Medium | Medium | Land override table 7.1 deliberately, shadow-first |
| No idempotency → duplicate audit rows confuse investigations | Low | Low | Idempotency-Key 8.1 (deferred) |

## 16. Technical Debt

- **Naming collision residue:** two retention surfaces (`retention_class_policies` engine vs Compliance's `retention_policies` entity/field) renamed apart on main-merge; the docstrings still reference legacy names in places (`retentionPolicyRepository.ts` header says "13a Area 8" / "retention_policies"). Keep the two clearly partitioned; do not let a future refactor re-merge them.
- **Worker name overload:** `retentionSweep.ts` (email idempotency) vs `dataRetentionSweep.ts` (data-class engine) — confusable; consider renaming the email one to `emailIdempotencySweep.ts`.
- **Role-gate vs capability-gate inconsistency** (G1) is debt: the rest of the console is capability-gated.
- **Deferred deleters (5 classes)** are documented debt — the vocabulary promises classes the engine can't yet enforce.
- **`approved_by_user_id` on `jit_elevations`** exists but peer-approval is unenforced — dormant schema for a deferred control.

## 17. Multi-Phase Implementation Plan

### Phase 1 — UX & correctness quick wins (High)
- **Objectives:** Make the existing surface safe and consistent without new infra.
- **Scope:** data-class picker (5.1), capability gate (6.1, 12.1), impact preview (5.2, 8.2 impact endpoint, 12.2), Idempotency-Key when the shared middleware lands (8.1), CI deferred-class readiness check (§13).
- **Deliverables:** `retention:write` capability + `requireCapability` swap; `TpSelect` class picker with deferred warnings; `/retention-policies/:dataClass/impact` endpoint; confirm-dialog blast-radius; `useStaffMe` render-gate.
- **Technical tasks:** add cap to `staffCapability`/`ROLE_CAPABILITIES`; route swap; impact endpoint (bounded fan-out, audited `admin.list_*`); UI wiring; CI assertion `enforce ⟹ isRetentionV1Class`.
- **Risks:** capability bundle change must not silently widen access — test the matrix.
- **Dependencies:** none beyond existing repos; Idempotency-Key sub-item waits on shared middleware.
- **Testing requirements:** route authz tests (each role × read/write); enum-picker rejects invalid class; impact count matches sweep count; capability matrix snapshot; audit-coverage attestation unchanged.
- **Estimated complexity:** M.
- **Success criteria:** write is capability-gated; no free-text class possible; enforce confirm shows a real number; CI fails on an enforce-without-deleter.

### Phase 2 — Retention depth: overrides, legal hold, evidence (Critical/High)
- **Objectives:** Close the scope and compliance gaps.
- **Scope:** legal-hold table + sweep gate (7.2, Critical), per-tenant overrides (7.1), runs `held`/`source` columns (7.3), runs filters + keyset (5.3, 8.2 projection), JIT step-up on enforce flip (8.3).
- **Deliverables:** `retention_legal_holds` + `retention_tenant_overrides` tables (full recipe: schema → `bun generate` → `rls/retention.sql` → `applyMigrations.ts` REVOKE/grant), sweep effective-policy resolution (override ?? global) + hold gate (forces shadow), new audit actions `retention.hold.place`/`retention.hold.release` (+ PENDING→WRITTEN attestation), elevation consume on enforce, runs keyset + filters.
- **Technical tasks:** sweep gate ordering (flag → hold → override-resolved mode → null TTL → v1 class); RLS tenant-scoped read / owner-only write on new tables; `recentRetentionRuns` cursor + filters; index `(created_at, id)`.
- **Risks:** sweep gate-order regression could re-arm deletion — exhaustive gate tests; migrations must be additive/safe.
- **Dependencies:** Phase 1 (capability + impact); legal sign-off on hold semantics; JIT elevation infra (exists).
- **Testing requirements:** itests proving a held `(tenant,class)` never deletes even in enforce; override beats global; append-only RLS still holds; keyset pagination stable; elevation-required 403 path.
- **Estimated complexity:** L.
- **Success criteria:** an active legal hold provably suppresses deletion; a tenant override changes effective TTL; enforce flip demands a fresh elevation; runs are filterable and paginated.

### Phase 3 — Flag-heavy automation & deferred-class wiring (Medium/Low)
- **Objectives:** Operational maturity + complete the engine, behind flags and legal gates.
- **Scope:** over-retention alerting + metrics (§13/§14), projection digest (6.2), deferred-class deleters one at a time (6.3), peer-approval/dual-control (G11), archive-before-purge for `source_imports`.
- **Deliverables:** metric counters + alert rules + ops dashboard; weekly projection digest; per-class deleters (shadow-first, archive store for `source_imports`); optional dual-control workflow enforcing `approved_by_user_id`.
- **Technical tasks:** instrument the sweep; build projection pass; add `RetentionClassMeta` entries with lockstep WHERE + cascade order; archive integration (S3-class) gated by a feature flag; enforce peer-approval in the elevation consume.
- **Risks:** new deleters are the riskiest code in the system — each ships shadow-first and is flag-gated per tenant; legal periods for `contacts`/`audit_log` are blockers.
- **Dependencies:** Phase 2; counsel decisions; cold-store infra; alerting/metrics stack.
- **Testing requirements:** per-class lockstep count==delete-scope tests; archive-before-purge ordering; alert fires on threshold breach; dual-control rejects self-approval.
- **Estimated complexity:** L (spread across multiple sub-deliveries).
- **Success criteria:** every enforce action is metered/alerted; every wired class deletes exactly its counted rows; no class can enforce without a deleter, evidence, and (where legally required) a hold check.

## 18. Final Recommendations

1. **Build the legal-hold table and sweep gate first (7.2, Critical).** The engine can permanently delete records under hold today; this is the single most serious defect and must precede any broad enforce rollout. **Priority: Critical.**
2. **Add an impact preview + JIT step-up to the enforce flip (5.2/8.2/8.3, High).** The highest-blast-radius action in the console currently has the thinnest gating relative to its risk; show the number and require a fresh elevation. **Priority: High.**
3. **Capability-gate the write (6.1, High).** Replace `requireStaffRole("super_admin")` with `requireCapability("retention:write")` for consistency, delegability, and audit attribution. **Priority: High.**
4. **Ship the data-class picker with deferred-class warnings (5.1, High)** to kill free-text classes and the silent-no-op enforce. **Priority: High.**
5. **Land per-tenant overrides (7.1, High)** to unblock enterprise retention SLAs — deliberately, shadow-first. **Priority: High.**
6. **Instrument and alert (§13/§14, Medium).** A large `deleted_count` should page; over-retention should flag — closing the loop toward OneTrust-style violation detection. **Priority: Medium.**
7. **Keep the two retention surfaces partitioned (§16).** The engine (`retention_class_policies`) and the Compliance entity/field policies (`retention_policies`) are distinct by design — never re-merge them. **Priority: Low.** (Architectural guardrail, not a build item — it constrains future changes rather than scheduling work.)

The Retention tab is one of the better-built surfaces in the console — correct isolation, immutable evidence, shadow-first defaults, a thoughtful enforce confirm. Its gaps are about *scope* (global-only, no holds, no overrides) and *previewability* (no blast-radius before an irreversible action), not about basic correctness. Phase 1 makes it safe and consistent in weeks; Phases 2–3 make it enterprise-complete.
