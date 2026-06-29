---
title: "Platform Admin Audit — Providers (Data Sources)"
tab: provider-configs
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

## 1. Executive Summary

The **Providers (Data Sources)** tab (`/provider-configs`) is the platform-admin control surface for TruePoint's metered enrichment vendors — Apollo, ZoomInfo, and Clearbit. It is **fully wired end-to-end**: a vanilla-React feature slice (`apps/admin/src/features/provider-configs/*`, ~247 LOC across 5 files) renders a `DataTable` of providers with an enable/disable switch, a masked API-key indicator, a per-minute rate limit, an inline-editable monthly cost budget, month-to-date (MTD) spend, and a passive health badge. Writes go to three Hono endpoints in `apps/api/src/features/admin/providerConfigs.ts` (107 LOC), each running inside `withPlatformTx` so every mutation is atomically paired with a `platform_audit_log` row. The capability gate is `providers:manage` (super_admin only).

The implementation is unusually disciplined on the security-critical axes: **no provider secret ever reaches the client** (`keyHint` is hard-coded `null` pending a KMS store), health is a **passive** derivation over `provider_calls` call-status history (never a live probe that touches a secret, never `response_payload`), and the cross-tenant spend/health aggregations are bounded SQL group-bys on the BYPASSRLS owner connection. The provider id is validated against a server-side `KNOWN_PROVIDERS` allowlist — client input is never trusted as a provider key.

The gaps are deliberate and well-scoped rather than accidental. There is **no KMS-backed secret store or key rotation** (so `keyHint` stays null and keys live in env), health is **passive only** (no active liveness probe), the `rateLimitPerMin` column is **stored but never enforced**, there is **no spend-vs-budget alerting or circuit breaker**, and providers cannot be created from the console (they are code-defined, requiring a deploy). A notable correctness drift: the route writes free-form audit action strings (`admin.set_provider_enabled`, `admin.set_provider_budget`, `admin.list_provider_configs`) while the closed `platformAuditAction` enum defines `provider_config.update` — the two vocabularies have diverged for this tab.

This tab is a strong v1 of vendor *configuration*; it is not yet a vendor *operations* console. The work below sequences the quick correctness wins (audit-vocabulary reconciliation, render-gating, budget-enforcement wiring) ahead of the infrastructure-bound depth (KMS secret store, active probes, alerting), with the secret-management work explicitly flagged as needing security sign-off.

## 2. Current Implementation Audit

### Frontend — `apps/admin/src/features/provider-configs/`

| File | Role |
|---|---|
| `index.ts` | Public surface — re-exports `ProviderConfigsPage` only. |
| `components/ProviderConfigsPage.tsx` | The screen: `DataTable` of providers, `TpSwitch` toggle, masked key cell, rate cell, inline `BudgetCell` (TpInput + Save), MTD-spend cell, `StatusBadge` health. Optimistic-free — every write calls `reload()`. |
| `hooks/useProviderConfigs.ts` | Loads masked configs; exposes `{providers, error, unavailable, loading, reload}` with an explicit `unavailable` flag for graceful 404 degradation. |
| `api.ts` | Seam to `/api/v1/admin/provider-configs` via `fetchWithAuth` (Bearer, ADR-0016). Maps `404 → "PROVIDER_CONFIG_ENDPOINT_UNAVAILABLE"`. |
| `types.ts` | `ProviderConfigView` view-model (mirrors `@leadwolf/types` `providerConfigViewSchema`). |
| `app/(shell)/provider-configs/page.tsx` | Thin App-Router mount. |

Four-state rendering is present but **hand-rolled** (`loading ? … : unavailable ? … : error ? … : DataTable`) rather than via the shared `StateSwitch` used by other tabs. The health badge maps `healthy/degraded/down/unknown → success/warning/danger/muted` tones. Budget is entered in whole dollars and multiplied by 100 client-side before POST.

### Backend — `apps/api/src/features/admin/providerConfigs.ts`

Three routes, all behind `requireCapability("providers:manage")` (line 36), mounted under the parent admin router that already applied authn (`pa` claim) + `platformAdmin`:

- `GET /provider-configs` — fans out `providerConfigRepository.{list, monthToDateCentsByProvider, recentHealthByProvider}` in `Promise.all`, merges against `KNOWN_PROVIDERS`, returns masked `ProviderConfigView[]`. Audited as `admin.list_provider_configs`.
- `POST /provider-configs/:provider/enabled` — validates `providerEnabledToggleSchema`, upserts via `providerConfigRepository.upsertEnabled`. Audited as `admin.set_provider_enabled`. Unknown provider → `NotFoundError`.
- `POST /provider-configs/:provider/budget` — validates `providerBudgetSchema` (non-negative, ≤ `100_000_000` cents = $1M ceiling), upserts via `upsertBudget`. Audited as `admin.set_provider_budget`.

