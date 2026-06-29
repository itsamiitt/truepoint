---
title: Platform Admin — Feature Flags Tab Audit
tab: feature-flags
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

## 1. Executive Summary

The **Feature Flags** tab (`/feature-flags`) is one of the most cleanly implemented surfaces in the Platform Admin console. It is **fully wired** end-to-end: a vanilla-React slice (`apps/admin/src/features/feature-flags/*`, ~487 LOC) drives five audited Hono endpoints (`apps/api/src/features/admin/routes.ts:687-775`) over a single repository (`featureFlagRepository`, `packages/db/src/repositories/featureFlagRepository.ts`) and two RLS-protected tables (`feature_flags`, `tenant_feature_flags`). Every write runs inside `withPlatformTx(...,"feature_flag.set",...)`, so each toggle atomically emits a `platform_audit_log` row. The evaluation rule (`evaluateFlag`, `packages/core/src/featureFlags/evaluateFlag.ts`) is pure, fail-closed, and shared between the admin preview path and the in-app code gate (`isFlagEnabledForTenant`). The access model is correct and proven: `feature_flags` and `tenant_feature_flags` use **FORCE RLS** with a SELECT-only app policy and no write policy, so `leadwolf_app` can read defaults for evaluation but can never write — writes are owner/`withPlatformTx`-only.

The tab is, however, a **first-generation flag system**, not an enterprise release-management plane. Three material gaps stand out:

1. **No granular capability gate.** Unlike every other privileged route (tenant suspend uses `requireCapability("tenants:suspend")`, credits use `tenants:credits`), the five feature-flag endpoints rely **solely on the coarse `platformAdmin` (`pa===true`) gate** mounted at `routes.ts:67`. There is no `flags:manage` capability in `staffCapability.ts`, so a `read_only` staff member — who holds zero capabilities — can flip a global flag for every tenant.
2. **The data model is binary-only.** There is **no rollout-percentage, no A/B variation, no targeting rule** beyond a single per-tenant boolean override. (The "rollout-% / A-B schema present" claim in the task brief is **stale** — the live `schema/featureFlags.ts` carries only `key/description/global_enabled/default` and `flag_key/tenant_id/enabled`.) Competitors ship deterministic percentage rollouts, segment targeting, and multivariate flags.
3. **No flag lifecycle or change history.** There is no owner, no created/expires metadata surfaced, no stale-flag detection, and no per-flag change-history view — even though the `platform_audit_log` already holds the raw history.

A secondary UX defect — raw-UUID tenant entry in `OverrideDialog` with no picker — mirrors the cross-console pattern and is a Phase 1 quick win. None of the deferred items (percentage rollout schema, change requests / peer approval, scheduled changes) exist yet; this document specifies them as implementation-ready designs and marks each with the infra/security sign-off it needs.

**Bottom line:** the foundation is solid and the audit/RLS posture is exemplary. The work is to (a) close the capability-gate hole (Critical, security), (b) replace raw-UUID entry with a tenant picker (High, UX/correctness), and (c) grow the flag model toward percentage rollouts, lifecycle, and change history (Medium/High, depth).

---

## 2. Current Implementation Audit

### 2.1 Frontend (`apps/admin/src/features/feature-flags/`)

| File | LOC | Responsibility |
|---|---|---|
| `index.ts` | 3 | Public surface — re-exports `FeatureFlagsPage`. |
| `api.ts` | 57 | The only seam to `/api/v1/admin/feature-flags*` via `fetchWithAuth` (Bearer, ADR-0016). `fetchFeatureFlags`, `upsertFeatureFlag`, `setGlobalFlag`, `setTenantOverride`. |
| `hooks/useFeatureFlags.ts` | 31 | Load/loading/error/`reload` state for the flag list. |
| `components/FeatureFlagsPage.tsx` | 161 | `DataTable` of flags: key+description, inline global `TpSwitch`, default `StatusBadge`, per-flag override count; "New flag" + override dialogs. |
| `components/NewFlagDialog.tsx` | 103 | Upsert form (key · description · default switch). |
| `components/OverrideDialog.tsx` | 132 | Lists a flag's overrides (forced on/off + Clear) and adds one **by raw tenant id**. |

The page renders four states correctly (`LoadingState` / `EmptyState` / `ErrorState` / `DataTable`) but uses an **ad-hoc `loading && flags.length===0 ? … : error ? … : <DataTable>`** ternary rather than the shared `StateSwitch` component used elsewhere — a minor consistency debt. There is **no `useStaffMe().canMaybe(...)` render-gate** anywhere in the slice: the "New flag" button, the global `TpSwitch`, and the override controls are visible to any staff role that can reach the route.

### 2.2 Backend (`apps/api/src/features/admin/routes.ts:680-775`)

Five handlers, all under the parent `authn` → `platformAdmin` chain (`routes.ts:66-67`) and **none carrying `requireStaffRole`/`requireCapability`**:

| Method / path | Handler behavior | Audit action |
|---|---|---|
| `GET /feature-flags` | Two bounded queries (`listGlobal` + `allOverrides`), grouped in memory (no N+1); returns `{flags:[…overrides]}`. | `admin.list_feature_flags` (read string) |
| `PUT /feature-flags` | Zod `featureFlagUpsertSchema`; `featureFlagRepository.upsert` (idempotent on key). | `feature_flag.set` |
| `POST /feature-flags/:key/global` | `setGlobal`; throws `NotFoundError` **inside** the tx so a failed toggle rolls back its audit row. | `feature_flag.set` |
| `POST /feature-flags/:key/tenant` | Validates flag exists (`getGlobal`); `enabled:null` → `clearTenantOverride`, else `setTenantOverride`. Passes `{targetType,targetId,tenantId,metadata:{enabled}}`. | `feature_flag.set` |
| `GET /feature-flags/evaluate/:tenantId` | UUID-validates **before** the tx (clean 422, no orphan audit row); `evaluateFlagsForTenant`. | `admin.evaluate_feature_flags` (read string) |

