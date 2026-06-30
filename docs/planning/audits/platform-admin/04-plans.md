---
title: Platform Admin — Plans Tab Audit
tab: plans
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

# Platform Admin — Plans Tab Audit

## 1. Executive Summary

The **Plans** tab (route `/plans`, console Area 5 per `docs/planning/13a-platform-admin-feature-plan.md`) is a **fully-wired CRUD surface** over the `plan_templates` catalog — the canonical list of plan/entitlement templates the product offers. Staff author a plan's natural `key`, display `name`, `seatLimit`, optional `workspaceLimit` (null = unlimited), optional `monthlyCreditGrant` (null = none), a `features` entitlement-flag map, and `sortOrder`; they can create/edit (idempotent upsert on `key`) and offer/retire (an `active` toggle that keeps retired plans for history). Every write runs through the audited `withPlatformTx` path, gated by the `pricing:manage` capability (held only by `super_admin`), and emits a `plan_template.set` `platform_audit_log` row. The catalog is consumed downstream by the **Tenants** plan-override path (`POST /tenants/:id/plan`), which reads a template by key and stamps its caps/features onto a tenant in one transaction.

The implementation is small (5 files, ~394 LOC across `apps/admin/src/features/plans/*`), correct, well-isolated (deny-all RLS to `leadwolf_app`, owner-only writes), and idiomatic for the codebase (vanilla React + `fetchWithAuth`, `StateSwitch` four-state rendering, shared Zod in `@leadwolf/types`). It is functionally complete for a v1 internal catalog.