The `KNOWN_PROVIDERS` allowlist (`apollo`, `zoominfo`, `clearbit`) is the source of valid provider ids — the path param is checked against `LABEL` before any DB write.

### Repository & schema — `packages/db`

`providerConfigRepository` (`repositories/providerConfigRepository.ts`) exposes `list`, `upsertEnabled`, `upsertBudget`, `monthToDateCentsByProvider`, `recentHealthByProvider`. The two aggregations group in SQL over `provider_calls` and **only select** `provider_name`, `status`, `cost_micros` sums and counts — never `response_payload`. Cost is stored in micros (`10_000 micros = 1¢`).

Schema (`schema/intel.ts`):
- `provider_configs` — `provider varchar(50) PK`, `label varchar(100)`, `enabled bool default true`, `rate_limit_per_min int (null=unlimited)`, `monthly_budget_cents int (null=unset)`, `updated_at`.
- `provider_calls` — `tenant_id`/`workspace_id`, `provider_name varchar(50)`, `request_hash bytea`, `status varchar(20) ∈ {hit,miss,rate_limited,error}`, `cost_micros bigint`, `response_payload jsonb`, `called_at`. Indexed `(workspace_id, called_at desc)`.

RLS (`rls/providerConfigs.sql`): `provider_configs` is **`ENABLE` (not `FORCE`) with a SELECT-only `USING(true)` policy** — the customer `leadwolf_app` role may *read* it (the enrichment budget breaker consults it as global config) but the absence of any write policy denies its INSERT/UPDATE/DELETE; only the owner/`withPlatformTx` path writes. This is a deliberate departure from the deny-all platform-table recipe and is correct for a global-config (not tenant-data) table.

Health derivation (`@leadwolf/types/providerConfigs.ts` `deriveProviderHealth`): `liveCalls = miss + rateLimited + error` (cache hits excluded); `0 → unknown`, `errorRate ≥ 0.5 → down`, `(error+rateLimited)/liveCalls ≥ 0.2 → degraded`, else `healthy`. Pinned by `providerConfigs.test.ts` and exercised cross-tenant in `platformAdminReads.itest.ts`.

## 3. Enterprise Benchmark Research

The closest analogues are unified-integration platforms (Merge.dev), data-pipeline source managers (Segment), secret managers (Vault), and flag/governance consoles (LaunchDarkly). Specific, citable capabilities this tab lacks:

1. **Merge.dev — proactive integration observability.** Merge's monitoring "catches common integration hiccups — from expired API keys to permission gaps" and surfaces *detected issues* (bad API keys, invalid credentials, missing permissions) per linked account on the dashboard so teams act before disruptions. TruePoint health is *passive and aggregate* (derived from call-status counts) and cannot distinguish "key expired" from "vendor down" or attribute a failure to a credential. ([Merge integration observability](https://www.merge.dev/features/integration-observability))
2. **Segment Monitor — source-level alerting with thresholds.** Segment fires in-app, email, and Slack alerts on source volume anomalies (configurable change-percent threshold) and successful-delivery-rate dropping below a set percentage (e.g. 99%). TruePoint has **no alerting at all** — degraded/down health and budget overruns are visible only when a super_admin opens the page. ([Segment Alerts](https://segment.com/docs/monitor/alerts/))
3. **HashiCorp Vault — TTL-bound automatic key rotation.** Vault stores and *automatically rotates* secrets on a configurable schedule (static roles default to 24h) and supports forced rotation (`vault write -force …/rotate`); dynamic secrets carry a lease/TTL and self-revoke. TruePoint has **no secret store at all** — `keyHint` is null, keys live in env, and rotation is a manual deploy. ([Vault dynamic secrets](https://developer.hashicorp.com/vault/tutorials/get-started/understand-static-dynamic-secrets))
4. **LaunchDarkly — per-resource change history with rollback.** LaunchDarkly keeps a per-flag History tab and a filterable change log, and lets an admin **roll a resource back to a previous version**. TruePoint audits each provider mutation but offers no in-tab history view, no diff, and no one-click revert of a budget/toggle change. ([LaunchDarkly change history](https://launchdarkly.com/docs/home/releases/change-history))

Adjacent expectations from the broader benchmark set (Apollo.io / ZoomInfo admin, Clay, Census connectors, Stripe billing, AWS CloudTrail): per-vendor consumption/credit dashboards with forecast-to-budget, hard spend caps with auto-pause, circuit-breaker / retry-budget controls, and immutable, exportable activity trails with field-level change tracking (Salesforce Setup Audit Trail-style). None of these are present here today.

## 4. Gap Analysis

| # | Gap | Evidence | Severity |
|---|---|---|---|
| G1 | Audit vocabulary drift — route writes `admin.set_provider_*`/`admin.list_provider_configs`; enum defines `provider_config.update`. | `providerConfigs.ts:56,89,102` vs `platformAudit.ts:58` | High |
| G2 | No KMS-backed secret store / rotation; `keyHint` hard-null; keys in env. | `providerConfigs.ts:69`; `types.ts:12` | High (infra) |
| G3 | Health is passive only — no active liveness probe, can't isolate "expired key". | `deriveProviderHealth`; `recentHealthByProvider` | Medium |
| G4 | `rateLimitPerMin` stored but never enforced (no write UI, no runtime breaker). | schema `intel.ts:124`; no setter route | Medium |
| G5 | No spend-vs-budget alerting or auto-pause; budget is decorative. | no breaker on `monthly_budget_cents` | High |
| G6 | No render-gating — Providers nav item shows for every staff role. | `navConfig.ts:38` (no capability filter) | Medium |
| G7 | No in-tab change history / rollback; no Idempotency-Key on writes. | routes return `{ok:true}` only | Medium |
| G8 | Cross-tenant spend silently returns `$0` on a non-superuser owner (Neon). | `monthToDateCentsByProvider` doc-comment | Medium |
| G9 | No provider creation, no Sales-Navigator config, no per-provider quota/circuit-breaker UI. | `KNOWN_PROVIDERS` fixed list | Low |
| G10 | Budget POST is last-writer-wins with no optimistic-concurrency token. | `upsertBudget` `onConflictDoUpdate` | Low |

## 5. Functional Improvements

### 5.1 Enforce the monthly budget (soft alert + hard auto-pause)
- **Current state:** `monthly_budget_cents` is stored and MTD spend is shown, but nothing acts on the comparison.
- **Problem:** A misconfigured enrichment job can burn through a vendor budget with zero intervention; the budget field is informational theatre.
- **Enterprise best practice:** Segment/Stripe-style threshold alerts plus a hard cap that pauses spend (Vault-style "useless past the lease").
- **Recommended implementation:** Add `budget_alert_pct` (e.g. 80) and `auto_pause boolean` columns to `provider_configs`. In the enrichment budget breaker (already reads `provider_configs`), compare MTD vs budget; at `alert_pct` emit a `provider.budget.threshold` event (→ Monitoring §14), at 100% with `auto_pause` flip `enabled=false` via an audited system action `provider_config.auto_pause`. Surface a budget-utilization bar in the table.
- **Expected impact:** Converts a passive number into an actual FinOps control; eliminates silent budget overruns.
- **Dependencies:** §7 columns; enrichment breaker (`packages/integrations`); new audit action (§6); Monitoring §14.
- **Priority:** High

### 5.2 Inline rate-limit editor wired to a runtime breaker
- **Current state:** `rateLimitPerMin` is read-only in the UI and unenforced at runtime.
- **Problem:** Operators cannot throttle a vendor that is rate-limiting us, and the displayed cap is meaningless.
- **Enterprise best practice:** Per-source throughput controls (Segment Connections).
- **Recommended implementation:** Add `POST /provider-configs/:provider/rate-limit` (Zod `providerRateLimitSchema`, audited `provider_config.update`), an inline editor cell mirroring `BudgetCell`, and a token-bucket check in the enrichment client keyed on `provider_configs.rate_limit_per_min`.
- **Expected impact:** Real backpressure control; aligns UI with behaviour.
- **Dependencies:** enrichment client; §8 endpoint; §6 repo method.
- **Priority:** Medium

### 5.3 Per-provider change history & one-click revert
- **Current state:** Mutations are audited but invisible in the tab.
- **Problem:** No way to see "who disabled ZoomInfo and when" without the central Audit-log tab; no revert.
- **Enterprise best practice:** LaunchDarkly per-resource History + rollback.
- **Recommended implementation:** Add a per-row drawer that queries `platform_audit_log` filtered by `target_type='provider' AND target_id=:provider`; render diffs; a "Revert" CTA re-issues the inverse mutation (itself audited).
- **Expected impact:** Self-service forensics + fast undo; reduces dependence on the global audit tab.
- **Dependencies:** §8 read endpoint; G1 must be fixed so `target_id` is consistently set.
- **Priority:** Medium

## 6. Backend Improvements

### 6.1 Reconcile the audit vocabulary to the closed enum
- **Current state:** Routes pass free-form strings (`admin.set_provider_enabled`, `admin.set_provider_budget`, `admin.list_provider_configs`); `withPlatformTx(action: string, …)` accepts any string, so the closed `platformAuditAction` enum (`provider_config.update`) is bypassed for writes.
- **Problem:** The drift guard (`platformAuditCoverage.test.ts`) and downstream audit-log filters key on the enum; provider mutations are uncategorizable and invisible to coverage attestation. This is a correctness bug, not a style nit.
- **Enterprise best practice:** A single closed action vocabulary (AWS CloudTrail event-name discipline).
- **Recommended implementation:** Decide one of: (a) emit `provider_config.update` for both writes with `metadata.field ∈ {enabled,budget}`, or (b) split the enum into `provider_config.set_enabled` / `provider_config.set_budget` and mark them WRITTEN in the coverage attestation. Keep reads as `admin.list_provider_configs` (reads are intentionally non-enum). Pass `{targetType:'provider', targetId:provider, metadata:{reason, field, before, after}}` on every write.
- **Expected impact:** Restores coverage-guard correctness and makes provider changes filterable in the Audit-log tab.
- **Dependencies:** `platformAudit.ts` enum; `platformAuditCoverage.test.ts`; route edits.
- **Priority:** High

### 6.2 Capture before/after + reason in audit metadata
- **Current state:** Writes record actor + action only; no diff, no reason.
- **Problem:** A budget change from $500→$50,000 is indistinguishable from $500→$501 in the trail.
- **Enterprise best practice:** Field-level change tracking (Salesforce Setup Audit Trail).
- **Recommended implementation:** Read the current row inside the same `withPlatformTx` before the upsert; pass `metadata:{before, after, reason}` (reason becomes a required body field via Zod, matching the credit/suspend recipe).
- **Expected impact:** Auditable, defensible change record per SOC 2 expectations.
- **Dependencies:** §6.1; repo `list`/`get` inside tx.
- **Priority:** High

### 6.3 Platform-level spend rollup for non-superuser owners
- **Current state:** `monthToDateCentsByProvider` returns `$0` when the owner connection lacks BYPASSRLS (managed Postgres/Neon).
- **Problem:** Production on a managed owner shows $0 MTD spend — a silently wrong control surface.
- **Enterprise best practice:** A maintained aggregate table independent of RLS bypass.
- **Recommended implementation:** A `provider_spend_daily(provider, day, cents)` rollup table maintained by a worker (§13), read by the repo when the owner cannot bypass RLS; the console reads the rollup transparently.
- **Expected impact:** Correct spend on every deploy topology.
- **Dependencies:** §7 table; §13 worker.
- **Priority:** Medium

## 7. Database Improvements

### 7.1 Add budget-policy and spend-rollup columns/tables
- **Current state:** `provider_configs` has `enabled, rate_limit_per_min, monthly_budget_cents` only; spend is computed live off `provider_calls`.
- **Problem:** No alert threshold, no auto-pause flag, no durable spend aggregate (G5, G8).
- **Enterprise best practice:** Policy stored with config; aggregates pre-rolled.
- **Recommended implementation:** Migration adding `budget_alert_pct int`, `auto_pause boolean default false`, `secret_ref text` (KMS key reference, never the secret), `key_last4 varchar(4)`, `key_rotated_at timestamptz` to `provider_configs`; new table `provider_spend_daily`. Follow the platform-table recipe: edit `schema/intel.ts`, `bun generate`, add/extend `rls/providerConfigs.sql` (keep SELECT-only read policy; deny writes), `REVOKE` in `applyMigrations.ts` where appropriate.
- **Expected impact:** Backs §5.1, §6.3, and the KMS spec (§10) with a stable schema.
- **Dependencies:** Drizzle generate; RLS; integrations breaker.
- **Priority:** High

### 7.2 Provider registry table (decouple from code-defined list)
- **Current state:** `KNOWN_PROVIDERS` is a hard-coded array; adding a provider needs a deploy.
- **Problem:** No Sales-Navigator/new-vendor onboarding without an engineering release (G9).
- **Enterprise best practice:** Data-driven connector registry (Merge/Census).
- **Recommended implementation:** Promote the registry to a seeded `provider_registry(provider PK, label, category, capabilities jsonb)` read by the route; keep the allowlist semantics (route still validates against the table, never raw input).
- **Expected impact:** New providers become a config/seed change.
- **Dependencies:** §7.1 migration pattern; seeding.
- **Priority:** Low

## 8. API Improvements

### 8.1 Idempotency-Key on provider mutations
- **Current state:** `POST …/enabled` and `…/budget` have no idempotency guard.
- **Problem:** A retried Save can double-apply or race; mirrors the known credit-endpoint gap.
- **Enterprise best practice:** Stripe-style `Idempotency-Key` on every state-changing POST.
- **Recommended implementation:** Accept an `Idempotency-Key` header, persist `(actor, key, request_hash) → result` for a TTL, replay on duplicate. Adopt the shared mechanism once it lands for the credit endpoint (deferred — needs the idempotency store).
- **Expected impact:** Safe retries; no duplicate audit rows.
- **Dependencies:** Shared idempotency store (deferred infra); §6.1 audit shape.
- **Priority:** Medium (Deferred — needs idempotency infra)

### 8.2 `GET /provider-configs/:provider/history` read endpoint
- **Current state:** No per-provider history API.
- **Problem:** Backs §5.3 (history drawer); none exists.
- **Enterprise best practice:** Per-resource audit query (LaunchDarkly API).
- **Recommended implementation:** Add a keyset-paginated read over `platform_audit_log` filtered by `target_type='provider', target_id=:provider`, audited as `admin.list_provider_history`, bounded by `PLATFORM_READ_LIMIT`.
- **Expected impact:** Powers in-tab forensics.
- **Dependencies:** §6.1 (consistent `target_id`); audit-log read repo.
- **Priority:** Medium

## 9. Dependency Mapping

- **DB tables:** `provider_configs` (config), `provider_calls` (spend + health source), `platform_audit_log` (raw, bootstrap-created). Proposed: `provider_spend_daily`, `provider_registry`.
- **Services / repositories:** `providerConfigRepository.{list, upsertEnabled, upsertBudget, monthToDateCentsByProvider, recentHealthByProvider}`; `withPlatformTx` (`packages/db/src/client.ts`); `deriveProviderHealth` (`@leadwolf/types`); enrichment budget breaker (`packages/integrations`, reads `provider_configs`).
- **API endpoints:** `GET /api/v1/admin/provider-configs`; `POST /api/v1/admin/provider-configs/:provider/enabled`; `POST /api/v1/admin/provider-configs/:provider/budget`. Proposed: `…/rate-limit`, `…/history`.
- **Event flow:** UI Save → `api.ts` `fetchWithAuth` (Bearer) → authn (`pa`) → `platformAdmin` → `requireCapability('providers:manage')` → route → `withPlatformTx` (audit row + upsert atomically) → `reload()`.
- **Background workers:** None today. Proposed: spend-rollup worker (§6.3), budget-threshold/auto-pause evaluator (§5.1), active liveness probe (§11).
- **Queue dependencies:** None today; proposed alert emission would enqueue to the notification path (BullMQ/Redis, `apps/workers`).
- **Permission / capability dependencies:** `providers:manage` (super_admin only, `staffCapability.ts:27`); `requireCapability` re-checks per request (no JWT staleness on revoke).
- **Feature-flag dependencies:** None wired. Proposed: gate auto-pause and active probes behind platform feature flags (`feature_flag.set`).
- **External integrations:** Apollo, ZoomInfo, Clearbit enrichment APIs (keys in env; **no console secret path**). Proposed: KMS (provider secret store), notification channel (Slack/email) for alerts.
- **Cross-module dependencies:** Shares `provider_calls` with the customer-facing enrichment ledger and dashboard cost feed; shares `platform_audit_log` + coverage guard with every other admin tab; `ProviderConfigView` contract shared between `apps/api` and `apps/admin` via `@leadwolf/types`.

## 10. Security Review

**Strong today:**
- **Secret containment:** `keyHint` is hard-`null`; `types.ts` and the route doc-comment forbid plaintext; `recentHealthByProvider`/`monthToDateCentsByProvider` select only `provider_name/status/cost` — never `response_payload` (no PII, no secrets leak through aggregates).
- **Input trust boundary:** provider id validated against `KNOWN_PROVIDERS`; bodies validated by `providerEnabledToggleSchema`/`providerBudgetSchema` (budget capped at $1M to defeat fat-finger).
- **Tenant isolation:** cross-tenant reads run only on the BYPASSRLS owner via `withPlatformTx`; `provider_configs` RLS is `ENABLE` with SELECT-only read for `leadwolf_app` and no write policy (writes denied to the app role).
- **Capability gate:** `providers:manage` = super_admin; re-checked per request.

**Design specs (NOT built — need security/infra sign-off):**

### 10.1 KMS-backed provider secret store (Priority: High — needs security sign-off)
- **Current state:** Keys in env; `keyHint` null; rotation = redeploy.
- **Problem:** No rotation, no last-4 visibility, no break-glass revoke; a leaked env key persists until a deploy.
- **Enterprise best practice:** Vault/KMS with TTL rotation + forced rotate.
- **Recommended implementation:** Store ciphertext refs in `provider_configs.secret_ref` (+ `key_last4`, `key_rotated_at`, §7.1); decrypt only inside the enrichment client at call time; the console shows `key_last4` as `keyHint` and offers an audited `provider_config.rotate_key` action that re-encrypts and stamps `key_rotated_at`. Secret material never transits the admin app.
- **Dependencies:** KMS provisioning; security review of the decrypt path; §7.1 columns.
- **Priority:** High (Deferred — KMS infra + security decision)

### 10.2 Elevation gate on enable/disable and budget (Priority: Medium)
- **Current state:** Provider writes do **not** consume a JIT elevation (unlike `credit.adjust`/`tenant.suspend`).
- **Problem:** Disabling ZoomInfo or zeroing a budget is a high-blast-radius action available with only a standing capability.
- **Enterprise best practice:** Step-up auth for spend/data-source posture changes.
- **Recommended implementation:** Require an active `jit_elevations` consume in-tx for `enabled→false` and budget changes above a delta threshold; 403 `elevation_required` otherwise. Peer-approval remains deferred (self-service v1).
- **Dependencies:** `jit_elevations`; route edits.
- **Priority:** Medium

## 11. Performance Review

- **List read:** Three parallel queries (`Promise.all`) — one trivial `provider_configs` scan (≤ low tens of rows) plus two SQL group-bys over `provider_calls`. The aggregations are **time-bounded** (MTD; 24h health) and grouped in SQL (no N+1), but they scan `provider_calls` — a high-volume ledger — without a `provider_name`-leading index. The existing index is `(workspace_id, called_at desc)`; the cross-tenant group-by by `(provider_name, status)` cannot use it.
  - **Recommendation (Medium):** add an index on `provider_calls (called_at, provider_name, status)` (or a covering partial index for the recent window) so the dashboard read stays index-backed as the ledger grows; long-term, serve from `provider_spend_daily` (§6.3) to avoid scanning the raw ledger entirely.
- **Writes:** single upsert each — negligible.
- **Frontend:** every mutation triggers a full `reload()` (no optimistic update). Acceptable at three rows; revisit if the provider registry (§7.2) grows.

## 12. UX/UI Improvements

### 12.1 Adopt shared `StateSwitch` and capability render-gating
- **Current state:** Four states are hand-rolled ternaries; the Providers nav item renders for every role; the page does not check `useStaffMe().canMaybe('providers:manage')`.
- **Problem:** Inconsistent with sibling tabs; a `read_only`/`support` staffer sees toggles they cannot use (server 403s, but the UI invites failure).
- **Enterprise best practice:** Capability-aware navigation and controls (LaunchDarkly/Okta admin UIs hide what you cannot do).
- **Recommended implementation:** Replace the ternary chain with `StateSwitch`; gate the nav item and the toggle/Save controls behind `canMaybe('providers:manage')` (UI-only; server stays the boundary); show a read-only badge when ungated.
- **Expected impact:** Consistent four-state UX; no dead controls.
- **Dependencies:** `lib/staffMe`; `navConfig` capability field.
- **Priority:** Medium

### 12.2 Budget utilization + spend-vs-budget visualization
- **Current state:** MTD spend and budget are separate columns; the operator does the math.
- **Problem:** No at-a-glance signal of approaching overrun.
- **Enterprise best practice:** Stripe/Segment usage-vs-limit bars.
- **Recommended implementation:** A utilization bar (`mtd/budget`) with warning tone past `budget_alert_pct`; a "near budget" pill.
- **Expected impact:** Faster FinOps triage.
- **Dependencies:** §5.1 fields.
- **Priority:** Low

## 13. Automation Opportunities

- **Spend-rollup worker** (`apps/workers`): nightly/streaming roll of `provider_calls` → `provider_spend_daily`; fixes the non-superuser-owner $0 bug and removes the live ledger scan.
- **Budget-threshold evaluator:** scheduled job comparing MTD vs budget; emits `provider.budget.threshold` and, with `auto_pause`, performs an audited `provider_config.auto_pause`.
- **Active liveness probe:** opt-in, low-frequency synthetic enrichment call per provider feeding a `provider.health.probe` signal distinct from passive call-status — isolates "key expired" (Merge-style) from "no traffic". Must be flag-gated and use the KMS-decrypted key only inside the enrichment client.
- **Key-rotation reminder:** scheduled check on `key_rotated_at` age → audit-log/notification nudge when a key exceeds a rotation SLA.

## 14. Monitoring & Logging

- **Today:** every write produces a `platform_audit_log` row (actor, action, ip) atomically with the change; passive health is visible only on page load. No metrics, no alerts.
- **Add metrics:** `provider_mtd_spend_cents{provider}`, `provider_budget_utilization{provider}`, `provider_health{provider}`, `provider_call_error_rate{provider}` — emitted from the rollup/evaluator workers.
- **Add alerts:** budget ≥ `alert_pct`; health = `down` for N consecutive windows; error-rate spike; key age past SLA. Route to the platform notification channel (Slack/email), mirroring Segment Monitor.
- **Fix audit categorization (G1/§6.1):** until the action vocabulary is reconciled, provider changes cannot be reliably filtered in the Audit-log tab or counted by the coverage guard.
- **Log hygiene:** continue to never log secrets or `response_payload`; redact `secret_ref` in any structured log.

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Budget overrun with no auto-pause (G5) | High | High (uncapped vendor spend) | §5.1 evaluator + auto-pause |
| Audit drift hides provider changes from coverage/filters (G1) | Certain (exists now) | Medium (compliance/forensics) | §6.1 reconcile enum |
| Production $0 spend on managed owner (G8) | Medium | High (wrong control surface) | §6.3 rollup |
| Env-stored keys leak with no rotation/revoke (G2) | Low | Critical | §10.1 KMS spec |
| `read_only`/`support` staffer confused by dead toggles (G6) | Medium | Low | §12.1 render-gate |
| `provider_calls` scan degrades list latency at scale | Medium | Medium | §11 index / rollup |

## 16. Technical Debt

- **Audit-vocabulary fork** (`admin.set_provider_*` vs `provider_config.update`) — the single highest-leverage cleanup; everything audit-related (filters, coverage, history drawer) depends on it.
- **Hand-rolled four-state rendering** instead of `StateSwitch` — drifts from the house pattern.
- **`keyHint`/secret store stubbed** (`null` + "stored encrypted" copy) — the UI implies a secret store that does not exist; the copy overstates current state.
- **`rate_limit_per_min` dead column** — present in schema and UI (read-only `∞`) but no setter and no enforcement.
- **Cross-tenant aggregations depend on BYPASSRLS owner** — works on single-Postgres/CI, silently zeroes on managed owners; the doc-comment is honest but the gap is latent debt.
- **No idempotency on writes** — shared with the credit-endpoint debt; resolve together.

## 17. Multi-Phase Implementation Plan

### Phase 1 — Correctness & UX quick wins (Priority: High → Critical for G1)
- **Objectives:** Make the existing surface correct and consistent without new infra.
- **Scope:** Audit-vocabulary reconciliation (§6.1) + before/after+reason metadata (§6.2); `StateSwitch` + capability render-gating (§12.1); Idempotency-Key plumbing on writes once the shared store is available (§8.1, infra-gated).
- **Deliverables:** Updated routes emitting enum actions with `{targetType:'provider', targetId, metadata}`; coverage attestation PENDING→WRITTEN; nav + control render-gates; consistent four-state page.
- **Technical tasks:** Edit `platformAudit.ts` (split or unify provider action) + `platformAuditCoverage.test.ts`; read-before-write in `withPlatformTx`; add `reason` to Zod bodies; swap ternary for `StateSwitch`; add capability to `navConfig` + `canMaybe` gates.
- **Risks:** Enum change must stay backward-compatible with the existing audit-log filter UI; coverage guard will fail until attested.
- **Dependencies:** `@leadwolf/types` enum; staff-me; idempotency store (for §8.1 only).
- **Testing requirements:** Coverage drift guard green; unit test asserting each route writes the enum action + `target_id`; render-gate tests for each of the 5 roles.
- **Estimated complexity:** S–M.
- **Success criteria:** Provider changes filterable by enum action in the Audit-log tab; non-`providers:manage` roles see a read-only surface; retries are no-ops.

### Phase 2 — FinOps depth: budget enforcement, rate limits, spend correctness (Priority: High)
- **Objectives:** Turn budget/rate into real controls and fix the managed-owner spend bug.
- **Scope:** §5.1 budget alert + auto-pause; §5.2 rate-limit editor + runtime breaker; §6.3/§13 spend-rollup worker + `provider_spend_daily`; §7.1 policy columns; §12.2 utilization viz.
- **Deliverables:** New columns/table + migration (schema → `bun generate` → RLS → REVOKE); evaluator + rollup workers; `…/rate-limit` endpoint; UI utilization bar.
- **Technical tasks:** Migration; enrichment breaker reads policy + enforces token bucket; worker emits `provider.budget.threshold`; audited `provider_config.auto_pause`.
- **Risks:** Auto-pause is a spend-cutting action — must be reversible and clearly audited; rollup correctness vs the live aggregation.
- **Dependencies:** `packages/integrations` breaker; `apps/workers`; Phase 1 audit shape.
- **Testing requirements:** Itest: budget breach flips `enabled=false` with an audit row; rate-limit enforced; rollup matches live sum on a BYPASSRLS owner and is non-zero on a non-superuser owner.
- **Estimated complexity:** M–L.
- **Success criteria:** A configured budget actually pauses spend; production MTD spend is correct on every deploy topology.

### Phase 3 — History, observability & active health (Priority: Medium)
- **Objectives:** Per-tab forensics and proactive health.
- **Scope:** §5.3 history drawer + §8.2 history endpoint; §13 active liveness probe (flag-gated); §14 metrics + alerts.
- **Deliverables:** `…/history` read endpoint; per-row drawer with diff + revert; probe worker; Prometheus-style metrics + Slack/email alerts.
- **Technical tasks:** Keyset audit-log read by `target_id`; revert re-issues inverse mutation; synthetic probe using KMS-decrypted key inside the enrichment client only.
- **Risks:** Probe must not touch secrets in the admin app; alert fatigue tuning.
- **Dependencies:** Phase 1 (consistent `target_id`); KMS for the probe key (couples to Phase 4 if active probe needs decrypted material).
- **Testing requirements:** History pagination + revert audit trail; probe emits a distinct signal; alert thresholds fire on synthetic data.
- **Estimated complexity:** M.
- **Success criteria:** Operators can see and revert provider changes in-tab; "down" providers alert before a customer notices.

### Phase 4 — Secret management & step-up auth (Priority: High, flag-heavy security phase — needs sign-off)
- **Objectives:** Eliminate env-stored keys; gate destructive provider actions.
- **Scope:** §10.1 KMS secret store + rotation (`secret_ref`, `key_last4`, `key_rotated_at`, `provider_config.rotate_key`); §10.2 elevation gate on disable/large-budget changes; §7.2 provider registry table.
- **Deliverables:** KMS-backed store; `keyHint` shows real last-4; audited rotate action; JIT elevation consume on sensitive writes; data-driven registry.
- **Technical tasks:** KMS provisioning + decrypt-at-call-time; rotation flow; `requireElevation` in-tx on the relevant routes; seed registry.
- **Risks:** Highest blast radius — a decrypt-path bug or a botched rotation can break all enrichment; requires explicit security review and break-glass.
- **Dependencies:** KMS infra; security sign-off; `jit_elevations`; Phase 2 columns.
- **Testing requirements:** Secret never appears in any response/log; rotation preserves enrichment continuity; sensitive write without elevation → 403; isolation test that `leadwolf_app` cannot read `secret_ref`.
- **Estimated complexity:** L.
- **Success criteria:** No provider key in env; rotation is a one-click audited action; disable/large-budget changes require step-up.

## 18. Final Recommendations

1. **Fix the audit-vocabulary drift first (§6.1, High).** It is a live correctness bug — provider mutations currently evade the closed-enum coverage guard and the audit-log filters — and it unblocks every downstream history/forensics feature. Low effort, high leverage.
   - **Current state / Problem / Best practice / Implementation / Impact / Dependencies / Priority:** routes emit free-form strings; mutations uncategorizable; single closed vocabulary (CloudTrail); emit `provider_config.*` enum action with `target_id` + before/after metadata, attest in the coverage test; restores filterable, attestable audit; `platformAudit.ts` + coverage test + routes; **High**.
2. **Make the budget real (§5.1 + §6.3, High).** A spend control that does not control spend is a liability; pair auto-pause with the rollup that fixes the managed-owner $0 bug so the number operators act on is also correct.
3. **Render-gate and StateSwitch the tab (§12.1, Medium).** Cheap consistency win that stops `read_only`/`support` staff from hitting predictable 403s.
4. **Treat KMS + step-up as the security capstone (§10, High, deferred).** Do not ship secret material through the admin app; the KMS store, rotation, and elevation gate need infra and an explicit security decision — specify now, build behind flags last.
5. **Do not "fix" the deliberate departures:** `provider_configs` RLS is SELECT-only-for-app by design (the budget breaker reads it), and providers are code-defined by design — only promote to a registry table if/when new-vendor onboarding cadence justifies it.

The tab is a credible v1 of provider *configuration*. The roadmap above turns it into a provider *operations* console — correct audit, enforced budgets, proactive health, and managed secrets — in priority order, with the riskiest secret-management work properly gated behind security sign-off.