`feature_flag.set` is registered in the `platformAuditAction` enum (`packages/types/src/platformAudit.ts:28`) and attested in the `platformAuditCoverage.test.ts:57` drift guard — the established PENDING→WRITTEN coverage gate is satisfied.

### 2.3 Data layer

- **Schema** (`packages/db/src/schema/featureFlags.ts`): `feature_flags(key PK, description, global_enabled, default, created_at, updated_at)`; `tenant_feature_flags(flag_key, tenant_id, enabled, updated_at)` with composite PK `(flag_key, tenant_id)`, FK→`feature_flags.key` and FK→`tenants.id` both `ON DELETE CASCADE`.
- **RLS** (`packages/db/src/rls/featureFlags.sql`): both tables `ENABLE` **and** `FORCE ROW LEVEL SECURITY`. `feature_flags` has a SELECT-only `USING (true)` policy and **no write policy** (global read for evaluation, writes platform-only). `tenant_feature_flags` has a SELECT policy `USING (tenant_id = current_setting('app.current_tenant_id'))` and no write policy — same proven posture as `dsar_requests`.
- **Repository** (`featureFlagRepository`): readers `listGlobal/getGlobal/overridesForTenant/overrideFor/overridesForFlag/allOverrides`; writers `upsert/setGlobal/setTenantOverride/clearTenantOverride`. No method opens its own tx — the caller picks the scoped (`withTenantTx`) or privileged (`withPlatformTx`) path.
- **Evaluation** (`packages/core/src/featureFlags/`): `evaluateFlag` (pure precedence: override → global → default → fail-closed); `evaluateFlagsForTenant` (all flags) and `evaluateFlagForTenant`/`isFlagEnabledForTenant` (single-flag hot path, two PK lookups). Integration-tested in `packages/db/test/featureFlags.itest.ts` (evaluation, audited writes, cross-tenant isolation).

**Verdict: fully-wired, audited, RLS-correct — binary-only, lifecycle-blind, and missing a granular capability gate.**

---

## 3. Enterprise Benchmark Research

The dedicated flag-platform vendors define the target. Specific, citable capabilities this tab lacks:

- **LaunchDarkly — deterministic percentage rollouts + targeting rules.** LaunchDarkly rolls a flag out to a percentage of contexts where the bucketing is *deterministic and stable per context key* (so a user does not "flip-flop" between variations), supports allocations below 1% to three decimal places, and expresses precedence via ordered **targeting rules** (conditions → variation/rollout) layered above a default rule. ([LaunchDarkly percentage rollouts](https://launchdarkly.com/docs/home/releases/percentage-rollouts), [targeting rules](https://launchdarkly.com/docs/home/flags/target-rules)) TruePoint has only a single global default plus a per-tenant boolean.
- **Statsig — flag lifecycle & automated stale-flag cleanup.** Statsig automatically classifies gates as stale with explicit reasons — `STALE_PROBABLY_DEAD_CHECK` (no checks in 30 days), `STALE_PROBABLY_LAUNCHED` (100% everyone rule), `STALE_PROBABLY_UNLAUNCHED` (0% / disabled) — excludes Permanent/recently-modified gates, and nudges owners in-console and via email/Slack to clean up or mark permanent. ([Statsig stale gates](https://docs.statsig.com/feature-flags/permanent-and-stale-gates)) TruePoint has **no** owner, permanence flag, or staleness signal; a dead flag lives forever.
- **Statsig — flag dependencies (parent/child gates).** Gates can be chained so a top-level gate enables/disables all dependents at once — a real "global kill switch guarding sub-features." ([Statsig lifecycle](https://docs.statsig.com/feature-flags/feature-flags-lifecycle)) TruePoint flags are independent; there is no dependency graph or grouped kill switch.
- **Unleash & Flagsmith — change requests (four-eyes) and scheduled changes.** Unleash gates flag edits behind a **change request** applying the four-eyes principle (a second person must approve), with the ability to preview and **schedule** changes for a future time. ([Unleash change requests](https://docs.getunleash.io/concepts/change-requests)) Flagsmith offers configurable N-approval change requests and **scheduled flags** that auto-apply at a future timestamp. ([Flagsmith change requests](https://docs.flagsmith.com/administration-and-security/governance-and-compliance/change-requests), [scheduled flags](https://docs.flagsmith.com/managing-flags/scheduled-flags)) TruePoint applies a global flip *immediately* to every tenant with no approval and no scheduling — `approved_by_user_id` exists on `jit_elevations` but peer approval is not enforced even there.

Adjacent benchmarks reinforce the lifecycle/governance gap: **LaunchDarkly** ships an immutable per-flag audit log for compliance retention; **AWS CloudTrail**/**Datadog** treat every configuration change as a first-class, queryable event with retention. TruePoint *records* every change in `platform_audit_log` but **surfaces none of it** in the flag UI — the data exists, the per-flag history view does not.

---

## 4. Gap Analysis

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | **No granular capability gate** — flag writes rely only on coarse `pa`; a `read_only` staffer can flip a global flag. | Critical | `routes.ts:687-775` carry no `requireCapability`; `staffCapability.ts` has no `flags:*`. |
| G2 | **Raw-UUID tenant entry** in `OverrideDialog` — no picker/autocomplete; typo silently overrides the wrong tenant. | High | `OverrideDialog.tsx:104-112`, regex `^[0-9a-fA-F-]{36}$` only. |
| G3 | **Binary-only model** — no percentage rollout, no variations/A-B, no segment targeting. (Brief's "rollout-% schema present" is stale.) | High | `schema/featureFlags.ts` has only boolean columns. |
| G4 | **No flag lifecycle** — no owner, permanence, created/expires surfaced, no stale detection/cleanup. | Medium | No owner/expiry columns; UI shows only key/desc/global/default/count. |
| G5 | **No per-flag change history** in UI despite full audit data. | Medium | `platform_audit_log` holds it; `FeatureFlagsPage.tsx` never reads it. |
| G6 | **No change request / approval / scheduling** — global flips are immediate and unilateral. | Medium | No approval path; `withPlatformTx` commits instantly. |
| G7 | **No dependency / grouped kill switch** between flags. | Low | Flags are independent rows. |
| G8 | **No Idempotency-Key** on flag writes — a retried `POST :key/tenant` re-runs (benign upsert, but audit double-counts). | Low | Endpoints don't read `Idempotency-Key`. |
| G9 | **`StateSwitch` not used**; bespoke ternary diverges from console convention. | Low | `FeatureFlagsPage.tsx:122-138`. |
| G10 | **No render-gate** — controls visible regardless of capability (cosmetic once G1 lands). | Low | No `useStaffMe().canMaybe(...)` in slice. |

---

## 5. Functional Improvements

#### 5.1 Tenant picker for overrides (replaces raw-UUID entry)
- **Current state:** `OverrideDialog` accepts a free-text tenant id validated only by a 36-char hex regex (`OverrideDialog.tsx:104-112`).
- **Problem:** A staffer must paste a UUID from another tab; a transposed character silently forces a flag on/off for the **wrong** tenant with no name confirmation.
- **Enterprise best practice:** LaunchDarkly/Statsig target by selecting a named context/segment from a typeahead, never a raw key.
- **Recommended implementation:** Replace the `TpInput` with a debounced typeahead backed by a new `GET /admin/tenants?query=` lookup (reuse `platformAdminRepository.listTenants` keyset search, bounded `PLATFORM_READ_LIMIT=500`). Resolve and display `name (slug)`; submit the id. Show the tenant name alongside the UUID in the existing override list.
- **Expected impact:** Eliminates the wrong-tenant override class of error; faster operation.
- **Dependencies:** Tenants lookup endpoint; shared `TenantPicker` component (cross-console, also used by Provider Configs/Tenants tabs).
- **Priority:** High

#### 5.2 Per-flag change history drawer
- **Current state:** Every change is in `platform_audit_log`, but the UI surfaces nothing.
- **Problem:** "Who turned `bulk_enrich` off for tenant X and when?" requires leaving for the Audit Log tab and filtering manually.
- **Enterprise best practice:** LaunchDarkly shows an immutable per-flag history inline.
- **Recommended implementation:** Add `GET /admin/feature-flags/:key/history` (read string `admin.list_feature_flag_history`) filtering `platform_audit_log` on `action='feature_flag.set' AND target_id=:key`, keyset-paginated, gated `audit:read`. Render in a drawer from the flag row.
- **Expected impact:** Self-service change forensics; supports incident response.
- **Dependencies:** Audit-log read repo; `audit:read` capability; G1 capability gate.
- **Priority:** Medium

#### 5.3 Flag lifecycle metadata (owner, permanence, expiry, archive)
- **Current state:** Flags have no owner/permanence/expiry; archiving means deleting (cascades overrides).
- **Problem:** Stale flags accumulate with no ownership and no safe retirement path.
- **Enterprise best practice:** Statsig tracks owner + permanence and computes staleness with explicit reasons.
- **Recommended implementation:** Add `owner_user_id uuid NULL`, `is_permanent boolean default false`, `archived_at timestamptz NULL` to `feature_flags`; surface owner + an "archive" (vs delete) action; nightly worker flags stale candidates (no `evaluate` hit in 30d + not permanent).
- **Expected impact:** Bounded flag debt; clear ownership.
- **Dependencies:** Schema migration (recipe §7.1); stale-scan worker (§13); G5 history helps "last changed."
- **Priority:** Medium

---

## 6. Backend Improvements

#### 6.1 Add a `flags:manage` capability gate (Critical security fix)
- **Current state:** All five endpoints (`routes.ts:687-775`) run under only `authn`+`platformAdmin`; no `requireCapability`.
- **Problem:** `read_only` (zero capabilities) and `compliance_officer`/`billing_ops` can flip a global flag affecting **every tenant** — privilege beyond their role bundle. This is the single most serious finding.
- **Enterprise best practice:** Every privileged mutation behind a named, least-privilege permission re-checked per request (the pattern already used by `tenants:suspend`).
- **Recommended implementation:** Add `"flags:manage"` to `staffCapability.ts` (the enum **and** `ROLE_CAPABILITIES` — grant to `super_admin` implicitly, and explicitly to no view-only role; optionally `support` per policy). Apply `requireCapability("flags:manage")` to `PUT /feature-flags`, `POST /:key/global`, `POST /:key/tenant`. Keep reads (`GET /feature-flags`, `/evaluate/:tenantId`) on a read capability or the coarse `pa`. Update `/admin/me` so the UI can render-gate.
- **Expected impact:** Closes the privilege hole; aligns flags with every other write surface.
- **Dependencies:** `requireCapability` middleware (exists); `staffMe` plumbing; coordinated UI render-gate (§12).
- **Priority:** **Critical**

#### 6.2 Optional JIT-elevation on global flag flips
- **Current state:** Global toggles commit immediately; sensitive actions (`credit.adjust`, `tenant.suspend`) consume a JIT elevation in-tx, but flags do not.
- **Problem:** A global flip is platform-wide blast radius yet has a lower bar than adjusting one tenant's credits.
- **Enterprise best practice:** Step-up auth for high-blast-radius changes.
- **Recommended implementation:** Require an active `jit_elevations` consume (FOR UPDATE SKIP LOCKED, ~10-min TTL) inside `withPlatformTx` for `POST /:key/global` only (per-tenant overrides exempt); 403 `elevation_required` otherwise.
- **Expected impact:** Forces intentional, time-boxed authorization for the widest-blast action.
- **Dependencies:** `jit_elevations` consume helper (exists); `elevation:request` capability; product sign-off on friction.
- **Priority:** Medium

#### 6.3 Structured 404 vs validation precedence audit on `:key/tenant`
- **Current state:** `getGlobal` existence check throws `NotFoundError` inside the tx (correctly rolling back the audit row).
- **Problem:** Largely correct, but a non-existent flag + valid tenant currently performs a wasted `getGlobal` round-trip before 404; acceptable but worth a single combined query at scale.
- **Enterprise best practice:** Fail fast with minimal DB work.
- **Recommended implementation:** Leave as-is unless load shows it matters; if so, fold existence into the upsert/override via `WHERE EXISTS` and 404 from `returning` length.
- **Expected impact:** Marginal.
- **Dependencies:** None.
- **Priority:** Low

---

## 7. Database Improvements

#### 7.1 Percentage-rollout + targeting columns
- **Current state:** `feature_flags` is binary (`global_enabled`, `default`); `tenant_feature_flags` is a boolean.
- **Problem:** No gradual rollout — a global flip is 0%→100% with no canary.
- **Enterprise best practice:** Deterministic percentage bucketing stable per key (LaunchDarkly).
- **Recommended implementation:** Add `rollout_pct smallint NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100)` to `feature_flags`; evaluate via stable hash `bucket = hash(key || ':' || tenant_id) % 100` (when `global_enabled=false` and no override). Bump `flagEvaluationSource` enum with `"rollout"`. Per the recipe: edit `schema/featureFlags.ts`, `bun generate`, no RLS change (same table, still FORCE + read-only app policy).
- **Expected impact:** Safe canary releases by tenant cohort.
- **Dependencies:** `evaluateFlag` change (versioned); itest update; `flagEvaluationSource` enum extension in `@leadwolf/types`.
- **Priority:** High

#### 7.2 Lifecycle columns (owner / permanence / archive)
- **Current state:** No lifecycle columns.
- **Problem:** No ownership or safe retirement (delete cascades overrides irreversibly).
- **Enterprise best practice:** Owner + permanence + archive (Statsig).
- **Recommended implementation:** Add `owner_user_id`, `is_permanent`, `archived_at` (see §5.3). Filter archived flags from in-app evaluation; keep them visible (greyed) in admin.
- **Expected impact:** Bounded flag debt.
- **Dependencies:** Migration via `bun generate`; UI archive action; stale worker.
- **Priority:** Medium

#### 7.3 Index for the override admin list
- **Current state:** `allOverrides` scans `tenant_feature_flags`; PK is `(flag_key, tenant_id)`.
- **Problem:** Fine now (low cardinality), but per-flag history/filtering will want a `tenant_id` index for the reverse lookup ("all flags overridden for tenant X").
- **Enterprise best practice:** Index the access paths you query.
- **Recommended implementation:** Add `CREATE INDEX tenant_feature_flags_tenant_idx ON tenant_feature_flags(tenant_id)` when the per-tenant view ships.
- **Expected impact:** Keeps reverse lookups index-only as override volume grows.
- **Dependencies:** Tenant-centric override view.
- **Priority:** Low

---

## 8. API Improvements

#### 8.1 Idempotency-Key on override/global writes
- **Current state:** Writes are upserts (naturally idempotent at the data layer) but every retry writes a fresh `feature_flag.set` audit row.
- **Problem:** A double-submit/network retry double-counts the audit trail and muddies change history.
- **Enterprise best practice:** `Idempotency-Key` dedupes mutating requests (Stripe model).
- **Recommended implementation:** Accept an `Idempotency-Key` header on `PUT /feature-flags`, `POST /:key/global`, `POST /:key/tenant`; persist key→result in the existing idempotency store; replay the stored response on a repeat within TTL (suppressing the second audit row). This is **deferred infra** if no shared idempotency store exists yet — mark accordingly.
- **Expected impact:** Clean audit trail; safe client retries.
- **Dependencies:** Shared idempotency-key store (deferred per program facts); applies console-wide.
- **Priority:** Medium

#### 8.2 Surface `evaluate` source + add single-flag preview
- **Current state:** `GET /feature-flags/evaluate/:tenantId` returns all flags with `source`; no single-flag variant.
- **Problem:** Debugging one flag for one tenant pulls the whole map.
- **Enterprise best practice:** Targeted "why is this flag on for this context" explain.
- **Recommended implementation:** Add `GET /feature-flags/:key/evaluate/:tenantId` → `evaluateFlagForTenant` (already exists in core), returning `{enabled, source}`. Show the resolved source in the override dialog ("Forced on" vs "Global" vs "Default" vs "Rollout").
- **Expected impact:** Faster flag debugging; clearer operator mental model.
- **Dependencies:** `evaluateFlagForTenant` (exists); read capability gate.
- **Priority:** Low

#### 8.3 Consistent RFC 9457 envelope on flag errors
- **Current state:** `ValidationError`/`NotFoundError` flow through the shared error middleware (RFC 9457); `api.ts` reads `detail`/`title`.
- **Problem:** None observed — this is correct. Documented to confirm the contract is honored.
- **Enterprise best practice:** Uniform problem+json.
- **Recommended implementation:** No change; add a contract test asserting 404 on unknown key and 422 on bad UUID return the RFC 9457 shape.
- **Expected impact:** Locks the contract.
- **Dependencies:** None.
- **Priority:** Low

---

## 9. Dependency Mapping

- **DB tables:** `feature_flags` (global defs), `tenant_feature_flags` (per-tenant overrides), `platform_audit_log` (raw, bootstrap-created, owner-only write); FK→`tenants.id`.
- **Services / repositories:** `featureFlagRepository` (`@leadwolf/db`); `evaluateFlag` / `evaluateFlagsForTenant` / `evaluateFlagForTenant` / `isFlagEnabledForTenant` (`@leadwolf/core`); `withPlatformTx` / `withTenantTx` / `actorOf` (`packages/db/src/client.ts`).
- **API endpoints:** `GET /api/v1/admin/feature-flags`, `PUT /api/v1/admin/feature-flags`, `POST /api/v1/admin/feature-flags/:key/global`, `POST /api/v1/admin/feature-flags/:key/tenant`, `GET /api/v1/admin/feature-flags/evaluate/:tenantId`.
- **Event flow:** UI dialog → `api.ts` (`fetchWithAuth`, Bearer) → Hono handler → Zod parse → `withPlatformTx(actor,"feature_flag.set",fn,{target,metadata})` → repository upsert/delete **+** `platform_audit_log` insert (atomic) → JSON → `reload()` re-fetches list.
- **Background workers:** **None today.** Proposed: nightly stale-flag scan (§5.3/§13); (future) cohort-recompute if rollout buckets become cached.
- **Queue dependencies:** None currently (synchronous writes). Stale-scan would use the existing BullMQ/Redis worker fabric (`apps/workers`).
- **Permission / capability dependencies:** Today **only** `authn`+`platformAdmin` (`pa===true`, `routes.ts:66-67`) — **no granular capability** (G1). Target: new `flags:manage` write capability + `audit:read` for history (§6.1).
- **Feature-flag dependencies (consumers):** In-app gates call `isFlagEnabledForTenant` under `withTenantTx` — e.g. `bulk_enrich` (`packages/types/src/bulkImport.ts`) and the retention engine's per-tenant gate (`packages/types/src/retention.ts`). Changing the evaluation contract (rollout) ripples to these consumers.
- **External integrations:** None. The system is fully internal — no LaunchDarkly/Statsig SDK; this is the in-house equivalent.
- **Cross-module dependencies:** `@leadwolf/types` (shared Zod DTOs, `platformAuditAction`, `staffCapability`); `@leadwolf/ui` (`DataTable`, `Dialog`, `TpSwitch`, `TpSelect`, states); `lib/authClient`/`publicConfig` (admin app); the Tenants module (for the proposed tenant picker lookup) and the Audit Log module (for the proposed history drawer).

---

## 10. Security Review

**Strengths.** RLS is exemplary: both tables are `ENABLE` **+ FORCE** with SELECT-only app policies and **no write policy**, so `leadwolf_app` cannot write a flag even with the blanket table grant; writes are owner/`withPlatformTx`-only and every one emits a `platform_audit_log` row in the same transaction (`feature_flag.set`, attested in `platformAuditCoverage.test.ts`). The `evaluate` route UUID-validates before the tx (no orphan audit rows, no raw `22P02` 500), and global-toggle 404s roll back inside the tx. The pure rule fails closed (unknown flag → off). Cross-tenant override isolation is integration-tested.

**Findings.**

| ID | Finding | Severity | Fix |
|---|---|---|---|
| S1 | **Missing granular authZ** — flag writes guarded only by coarse `pa`; any staff role can flip a global flag platform-wide. | **Critical** | §6.1 `flags:manage` `requireCapability`. |
| S2 | **No step-up for global flips** — widest blast radius lacks the JIT elevation that single-tenant credit/suspend actions require. | High | §6.2 elevation on `:key/global`. |
| S3 | **No change history surfaced** — forensic data exists but is one tab away; no per-flag immutable view. | Medium | §5.2 history drawer (gated `audit:read`). |
| S4 | **Override targets an unvalidated raw UUID** — no name confirmation; wrong-tenant override is a silent integrity risk, not just UX. | Medium | §5.1 tenant picker. |
| S5 | **No approval / four-eyes** on global flags — unilateral platform-wide change. | Medium (deferred) | §17 Phase 3 change-requests (needs security sign-off; peer-approval is explicitly deferred program-wide). |

Client-side render-gating (§12) is **defence-in-depth only** — the API must remain authoritative (S1 is the real boundary). No secrets, PII, or residency surface area in this tab.

---

## 11. Performance Review

The list path is already O(2 queries): `listGlobal` + `allOverrides` grouped in memory (explicit no-N+1, `routes.ts:689`). At realistic scale (hundreds of flags, thousands of overrides) this is a single bounded round-trip per dimension and well within `PLATFORM_READ_LIMIT`. The single-flag gate (`evaluateFlagForTenant`) is two PK/key lookups — the correct hot path for in-app gating.

**Watch items:** (1) `allOverrides` is an **unbounded** full-table read of `tenant_feature_flags` — fine today, but if a flag is overridden for tens of thousands of tenants it returns all of them; bound it or paginate the override list per flag (lazy-load on dialog open via `overridesForFlag`) before that point. (2) If percentage rollout (§7.1) lands, the per-request hash is CPU-cheap and needs no cache; only cache if a flag map is read per request on a hot path — then a short-TTL in-memory cache keyed by `(tenant_id, flag_version)` with invalidation on write. (3) The admin list re-fetches the **entire** flag+override set on every `reload()` after a single toggle — acceptable at current volume; optimistic local update would cut latency once flag count grows.

**Priority:** Bound `allOverrides` / lazy-load overrides — Medium; everything else Low.

---

## 12. UX/UI Improvements

#### 12.1 Render-gate controls by capability
- **Current state:** "New flag", global `TpSwitch`, and override controls render for any staff role reaching the route; no `useStaffMe().canMaybe(...)`.
- **Problem:** A `read_only` staffer sees write affordances that (post-§6.1) the API will 403 — confusing.
- **Enterprise best practice:** Hide actions the caller can't perform; server stays authoritative.
- **Recommended implementation:** After §6.1, gate the "New flag" button, `TpSwitch`, and override actions on `useStaffMe().canMaybe("flags:manage")`; show read-only badges otherwise.
- **Expected impact:** Clear, role-appropriate UI; fewer 403 surprises.
- **Dependencies:** §6.1; `/admin/me` exposing `flags:manage`.
- **Priority:** High

#### 12.2 Adopt shared `StateSwitch`
- **Current state:** Bespoke `loading ? … : error ? … : <DataTable>` ternary (`FeatureFlagsPage.tsx:122-138`).
- **Problem:** Diverges from the console's four-state `StateSwitch` convention; subtle empty/error inconsistencies.
- **Enterprise best practice:** One state-rendering primitive.
- **Recommended implementation:** Wrap the list in `StateSwitch` with the same `LoadingState/EmptyState/ErrorState/DataTable` arms.
- **Expected impact:** Consistency; less bespoke branching.
- **Dependencies:** None.
- **Priority:** Low

#### 12.3 Show resolved source + tenant name in override list
- **Current state:** Overrides show a mono UUID + "Forced on/off"; no tenant name, no resolved evaluation source.
- **Problem:** Operators can't tell which org a UUID is, nor *why* a flag is on for it.
- **Enterprise best practice:** Human-readable targets + an "explain" of the decision.
- **Recommended implementation:** Resolve `name (slug)` next to the UUID (via §5.1 lookup); add a per-tenant "Evaluate" affordance calling §8.2 to show `source`.
- **Expected impact:** Far clearer operations and debugging.
- **Dependencies:** §5.1, §8.2.
- **Priority:** Medium

---

## 13. Automation Opportunities

- **Nightly stale-flag scan (worker).** A BullMQ job over `feature_flags` flags candidates not referenced by an `evaluate`/gate hit in 30 days and not `is_permanent`, classified Statsig-style (`probably_launched` at 100% global, `probably_unlaunched` at 0%, `probably_dead`). Surface a "Stale" badge + owner nudge. **Priority: Medium** (depends on §7.2 lifecycle columns + a lightweight last-hit signal).
- **Audit-driven change digest.** A scheduled summary of `feature_flag.set` events (who changed what, last 24h) posted to the ops channel — derived entirely from `platform_audit_log`, no new schema. **Priority: Low.**
- **Drift guard for evaluation parity.** A test asserting the admin `evaluate` path and the in-app `isFlagEnabledForTenant` path return identical results for the same `(tenant, flag)` — guards against the two callers diverging when rollout (§7.1) lands. **Priority: Medium.**
- **Scheduled flag changes (future).** Per Flagsmith — queue a global/override change for a future timestamp via a delayed BullMQ job. **Priority: Low**, behind §17 Phase 3.

---

## 14. Monitoring & Logging

- **What exists:** Every mutation writes a `platform_audit_log` row (`feature_flag.set`) with actor, `target_id` (flag key), `tenant_id` (for overrides), and `metadata.enabled` — atomic with the change. Reads emit `admin.list_feature_flags` / `admin.evaluate_feature_flags` action strings.
- **Gaps:** (1) No metric on **evaluation volume** per flag — needed to detect dead flags and to power §13 staleness. Emit a counter (sampled) from `evaluateFlagForTenant` hot path tagged `flag_key`, `source`. (2) No alert on a **global flag flip** — a platform-wide change should page/notify (Datadog-style config-change alert) given the blast radius. (3) No dashboard tying `feature_flag.set` rate to incident timelines; expose a "recent flag changes" panel from the audit log. (4) `evaluate` and write **error rates / latency** should be on the standard API SLO dashboard with the rest of `/admin/*`.
- **Priority:** Global-flip alert — High (pairs with S2); evaluation counter — Medium; the rest — Low.

---

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A view-only/wrong-role staffer flips a global flag (no capability gate, G1/S1). | Medium | High (platform-wide) | §6.1 `flags:manage` — **do first**. |
| Wrong-tenant override from a mistyped UUID (G2/S4). | Medium | Medium (one tenant) | §5.1 tenant picker + name confirmation. |
| Evaluation contract drift when rollout lands — admin preview and in-app gate disagree. | Medium | High (silent mis-gating) | Version `evaluateFlag`; parity drift test (§13); single shared core rule. |
| Stale flags accumulate; dead code paths persist; a re-enabled stale flag misbehaves. | High | Medium | §5.3/§13 lifecycle + stale scan. |
| `allOverrides` unbounded read degrades the list as override volume grows. | Low→Medium | Medium | §11 lazy-load / bound overrides. |
| Global flip with no audit visibility delays incident diagnosis. | Medium | Medium | §14 global-flip alert + §5.2 history drawer. |

---

## 16. Technical Debt

- **`flags:manage` capability absent** — the schema (`staffCapability.ts`) and the gates both need it; the longer it's absent the more code assumes coarse `pa` is enough. (Critical-adjacent.)
- **Stale task-brief facts** — the "rollout-% / A-B schema present" note does **not** match the live schema; the doc set should be corrected so future work doesn't assume a non-existent column.
- **Bespoke state rendering** — `StateSwitch` not used (G9).
- **No render-gate plumbing** — slice never calls `useStaffMe()` (G10); trivial once §6.1 lands.
- **Delete-as-archive** — deleting a flag cascades its overrides irreversibly; there is no soft-archive (§7.2).
- **Override list not lazy** — full `allOverrides` always loaded with the list even though most are only needed when a dialog opens.
- **No contract tests** for the RFC 9457 error shapes on this route (§8.3).

---

## 17. Multi-Phase Implementation Plan

### Phase 1 — UX & correctness quick wins (Critical/High)
- **Objectives:** Close the authZ hole and the wrong-tenant-override hazard; align with console conventions.
- **Scope:** §6.1 `flags:manage` gate; §5.1 tenant picker; §12.1 render-gate; §12.2 `StateSwitch`; §8.1 Idempotency-Key (header acceptance, if the store exists — else defer to Phase 3).
- **Deliverables:** New capability in `staffCapability.ts` + `ROLE_CAPABILITIES`; `requireCapability("flags:manage")` on the three write routes; `/admin/me` exposes it; `TenantPicker` wired into `OverrideDialog`; render-gates; `StateSwitch` adoption.
- **Technical tasks:** Edit `staffCapability.ts` (enum + bundles + keep gates in sync per its own comment); add gates in `routes.ts`; add `GET /admin/tenants?query=` lookup (reuse keyset search); swap `TpInput`→`TenantPicker`; add `canMaybe` gates; refactor the page ternary.
- **Risks:** Over-restricting a role that legitimately manages flags (decide `support` inclusion with product); picker lookup perf (bounded by `PLATFORM_READ_LIMIT`).
- **Dependencies:** `requireCapability`, `useStaffMe`, Tenants search repo (all exist).
- **Testing requirements:** itest — `read_only`/`billing_ops` get **403** on each write; `super_admin` passes; UI test — controls hidden without `flags:manage`; picker resolves name and submits id.
- **Estimated complexity:** Medium (the capability change touches the shared matrix and `/admin/me`).
- **Success criteria:** A non-`flags:manage` staffer cannot write a flag via API **or** see write affordances; overrides are set by name, not raw UUID.

### Phase 2 — Lifecycle, history & evaluation depth (High/Medium)
- **Objectives:** Make flags governable and debuggable; add percentage rollout.
- **Scope:** §5.2 history drawer; §5.3/§7.2 lifecycle columns + archive; §7.1 percentage rollout; §8.2 single-flag evaluate + source in UI; §11 lazy-load overrides; §13 stale-scan worker; §14 evaluation counter.
- **Deliverables:** `feature_flags` migration (`rollout_pct`, `owner_user_id`, `is_permanent`, `archived_at`); `flagEvaluationSource += "rollout"`; deterministic hash bucketing in `evaluateFlag`; `GET /:key/history` (gated `audit:read`); `GET /:key/evaluate/:tenantId`; archive action; nightly stale worker; evaluation metric.
- **Technical tasks:** Schema edit → `bun generate` (no RLS change — same FORCE tables); update `evaluateFlag` + itest; add history/evaluate routes + audit read strings; lazy-load `overridesForFlag` on dialog open; build worker on BullMQ; emit counter.
- **Risks:** Evaluation drift (mitigate: shared core rule + parity test); migration on a hot table (add columns with defaults, non-blocking).
- **Dependencies:** Phase 1 gates; Audit Log read repo; workers fabric; `@leadwolf/types` enum bump.
- **Testing requirements:** itest — rollout bucketing is deterministic/stable per `(key,tenant)`, monotonic with `rollout_pct`; history returns only this flag's events; stale classifier matches fixtures; archived flags evaluate as if undefined for in-app gates.
- **Estimated complexity:** Large.
- **Success criteria:** A flag can be rolled out by percentage with stable bucketing; operators see per-flag history and resolved source; stale flags are detected and ownable.

### Phase 3 — Governance & flag-heavy security (Medium, deferred / sign-off)
- **Objectives:** Add four-eyes governance, scheduling, step-up, and dependencies — the highest-trust controls.
- **Scope:** §6.2 JIT elevation on global flips; §5/§17 change-requests (peer approval) for global flags; scheduled flag changes (Flagsmith-style); §13 grouped kill switch / flag dependencies (Statsig-style); global-flip alerting (§14).
- **Deliverables:** Elevation-consume on `:key/global`; a change-request table + approve flow (4-eyes) — **explicitly deferred program-wide; needs security sign-off**; delayed-job scheduling on the workers fabric; a `flag_dependencies` edge table + grouped evaluation; ops alert on global flips.
- **Technical tasks:** New platform tables via the recipe (`schema/platformOps.ts` + `bun generate` + `rls/platformOps.sql` deny-all + `REVOKE` in `applyMigrations.ts`); new audited actions in `platformAuditAction` + coverage attestation; approval UI; scheduler job; dependency-graph evaluation in core.
- **Risks:** Approval workflow couples to staff identity + notifications (infra); scheduling adds a durable-timer dependency; dependency cycles must be rejected.
- **Dependencies:** **Security/human sign-off** on peer-approval (deferred per program facts); JIT elevation infra (exists); workers scheduling; idempotency store (if §8.1 deferred here).
- **Testing requirements:** itest — global flip without elevation → 403; change-request requires a distinct approver; scheduled change applies at the timestamp and audits; dependency cycle rejected; grouped kill switch disables dependents atomically.
- **Estimated complexity:** Large (multiple new tables + workflow).
- **Success criteria:** Global flags require step-up and (where policy demands) a second approver; changes can be scheduled; a parent kill switch governs sub-features — all audited.

---

## 18. Final Recommendations

#### R1 — Add the `flags:manage` capability gate now
- **Current state:** Flag writes guarded only by coarse `pa` (`routes.ts:687-775`).
- **Problem:** Any staff role — including `read_only` — can flip a platform-wide flag. The single most serious finding in this tab.
- **Enterprise best practice:** Least-privilege, per-request capability checks (already standard for tenant/credit actions).
- **Recommended implementation:** §6.1 — extend `staffCapability.ts`, gate the three writes, expose via `/admin/me`, render-gate the UI.
- **Expected impact:** Eliminates a real privilege-escalation path.
- **Dependencies:** `requireCapability` (exists).
- **Priority:** **Critical**

#### R2 — Replace raw-UUID override entry with a tenant picker
- **Current state:** Free-text UUID, regex-only validation (`OverrideDialog.tsx`).
- **Problem:** Silent wrong-tenant overrides — an integrity risk, not just UX.
- **Enterprise best practice:** Named typeahead targeting.
- **Recommended implementation:** §5.1 — `TenantPicker` over a bounded keyset lookup; show name alongside UUID.
- **Expected impact:** Removes a whole error class; reusable across the console.
- **Dependencies:** Tenants search repo.
- **Priority:** High

#### R3 — Add percentage rollout with deterministic bucketing
- **Current state:** Binary global flip (0%→100%).
- **Problem:** No safe canary; the brief's "rollout-% present" is stale.
- **Enterprise best practice:** Deterministic, stable-per-key percentage rollouts (LaunchDarkly).
- **Recommended implementation:** §7.1 — `rollout_pct` + hash bucketing + `"rollout"` source, versioned in the shared core rule.
- **Expected impact:** Gradual, reversible releases by tenant cohort.
- **Dependencies:** `evaluateFlag` change + parity test; enum bump.
- **Priority:** High

#### R4 — Surface per-flag change history and lifecycle
- **Current state:** Full audit data exists; UI shows none; no owner/permanence/staleness.
- **Problem:** No self-service forensics, no flag-debt control.
- **Enterprise best practice:** Immutable per-flag history (LaunchDarkly) + lifecycle/stale cleanup (Statsig).
- **Recommended implementation:** §5.2 history drawer (gated `audit:read`) + §5.3/§7.2 lifecycle columns + §13 stale scan.
- **Expected impact:** Faster incident triage; bounded flag debt.
- **Dependencies:** Audit read repo; workers fabric; lifecycle migration.
- **Priority:** Medium

#### R5 — Step-up + governance for global flips (deferred, sign-off)
- **Current state:** Global flips are immediate, unilateral, and lower-bar than a single-tenant credit change.
- **Problem:** The widest-blast action has the weakest controls.
- **Enterprise best practice:** Step-up auth + four-eyes change requests + scheduling (Unleash/Flagsmith).
- **Recommended implementation:** §6.2 JIT elevation on `:key/global` now; change-requests/scheduling in Phase 3 — **requires security/human sign-off (peer-approval is deferred program-wide)**.
- **Expected impact:** Intentional, authorized, reviewable platform-wide changes.
- **Dependencies:** JIT elevation (exists); approval infra + security decision (deferred).
- **Priority:** Medium (elevation); deferred for approval/scheduling.

---

*Sources (benchmark §3):* [LaunchDarkly percentage rollouts](https://launchdarkly.com/docs/home/releases/percentage-rollouts) · [LaunchDarkly targeting rules](https://launchdarkly.com/docs/home/flags/target-rules) · [Statsig permanent & stale gates](https://docs.statsig.com/feature-flags/permanent-and-stale-gates) · [Statsig flag lifecycle](https://docs.statsig.com/feature-flags/feature-flags-lifecycle) · [Unleash change requests](https://docs.getunleash.io/concepts/change-requests) · [Flagsmith change requests](https://docs.flagsmith.com/administration-and-security/governance-and-compliance/change-requests) · [Flagsmith scheduled flags](https://docs.flagsmith.com/managing-flags/scheduled-flags)