The gaps are **product-maturity gaps, not correctness gaps**. The `features` map is authored as a **free-text comma-separated string** in the dialog — there is no entitlement registry, no enum/picklist, and no validation that a feature key is real, so a typo silently ships a plan that grants nothing. There is **no entitlement preview** (what does this plan actually unlock?), **no plan versioning or change-history surface**, **no grandfathering semantics** (editing a live plan's caps is a destructive in-place mutation that will affect future overrides with no record of the prior shape beyond the audit metadata), **no per-region/currency variants**, and **no draft/publish lifecycle** (a half-authored plan is immediately offerable). There is also **no UI capability render-gate** — `super_admin`-only actions render for any staff member who reaches the page, with the server as the only boundary.

This document audits the current state file-by-file, benchmarks against Stripe, Chargebee, Salesforce, and HubSpot product/plan catalogs, and lays out an implementation-ready, multi-phase plan — quick correctness/UX wins first (entitlement registry + picklist, capability render-gates), then catalog depth (versioning, grandfathering, draft/publish, entitlement preview), then a flag-gated security/governance phase.

## 2. Current Implementation Audit

### Frontend — `apps/admin/src/features/plans/*`

| File | Responsibility | Notes |
|---|---|---|
| `index.ts` | Public surface | Re-exports `PlansPage`. |
| `types.ts` | `PlanTemplate` view type | Mirrors the API payload; `features: Record<string, boolean>`. |
| `api.ts` | Typed data access | `fetchPlanTemplates`, `upsertPlanTemplate`, `setPlanTemplateActive`; all via `fetchWithAuth` against `${API_BASE}/api/v1/admin/pricing/plan-templates*`. RFC-9457 `detail`/`title` surfaced via `problemMessage`. |
| `hooks/usePlans.ts` | Load + `reload` | `loading`/`error`/`templates` state; `useEffect`-driven initial load. No caching/dedup (vanilla React, by design). |
| `components/PlansPage.tsx` | Table + create/edit dialog + toggle | `DataTable` with sortable columns; `Dialog` driven by a `Draft` struct; client validation via `toast.error`; `StateSwitch` four-state. |

Key implementation facts verified in `PlansPage.tsx`:
- The dialog's `Draft.features` is a **comma-separated string** (`PlansPage.tsx:32`); on save it is split and each token set to `true` in a `Record<string, boolean>` (`PlansPage.tsx:112-118`). On edit, the stored map is flattened back to enabled keys via `enabledFeatureKeys()` and re-joined (`PlansPage.tsx:55-59`, `:79`). **The prompt's "comma-separated" description is the UI affordance; the wire/DB type is a boolean map** — both true, by design, but the UI throws away the map's structure.
- `key` input is disabled when `editingKey != null` (`PlansPage.tsx:270`) — the natural key is immutable on edit, matching the upsert contract.
- Client validation: `key` regex `/^[a-z0-9_]+$/` (`PlansPage.tsx:92`), name non-empty, integer/≥0 checks for seats and the optional fields (`optInt`). These **mirror but do not replace** the server Zod (`planTemplateUpsertSchema`).
- The features column shows only a **count** of enabled keys (`PlansPage.tsx:186-190`), not the keys themselves.
- **No `useStaffMe().canMaybe("pricing:manage")` gate** anywhere in the page — "New plan", "Edit", "Offer/Retire" render unconditionally.

### Backend — `apps/api/src/features/admin/pricing.ts`

- Router mounted under `/api/v1/admin/pricing`; parent already applied `authn` + `platformAdmin`. `pricingRoutes.use("*", requireCapability("pricing:manage"))` gates every method (`pricing.ts:24`).
- `GET /plan-templates` → `planTemplateRepository.list` inside `withPlatformTx(actor, "admin.list_plan_templates", …)` (a read recorded as an `admin.list_*` action string, not an enum mutation) (`pricing.ts:121-126`).
- `PUT /plan-templates` → validates `planTemplateUpsertSchema`, then `withPlatformTx(actor, "plan_template.set", upsert, {targetType:"plan_template", targetId:key, metadata:{seatLimit}})` (`pricing.ts:129-140`).
- `POST /plan-templates/:key/active` → validates `planTemplateSetActiveSchema`, `setActive` in-tx; `touched === 0` throws `NotFoundError` so the audit row rolls back (`pricing.ts:143-157`).

### Data — `packages/db`

- Schema `plan_templates` (`packages/db/src/schema/platformOps.ts:174-186`): `id`, `key` (unique), `name`, `seat_limit`, `workspace_limit` (nullable), `monthly_credit_grant` (nullable), `features jsonb default {}`, `active default true`, `sort_order default 0`, `created_at`, `updated_at`.
- Repo `planTemplateRepository` (`packages/db/src/repositories/planTemplateRepository.ts`): `list` (ordered `sortOrder,name`, bounded `TEMPLATE_LIMIT=200`), `upsert` (`onConflictDoUpdate` on `key`, bumps `updated_at`, does **not** touch `active`), `getByKey` (used by the plan-override path), `setActive`. Every method takes the owner-connection `Tx` from `withPlatformTx`.

### Types & Audit

- `packages/types/src/planTemplateAdmin.ts`: `planTemplateUpsertSchema` (`key` max 50 + regex; `name` max 120; `seatLimit` 0–1,000,000; `workspaceLimit` nullable; `monthlyCreditGrant` 0–100,000,000 nullable; `features z.record(z.boolean())`; `sortOrder` 0–1000), `planTemplateSetActiveSchema`, `planTemplateViewSchema`.
- `platformAuditAction` enum includes `"plan_template.set"` (`packages/types/src/platformAudit.ts:19`) — covered by the `platformAuditCoverage.test.ts` drift guard.

### Cross-module consumer

`POST /tenants/:id/plan` (`apps/api/src/features/admin/routes.ts:308-335`), gated `requireCapability("tenants:plan")` (also `super_admin`-only): reads `planTemplateRepository.getByKey`, applies `{plan, seatLimit, workspaceLimit, features}` to the tenant via `platformAdminWriteRepository.applyPlan`, audited `"plan.override"`. **It snapshots the template's values at apply time** — it does not store a reference, so a later plan edit does not retroactively change already-overridden tenants (an accidental, undocumented grandfathering side-effect of the copy semantics).

## 3. Enterprise Benchmark Research

| Capability | TruePoint Plans (today) | Enterprise reference |
|---|---|---|
| Features as first-class, mapped entities | Free-text keys in a JSONB map; no registry | **Stripe Entitlements**: `feature` objects mapped to products via `product_feature`; purchasing a product auto-creates a customer entitlement and Stripe notifies your service to provision/de-provision — features are typed objects, not free strings. ([Stripe Entitlements](https://docs.stripe.com/billing/entitlements), [Product Feature](https://docs.stripe.com/api/product-feature)) |
| Versioning / grandfathering on edit | In-place mutation; no version, no grandfathering primitive | **Chargebee**: updating an entitlement creates a **new version**; "Only New Subscriptions" grandfathers existing subscriptions on their current entitlements while new ones get the update. Plan price changes default to **grandfathering** existing subscriptions. ([Chargebee Entitlement Versions](https://www.chargebee.com/docs/billing/2.0/entitlements/entitlement-versions), [Grandfathering](https://www.chargebee.com/docs/billing/2.0/entitlements/grandfathering-entitlements)) |
| Per-currency / per-region variants | Single template, no currency/region axis | **Stripe**: multiple `Price` objects per `Product` and `currency_options` per price let one catalog product carry many currencies/regions while sharing one description. ([Stripe multi-currency prices](https://docs.stripe.com/products-prices/manage-prices), [How products & prices work](https://docs.stripe.com/products-prices/how-products-and-prices-work)) |
| Draft → publish lifecycle & archive | Binary `active` only; a half-built plan is immediately offerable | **Stripe** products/prices support `active`/archived states and `lookup_key` for stable references; **Salesforce CPQ / Product catalog** uses active flags + effective-dated price books so a product is staged before it sells. ([Stripe manage prices](https://docs.stripe.com/products-prices/manage-prices)) |
| Entitlement preview / "what this grants" | Count of enabled keys only | **HubSpot Products** and **Salesforce Product catalog** present the line-item/feature detail of a product to the operator before it's used in a quote; the operator never guesses at opaque keys. |

Where a search did not surface an exact line (e.g. Salesforce/HubSpot catalog internals), the comparison above is drawn from well-known product behaviour and is marked as such rather than cited.

## 4. Gap Analysis

| # | Gap | Severity | Lens |
|---|---|---|---|
| G1 | `features` authored as free-text; no entitlement registry/enum; typos silently grant nothing | High | data + UX |
| G2 | No UI capability render-gate (`pricing:manage`/`tenants:plan` render for all staff) | High | security UX |
| G3 | No entitlement preview ("what does this plan grant") | Medium | UX |
| G4 | No plan versioning / change-history surface (only raw audit rows) | Medium | data + ops |
| G5 | No grandfathering primitive; live edits mutate the canonical row in place | Medium | data |
| G6 | No draft/publish lifecycle; any saved plan is offerable | Medium | product |
| G7 | No per-region/currency variants | Low | product |
| G8 | Plan↔credit-pack and plan↔price are unmodeled (Plans has caps/grants but no price) | Low | product |
| G9 | No "tenants on this plan" usage view from the catalog | Low | ops |

## 5. Functional Improvements

### 5.1 Entitlement registry + picklist (replace free-text features) — addresses G1

- **Current state**: `features` is a comma-separated free-text field (`PlansPage.tsx:327-335`) split into a `Record<string,boolean>`; nothing validates the keys.
- **Problem**: A typo (`crm_snyc`) ships a plan that grants nothing; staff must memorize valid keys; the product's true entitlement vocabulary lives only in callers, not in one registry.
- **Enterprise best practice**: Stripe models features as typed `feature` objects mapped to products; the operator selects from a known set, never types a string.
- **Recommended implementation**: Add a small `plan_features` registry table (`key`, `label`, `description`, `category`, `active`) in `schema/platformOps.ts`; expose `GET /admin/pricing/plan-features` (read, `admin.list_*`). Replace the free-text input with a multi-select of registry rows in `PlansPage.tsx`. Server-side, extend `planTemplateUpsertSchema` to validate every supplied key against the registry (reject unknown keys with a `ValidationError`). Keep the stored shape `Record<string,boolean>` for backward compatibility.
- **Expected impact**: Eliminates silent mis-entitlement; turns the plan editor into a guided form.
- **Dependencies**: new table (schema + `bun generate` + `rls/platformOps.sql` deny-all + `REVOKE` in `applyMigrations.ts`); `@leadwolf/types` schema change; UI multi-select component from `@leadwolf/ui`.
- **Priority**: High.

### 5.2 Entitlement preview panel — addresses G3

- **Current state**: The table shows only a count of enabled feature keys (`PlansPage.tsx:186-190`).
- **Problem**: Staff cannot see what a plan actually unlocks without reading raw keys; mistakes in caps/features are hard to catch before a plan is offered or applied to a tenant.
- **Enterprise best practice**: HubSpot/Salesforce show the full feature/line detail of a catalog item to the operator.
- **Recommended implementation**: Add a read-only "what this plan grants" panel in the edit dialog and a row-expand in the table, rendering seat/workspace caps, monthly grant, and the registry labels (from 5.1) of enabled features.
- **Expected impact**: Fewer mis-authored plans; faster review.
- **Dependencies**: 5.1 (registry labels); `@leadwolf/ui` layout.
- **Priority**: Medium.

### 5.3 Draft/publish lifecycle — addresses G6

- **Current state**: One `active` boolean; an upsert immediately makes a plan offerable.
- **Problem**: There is no staging state; a partially-authored plan can be offered to tenants the moment it's saved.
- **Enterprise best practice**: Stripe/Salesforce stage catalog items (active flag / effective-dated price books) before they sell.
- **Recommended implementation**: Add a `status` column (`draft` | `offered` | `retired`) replacing the bare `active` boolean (migrate `active=true → offered`, `false → retired`); only `offered` plans are selectable in the Tenants plan-override picker. Add a `plan_template.publish` audited action (new enum + coverage attestation).
- **Expected impact**: Safe authoring; clear lifecycle.
- **Dependencies**: schema change + new audit action; Tenants plan-override picker filter.
- **Priority**: Medium.

## 6. Backend Improvements

### 6.1 Validate feature keys against the registry server-side — addresses G1

- **Current state**: `planTemplateUpsertSchema` accepts any `z.record(z.boolean())` (`planTemplateAdmin.ts:22`).
- **Problem**: The server is the boundary, but it currently accepts arbitrary feature keys — the registry (5.1) is toothless without server enforcement.
- **Enterprise best practice**: The billing/catalog backend rejects unknown feature references (Stripe returns an error for an unknown feature).
- **Recommended implementation**: In `PUT /plan-templates`, after parse, load the active registry keys (`planFeatureRepository.activeKeys(tx)`) and reject any supplied key not in the set with `ValidationError("Unknown feature key 'X'.")`, inside the same `withPlatformTx` (so the audit row rolls back on rejection).
- **Expected impact**: Closes the real boundary; the UI picklist becomes defence-in-depth, not the only check.
- **Dependencies**: 5.1 registry table + repo.
- **Priority**: High.

### 6.2 Persist a version snapshot on each upsert — addresses G4/G5

- **Current state**: `upsert` overwrites the row; the only trace of the prior shape is `withPlatformTx` metadata (`{seatLimit}` only).
- **Problem**: No reconstructable history of how a plan changed; audit metadata is partial (`pricing.ts:137` records only `seatLimit`).
- **Enterprise best practice**: Chargebee versions entitlements; each change is an immutable version.
- **Recommended implementation**: Add `plan_template_versions` (append-only: `template_key`, `version`, full snapshot JSONB, `created_at`, `created_by`). On `upsert`, insert a new version in the same tx. Enrich the `plan_template.set` audit `metadata` to include the full diff `{before, after}`.
- **Expected impact**: Full change history; enables grandfathering (7.x) and a history view.
- **Dependencies**: new table; repo method; audit metadata change.
- **Priority**: Medium.

## 7. Database Improvements

### 7.1 Entitlement registry table `plan_features` — addresses G1

- **Current state**: No registry; feature keys exist only as strings inside `plan_templates.features`.
- **Problem**: No source of truth for valid features; no labels/descriptions; no way to deprecate a feature.
- **Enterprise best practice**: Features are first-class rows (Stripe `feature`).
- **Recommended implementation**: `plan_features(id, key unique, label, description, category, active default true, sort_order, created_at, updated_at)` in `schema/platformOps.ts`; follow the platform-table recipe — `bun generate`, `rls/platformOps.sql` deny-all to `leadwolf_app`, `REVOKE ALL` in `applyMigrations.ts`.
- **Expected impact**: Foundation for 5.1/6.1/5.2.
- **Dependencies**: migration; RLS/REVOKE wiring.
- **Priority**: High.

### 7.2 Version history table `plan_template_versions` — addresses G4

- **Current state**: None.
- **Problem**: Plan edits are lossy.
- **Enterprise best practice**: Immutable version rows (Chargebee).
- **Recommended implementation**: Append-only table (see 6.2); deny-all RLS, owner-written; never updated.
- **Expected impact**: History + grandfathering substrate.
- **Dependencies**: 6.2 write path.
- **Priority**: Medium.

### 7.3 Add `currency` / `region` axis (variants) — addresses G7

- **Current state**: One template per key; no price/currency/region.
- **Problem**: A single global plan cannot express regional packaging.
- **Enterprise best practice**: Stripe `currency_options`; multiple prices per product.
- **Recommended implementation**: When a price model is introduced (see 5/§17 Phase 3), model variants as child rows keyed `(template_key, currency, region)` rather than bloating the template row; keep `plan_templates` as the logical product and variants as the priced instances.
- **Expected impact**: International readiness.
- **Dependencies**: pricing model design; coordinates with the `pricing`/credit-pack surface.
- **Priority**: Low.

## 8. API Improvements

### 8.1 `GET /admin/pricing/plan-features` (registry read) — addresses G1

- **Current state**: No endpoint.
- **Problem**: The UI picklist (5.1) needs the registry.
- **Enterprise best practice**: Catalog APIs expose the feature list (Stripe `GET /v1/entitlements/features`).
- **Recommended implementation**: Add to `pricing.ts`; `withPlatformTx(actor, "admin.list_plan_features", list)`; gated `pricing:manage`.
- **Expected impact**: Powers the picklist + preview.
- **Dependencies**: 7.1.
- **Priority**: High.

### 8.2 `GET /admin/pricing/plan-templates/:key/versions` (history read) — addresses G4

- **Current state**: No endpoint; history only via the global audit log.
- **Problem**: No focused change history per plan.
- **Enterprise best practice**: Per-object history (Stripe Dashboard event log per object).
- **Recommended implementation**: Read from `plan_template_versions`; `admin.list_plan_template_versions`; `pricing:manage`. Keyset-bounded (`PLATFORM_READ_LIMIT`).
- **Expected impact**: Operator-visible plan history.
- **Dependencies**: 7.2.
- **Priority**: Medium.

### 8.3 Add `Idempotency-Key` to the mutating plan endpoints — addresses dup-write risk

- **Current state**: `PUT /plan-templates` is naturally idempotent on `key`; the `active` toggle and (future) publish are not header-idempotent. **Idempotency-Key is a deferred platform primitive (not yet present on credit/admin write endpoints).**
- **Problem**: A retried toggle/publish under network flap could double-emit audit rows.
- **Enterprise best practice**: Stripe requires `Idempotency-Key` on all mutating catalog calls.
- **Recommended implementation**: Adopt the platform-wide `Idempotency-Key` middleware (when shipped) on `POST /plan-templates/:key/active` and `…/publish`; key the dedupe on `(actor, key, action, body-hash)`.
- **Expected impact**: Exactly-once audited mutations.
- **Dependencies**: **DEFERRED** — platform Idempotency-Key infra; needs platform sign-off.
- **Priority**: Medium.

## 9. Dependency Mapping

- **DB tables**: `plan_templates` (owned). Proposed: `plan_features`, `plan_template_versions`. Read-through to `platform_audit_log` (raw, `bootstrapAdmin.ts`). Consumed-by: `tenants` (via `applyPlan`).
- **Services / repositories**: `planTemplateRepository` (`list`/`upsert`/`getByKey`/`setActive`); `platformAdminWriteRepository.applyPlan` (consumer); `withPlatformTx` (`packages/db/src/client.ts`). Proposed: `planFeatureRepository`, `planTemplateVersionRepository`.
- **API endpoints**: `GET|PUT /api/v1/admin/pricing/plan-templates`, `POST …/:key/active`; consumer `POST /api/v1/admin/tenants/:id/plan`. Proposed: `GET …/plan-features`, `GET …/plan-templates/:key/versions`, `POST …/:key/publish`.
- **Event flow**: UI → `fetchWithAuth` → Hono `pricingRoutes` → `requireCapability("pricing:manage")` → `withPlatformTx` (audit row + repo write, atomic) → response → `usePlans.reload()`.
- **Background workers**: none directly. The **monthly credit-grant job** (referenced in the plan-override comment, `routes.ts:307`) reads plan grants elsewhere — Plans authors the grant amount but does not run the grant.
- **Queue dependencies**: none.
- **Permission / capability dependencies**: `pricing:manage` (Plans catalog writes) and `tenants:plan` (override) — both `super_admin`-only (`staffCapability.ts:37-48`). Middleware chain: `authn` → `platformAdmin` → `requireCapability`.
- **Feature-flag dependencies**: none today. Phases 2–3 (versioning, draft/publish, variants) and the deferred items should ship behind staff-facing flags.
- **External integrations**: none today. A future price/billing model would integrate with the billing provider (Stripe-style products/prices) — out of current scope.
- **Cross-module dependencies**: **Tenants** (plan-override consumer), **Pricing/credit-packs** (sibling under `pricingRoutes`, same capability), **audit** vocabulary (`platformAuditAction` + coverage test).

## 10. Security Review

- **Boundary is correct**: every write is `pricing:manage`-gated server-side (`pricing.ts:24`); `tenants:plan` for the override. Capabilities are re-checked per request (no JWT staleness). Reads/writes go through the BYPASSRLS owner connection inside `withPlatformTx`; `plan_templates` is deny-all to `leadwolf_app` + `REVOKE`. **No tenant data is touched** by the catalog itself — it is global product config.
- **Gap G2 (defence-in-depth)**: the UI does not render-gate `pricing:manage`. This is **not** a privilege-escalation hole (the server rejects), but it is a UX/operational defect — a `read_only` or `support` staffer sees actionable "New plan"/"Edit"/"Retire" buttons that always 403. Fix: wrap actions in `useStaffMe().canMaybe("pricing:manage")`. **Priority: High** (security-UX), not Critical (no boundary breach).
- **Input validation**: shared Zod bounds key/name/limits server-side; the free-text feature field is the one input not validated against a known set (G1/6.1) — a correctness/data-integrity issue rather than an injection one (it's stored as a JSONB boolean map, not interpolated).
- **No elevation requirement**: catalog edits are not in the sensitive-action set that consumes a `jit_elevation`. That is defensible (no tenant impact), but **applying** a plan to a tenant (the override) is tenant-affecting and should be reviewed against the elevation policy separately — out of scope for this tab.
- **Audit completeness**: `plan_template.set` covers create/edit/toggle, but `metadata` records only `seatLimit` — see 6.2 to capture the full before/after diff for forensics.

## 11. Performance Review

- The catalog is tiny and bounded (`TEMPLATE_LIMIT=200`, `list` is a single indexed scan ordered by `sort_order,name`). No pagination needed at this size.
- The page does a full reload after each mutation (`usePlans.reload()`); fine at this scale, but every reload re-runs an audited `admin.list_plan_templates` (an audit-log write per page load). At staff scale this is negligible; if the audit table is ever hot, consider whether read-listing should be audited at this granularity (a policy call, not a perf emergency).
- No N+1, no unbounded scan, no client-side heavy rendering. The proposed registry/version reads are equally small and bounded.

## 12. UX/UI Improvements

### 12.1 Capability render-gate the actions — addresses G2

- **Current state**: "New plan"/"Edit"/"Offer/Retire" always render (`PlansPage.tsx:229,208-213`).
- **Problem**: Staff without `pricing:manage` see actions that always 403.
- **Enterprise best practice**: Hide what the user can't do; server stays authoritative.
- **Recommended implementation**: `const canManage = useStaffMe().canMaybe("pricing:manage")`; gate the new/edit/toggle controls; show a read-only catalog otherwise.
- **Expected impact**: Clean, role-appropriate UI; fewer confusing 403s.
- **Dependencies**: `lib/staffMe` (already present).
- **Priority**: High.

### 12.2 Feature multi-select instead of comma-string — addresses G1/G3

- **Current state**: free-text `TpInput` (`PlansPage.tsx:327-335`).
- **Problem**: error-prone, opaque.
- **Enterprise best practice**: typed picklist (Stripe).
- **Recommended implementation**: multi-select bound to the registry (5.1) with labels + descriptions; show selected feature chips.
- **Expected impact**: No more silent typos; self-documenting.
- **Dependencies**: 5.1/8.1; `@leadwolf/ui` multi-select.
- **Priority**: High.

### 12.3 Surface features and status clearly in the table

- **Current state**: features shown as a bare count; status as Offered/Retired only.
- **Problem**: low information density; no draft state.
- **Enterprise best practice**: catalog lists show key attributes inline.
- **Recommended implementation**: feature chips/tooltip on the count; tri-state status badge once draft/publish (5.3) lands.
- **Expected impact**: Faster scanning, fewer mistakes.
- **Dependencies**: 5.1, 5.3.
- **Priority**: Medium.

## 13. Automation Opportunities

- **Entitlement drift check (CI)**: a test asserting every feature key referenced by any consumer (the app's capability/feature gates) exists in the `plan_features` registry — mirrors the `platformAuditCoverage` drift-guard pattern. Catches "plan grants `x`, but the app never reads `x`".
- **Plan-template seed/migration script**: codify the baseline plans (free/pro/enterprise) as a versioned seed so environments are reproducible, rather than hand-authored per env.
- **Version-diff digest**: when 6.2 lands, a scheduled job can summarize plan changes to an internal channel for awareness.

## 14. Monitoring & Logging

- **Today**: `plan_template.set` and `admin.list_plan_templates` land in `platform_audit_log` (actor, target, metadata). This is the system of record for "who changed which plan when".
- **Improve**: enrich `metadata` with the full before/after diff (6.2) so the audit row is self-contained for forensics; today it carries only `seatLimit`. Emit a structured log/metric on `plan_template.set` and `plan.override` (count, by actor) so spikes (mass re-pricing) are observable. When versioning lands, expose the per-plan history endpoint (8.2) so operators don't have to grep the global audit log.
- **Alert**: a simple alert on an unusual rate of `plan_template.set`/`plan.override` per actor per hour would catch a compromised `super_admin` or a runaway script.

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Typo in a feature key ships a plan that grants nothing | High | Med | Registry + server validation (5.1/6.1) |
| Editing a live plan silently changes future overrides | Med | Med | Versioning + draft/publish (5.3/6.2); note override snapshots at apply time, so already-applied tenants are safe |
| Staff confusion from ungated 403-only actions | Med | Low | Render-gate (12.1) |
| No price/currency model blocks international packaging | Low | Med | Variants design (7.3) when billing model lands |
| Audit metadata too thin for an incident | Low | Med | Full diff in metadata (6.2/14) |

## 16. Technical Debt

- **`features` as a flat `Record<string,boolean>` with no registry** — the single biggest debt; everything in §5–8 keys off fixing it.
- **UI affordance (comma-string) lossily mirrors a structured type** — the dialog can never express richer feature config (e.g. quotas per feature) without a model change.
- **No render-gate** — the only tab inconsistency vs. the established `useStaffMe().canMaybe(...)` pattern used elsewhere in the console.
- **Audit metadata partial** (`{seatLimit}` only) — inconsistent with a forensic standard.
- **No version table** — plan history is reconstructable only by replaying audit rows.
- **Idempotency-Key absent** on the toggle/publish path (a platform-wide deferred gap, not Plans-specific).

## 17. Multi-Phase Implementation Plan

### Phase 1 — UX & correctness quick wins (Priority: High)

- **Objectives**: Close the cheap, high-leverage gaps without schema-heavy work.
- **Scope**: Capability render-gate; client-side guardrails; surface features/status better.
- **Deliverables**: `useStaffMe().canMaybe("pricing:manage")` gating in `PlansPage.tsx`; feature chips in the table; clearer status; copy.
- **Technical tasks**: import `useStaffMe`; conditionally render new/edit/toggle controls; render-gate read-only fallback; table cell improvements.
- **Risks**: minimal (UI-only; server unchanged).
- **Dependencies**: `lib/staffMe` (present).
- **Testing requirements**: component test that actions are hidden without the capability and present with it; existing four-state rendering preserved.
- **Estimated complexity**: Low (1–2 days).
- **Success criteria**: Non-`pricing:manage` staff see a read-only catalog; no behavioural regression.

### Phase 2 — Entitlement registry + preview (Priority: High)

- **Objectives**: Make features first-class and validated end-to-end.
- **Scope**: `plan_features` table; registry read endpoint; multi-select + preview UI; server-side key validation.
- **Deliverables**: 7.1 table (+RLS/REVOKE), `planFeatureRepository`, `GET /admin/pricing/plan-features`, `planTemplateUpsertSchema` key-validation, multi-select dialog, preview panel.
- **Technical tasks**: schema/`platformOps.ts` → `bun generate` → `rls/platformOps.sql` deny-all → `REVOKE` in `applyMigrations.ts`; new repo + endpoint (audited `admin.list_plan_features`); types change; server validation inside `withPlatformTx`; UI multi-select/preview.
- **Risks**: migrating existing free-text keys into the registry (seed the registry from keys already present in `plan_templates.features`).
- **Dependencies**: Phase 1 (UI scaffolding); platform-table recipe.
- **Testing requirements**: itest that an unknown feature key is rejected and the audit row rolls back; registry-drift CI test (§13); UI picklist test.
- **Estimated complexity**: Medium (1–1.5 weeks).
- **Success criteria**: No plan can be saved with an unknown feature key; staff select features from a labelled list.

### Phase 3 — Catalog depth: versioning, draft/publish, history (Priority: Medium)

- **Objectives**: Lifecycle and history maturity.
- **Scope**: `plan_template_versions`; `status` (draft/offered/retired); `plan_template.publish` audit action; per-plan history endpoint + UI; enriched audit metadata.
- **Deliverables**: 7.2 table, version write in `upsert`, `status` migration, new audit enum + coverage attestation, `GET …/:key/versions`, history UI, before/after diff in metadata; Tenants override picker filters to `offered`.
- **Technical tasks**: schema + migration (`active`→`status`); repo version insert in-tx; new enum value + `platformAuditCoverage` PENDING→WRITTEN; endpoint + UI; update override picker; flag-gate the new lifecycle.
- **Risks**: data migration of `active`; coordinating the override picker change with Tenants tab.
- **Dependencies**: Phase 2; coordination with Tenants.
- **Testing requirements**: itest version row written per upsert; publish gating; coverage drift guard green; override picker excludes drafts.
- **Estimated complexity**: Medium–High (2 weeks).
- **Success criteria**: Every edit produces an immutable version; drafts are not offerable; operators can view a plan's history.

### Phase 4 — Pricing/variants + flag-gated governance (Priority: Low / DEFERRED)

- **Objectives**: International packaging and the deferred platform primitives.
- **Scope**: per-currency/region variants (7.3); `Idempotency-Key` on toggle/publish (8.3, **deferred**); optional peer-approval on plan publish reusing the `jit_elevations`/`approved_by_user_id` substrate (**deferred — peer-approval not enforced in v1**).
- **Deliverables**: variant model + endpoints; Idempotency-Key adoption once platform ships it; design-spec for publish peer-approval.
- **Technical tasks**: variant child table; integrate with billing model; wire Idempotency-Key middleware; (spec only) approval workflow.
- **Risks**: depends on a billing/price model not yet designed; Idempotency-Key and peer-approval need platform/security infra and sign-off.
- **Dependencies**: **DEFERRED** — platform Idempotency-Key infra, billing model decision, security sign-off on approval workflow.
- **Testing requirements**: idempotent-replay itest (once infra exists); variant resolution tests.
- **Estimated complexity**: High; gated on infra.
- **Success criteria**: Variants resolve per region/currency; mutating plan calls are exactly-once; (if pursued) publish requires a second approver.

## 18. Final Recommendations

### R1 — Ship Phase 1 + Phase 2 now (Priority: High)

- **Current state**: Free-text features, no render-gate.
- **Problem**: Silent mis-entitlement and an ungated UI are the two real defects shipping today.
- **Enterprise best practice**: typed features (Stripe), role-appropriate UI.
- **Recommended implementation**: render-gate (12.1) + entitlement registry with server validation (5.1/6.1/7.1/8.1).
- **Expected impact**: Eliminates the highest-likelihood correctness bug and the UI inconsistency in one sprint.
- **Dependencies**: platform-table + audited-mutation recipes; `lib/staffMe`.
- **Priority**: High.

### R2 — Add versioning + draft/publish before the catalog grows (Priority: Medium)

- **Current state**: lossy in-place edits, binary active.
- **Problem**: Once many tenants depend on plans, an unversioned destructive edit is a forensic and product hazard.
- **Enterprise best practice**: Chargebee versioning/grandfathering; Stripe staged catalog.
- **Recommended implementation**: Phase 3.
- **Expected impact**: Safe authoring, full history, draft staging.
- **Dependencies**: Phase 2.
- **Priority**: Medium.

### R3 — Treat pricing/variants/Idempotency-Key/peer-approval as design-spec-ready, infra-gated (Priority: Low)

- **Current state**: none exist; correctly **deferred**.
- **Problem**: Premature build without a billing model or platform Idempotency-Key infra would be speculative.
- **Enterprise best practice**: Stripe currency_options; Idempotency-Key on mutations.
- **Recommended implementation**: keep Phase 4 as documented specs; build when the billing model lands and platform/security sign off.
- **Expected impact**: International readiness and exactly-once mutations without over-building now.
- **Dependencies**: **DEFERRED** — billing model, Idempotency-Key infra, security sign-off.
- **Priority**: Low.

**Bottom line**: Plans is a correct, well-isolated v1 CRUD catalog. Its debt is product maturity — an entitlement registry and a render-gate are the immediate wins; versioning/draft-publish is the next tier; pricing variants and the platform-deferred primitives are real but rightly gated on infra and a human decision.

Sources: [Stripe Entitlements](https://docs.stripe.com/billing/entitlements) · [Stripe Product Feature](https://docs.stripe.com/api/product-feature) · [Stripe Manage prices](https://docs.stripe.com/products-prices/manage-prices) · [Stripe How products & prices work](https://docs.stripe.com/products-prices/how-products-and-prices-work) · [Chargebee Entitlement Versions](https://www.chargebee.com/docs/billing/2.0/entitlements/entitlement-versions) · [Chargebee Grandfathering](https://www.chargebee.com/docs/billing/2.0/entitlements/grandfathering-entitlements)
