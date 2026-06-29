---
title: Platform Admin — Pricing Tab Audit
tab: pricing
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

# Platform Admin — Pricing Tab Audit

## 1. Executive Summary

The Pricing tab (route `/pricing`, mounted at `apps/admin/src/app/(shell)/pricing/page.tsx`) is a
**fully-wired CRUD surface** for the **credit-pack catalog** — the packs of reveal credits TruePoint
sells. Staff author packs (`key`, `name`, `credits`, `priceCents`, `sortOrder`) and toggle each pack
between **offered** and **retired**. Every write goes through the audited `withPlatformTx` path
(`packages/db/src/client.ts:121`), writing a `credit_pack.set` row to `platform_audit_log` in the same
transaction, and is gated by the `pricing:manage` capability (`apps/api/src/features/admin/pricing.ts:24`).
The slice is small (~324 LOC across 5 files) and structurally clean: `features/pricing/{api,types}.ts`,
`hooks/usePricing.ts`, `components/PricingPage.tsx`, four-state rendering via `StateSwitch`.

The implementation is correct and well-bounded but **commercially thin**. Six material gaps stand out:
(1) **no price-change history surfaced to staff** — `credit_pack.set` audits *that* a price changed but
the console never shows the audit trail, and an upsert overwrites the prior `priceCents` in place; (2)
**no immutable price record** — unlike Stripe's archive-and-replace model, editing a pack mutates the
row, so the prior price is lost from the table; (3) **no UI capability render-gate** — the page renders
"New pack" / "Edit" / "Retire" for any staff role even though the API rejects all but `super_admin`; (4)
**no multi-currency / regional pricing** — `priceCents` is single-currency USD; (5) **no signup-bonus or
promo configuration** (an open business decision, ADR-0012); (6) **no public, customer-facing read
surface** — `credit_packs` is `REVOKE ALL` from `leadwolf_app` (`applyMigrations.ts:108`), so the
transparent pricing ADR-0012 commits to is not yet served anywhere.

This audit treats the credit-pack catalog as the Pricing tab. Note the **adjacent Plans tab**
(`features/plans/`, route `/plans`) shares the same backend router (`pricingRoutes`,
`/admin/pricing/plan-templates`) and the same `pricing:manage` gate; it is audited separately. None of
the deferred items (price history view, multi-currency, public read, signup-bonus) ship today; they are
written below as implementation-ready specs.

## 2. Current Implementation Audit

**Frontend** (`apps/admin/src/features/pricing/`, vanilla React + `fetchWithAuth`, no TanStack Query):

| File | Responsibility |
|---|---|
| `components/PricingPage.tsx` (~294 LOC) | `DataTable` of packs; create/edit `Dialog`; offer/retire toggle; client validation; `StateSwitch` four-state |
| `hooks/usePricing.ts` (~31 LOC) | `GET /credit-packs` with `{packs, loading, error, reload}` |
| `api.ts` (~54 LOC) | `fetchCreditPacks`, `upsertCreditPack`, `setCreditPackActive`; RFC-9457 `detail`/`title` error parsing |
| `types.ts` (~13 LOC) | `CreditPack` view type (presentation-only mirror) |
| `index.ts` | re-exports `PricingPage`; `app/(shell)/pricing/page.tsx` mounts it |

Client validation in `onSave` (`PricingPage.tsx:67`): `key` matches `/^[a-z0-9_]+$/`, `name` non-empty,
`credits` integer ≥ 1, `price` a finite number ≥ 0. Dollars → cents via `Math.round(price * 100)`
(`PricingPage.tsx:96`). The `key` input is disabled on edit (`draft.editingKey != null`,
`PricingPage.tsx:222`), preserving stable identity.

**Backend** (`apps/api/src/features/admin/pricing.ts`), mounted `adminRoutes.route("/pricing", …)`
(`routes.ts:834`) under the inherited `authn → platformAdmin` chain, then `requireCapability("pricing:manage")`
on `*`:

| Endpoint | Handler | Audit action | Repo method |
|---|---|---|---|
| `GET /credit-packs` | list catalog (active + retired) | `admin.list_credit_packs` (read) | `creditPackRepository.list` |
| `PUT /credit-packs` | upsert, idempotent on `key` | `credit_pack.set` | `creditPackRepository.upsert` |
| `POST /credit-packs/:key/active` | offer/retire toggle; 404 in-tx if unknown | `credit_pack.set` | `creditPackRepository.setActive` |

Validation is server-authoritative via shared Zod (`packages/types/src/pricingAdmin.ts`):
`creditPackUpsertSchema` enforces `key` ≤ 50 + regex, `name` ≤ 120, `credits` int 1…10M, `priceCents`
int 0…100M, `sortOrder` int 0…1000; `creditPackSetActiveSchema` is `{active: boolean}`. The 404 on an
unknown key is thrown **inside** the transaction (`pricing.ts:87`) so the audit row rolls back with it.

**Data** (`packages/db/src/schema/platformOps.ts:157`): `credit_packs(id, key unique, name, credits,
price_cents, active default true, sort_order default 0, created_at, updated_at)`. The repository
(`creditPackRepository.ts`) bounds `list` to `PACK_LIMIT = 200`, orders by `sortOrder, name`, and upserts
via `onConflictDoUpdate` on `key` (an update keeps `active`, bumps `updated_at`). RLS posture:
deny-all enabled and `REVOKE ALL ON credit_packs FROM leadwolf_app` (`applyMigrations.ts:108`) — only the
`BYPASSRLS` owner connection touches it.

**RBAC**: `pricing:manage` (`staffCapability.ts:28`) is in `ALL_CAPABILITIES` but appears in **no**
non-super role bundle (`ROLE_CAPABILITIES`, `staffCapability.ts:37`), so only `super_admin` can manage
pricing today. `requireCapability` re-checks per request (no JWT staleness on role revoke).

**Audit coverage**: `credit_pack.set` is in the `platformAuditAction` enum (`platformAudit.ts:18`) and
attested in `platformAuditCoverage.test.ts:33` (the PENDING→WRITTEN drift guard), so the action cannot
be dropped silently.

## 3. Enterprise Benchmark Research

Grounded comparisons against best-in-class price/billing platforms:

- **Stripe — Price objects are immutable; you archive-and-replace.** Stripe's `unit_amount` is
  immutable by design: to change a price you create a *new* Price and archive the old one
  (`active=false`), and Stripe "stores the archived product and price information indefinitely … an
  immutable audit trail of your pricing history." TruePoint instead overwrites `price_cents` in place on
  upsert, losing the prior price. (Stripe, *How products and prices work* / *Manage prices*.)
- **Stripe — multi-currency prices per product.** A single product carries multiple Price objects, one
  per currency, and **Adaptive Pricing** localises into 150+ countries. TruePoint stores one
  `price_cents` (implicitly USD). (Stripe, *Manual currency prices* / *Adaptive Pricing*.)
- **Chargebee — multiple price points per plan, plus plan versioning and scheduled price changes.**
  Chargebee defines a price point per currency-frequency combination under one plan, supports **plan
  versioning** ("evolve your pricing model in days, not quarters"), and lets a price change take effect
  immediately *or* be **scheduled** to a future date. TruePoint has none of versioning, scheduling, or
  multi-currency. (Chargebee Docs, *Plans* / *Multicurrency Pricing*.)
- **ZoomInfo / Apollo — credit packs are the direct product analogue**, but both layer
  per-plan/role-scoped credit *budgets* and renewal grants on top of the pack SKU. TruePoint's
  `plan_templates.monthlyCreditGrant` exists but the pack catalog itself carries no budget/expiry
  semantics. (Well-known product behaviour; ZoomInfo/Apollo do not publish exact admin schemas.)

The clear theme: enterprise pricing systems treat a price as an **immutable, versioned, multi-currency
record with a first-class change history**. The Pricing tab today treats it as a single mutable row.

## 4. Gap Analysis

| # | Gap | Severity | Evidence |
|---|---|---|---|
| G1 | No price-change history surfaced to staff; upsert overwrites `price_cents` in place | High | `creditPackRepository.upsert` `onConflictDoUpdate`; no history table/view |
| G2 | No immutable price record (no archive-and-replace) | High | single mutable row; contrast Stripe |
| G3 | No UI capability render-gate — actions show for roles the API rejects | Medium | `PricingPage.tsx` never calls `useStaffMe().canMaybe("pricing:manage")` |
| G4 | No multi-currency / regional pricing | Medium | `price_cents` single-currency USD; `money()` hard-codes `currency: "USD"` |
| G5 | No signup-bonus / promo / discount configuration | Medium | absent; pricing numbers are placeholders (ADR-0012) |
| G6 | No public, customer-facing pricing read surface (ADR-0012 transparency unfulfilled) | High | `REVOKE ALL ON credit_packs FROM leadwolf_app` |
| G7 | No Idempotency-Key on the upsert/toggle writes | Low | endpoints accept no idempotency header |
| G8 | No price sanity / guardrails (e.g. per-credit price, max delta confirmation) | Low | only structural Zod bounds |
| G9 | No "in-use" guard — retiring/editing a pack a tenant is mid-checkout on is unmodelled | Medium | no FK / usage check |

## 5. Functional Improvements

### 5.1 Price-change history surfaced to staff

- **Current state:** `credit_pack.set` is audited but the console never shows it; an edit overwrites the
  prior `price_cents`, so the old value is gone from `credit_packs`.
- **Problem:** Staff cannot answer "when did Starter go from $39 to $49, and who changed it?" without a
  raw `platform_audit_log` query. Commercial controls demand a visible change trail.
- **Enterprise best practice:** Stripe keeps every historical price as an immutable record and exposes
  price history; Salesforce surfaces a Setup Audit Trail per object.
- **Recommended implementation:** Add a "History" affordance per pack that calls
  `GET /admin/audit-log?action=credit_pack.set&targetType=credit_pack&targetId=<key>` (the existing F4
  audit viewer), rendering the `metadata.credits`/`metadata.priceCents` snapshots already written at
  `pricing.ts:71`. No new write path — reuse `auditLog.ts` keyset pagination.
- **Expected impact:** Full price-change accountability with zero new schema.
- **Dependencies:** F4 audit-log viewer endpoint; `audit:read` capability for the caller (or surface a
  scoped sub-read under `pricing:manage`).
- **Priority:** High

### 5.2 Capability render-gate on actions

- **Current state:** "New pack", "Edit", "Offer/Retire" render for every staff role; only `super_admin`
  passes the API gate.
- **Problem:** Non-super staff see actions that always 403 — confusing and a needless probe of the
  authorization boundary.
- **Enterprise best practice:** UI hides actions the caller cannot perform (defence-in-depth; server
  stays authoritative — exactly what `/admin/me` is for, `staffCapability.ts:60`).
- **Recommended implementation:** `const canManage = useStaffMe().canMaybe("pricing:manage")`; gate the
  "New pack" button and the per-row Edit/Retire buttons; render a read-only catalog otherwise.
- **Expected impact:** Cleaner UX, fewer support tickets, smaller attack surface for capability probing.
- **Dependencies:** `useStaffMe()` (`lib/staffMe`).
- **Priority:** High

### 5.3 Per-credit price + change-confirmation guardrails

- **Current state:** Only structural Zod bounds (0…100M cents). No derived per-credit price, no
  confirmation on a large change.
- **Problem:** A fat-finger (e.g. `$4900` instead of `$49.00`) saves silently and could be offered live.
- **Enterprise best practice:** Pricing tools show effective unit economics and confirm material deltas.
- **Recommended implementation:** Show derived `$/credit` in the dialog and table; if an edit changes
  `priceCents` by >25% (or crosses an absolute threshold), require a typed confirmation in the dialog
  (client UX) — the server remains the boundary.
- **Expected impact:** Fewer pricing incidents on a publicly visible catalog.
- **Dependencies:** none (client-only) plus 5.1 for the audited trail.
- **Priority:** Medium

## 6. Backend Improvements

### 6.1 Idempotency-Key on credit-pack writes

- **Current state:** `PUT /credit-packs` and `POST /:key/active` accept no idempotency header; a retried
  PUT re-runs the upsert (benign on the row, but writes a duplicate `credit_pack.set` audit entry).
- **Problem:** Network retries inflate the audit trail and the change history reads (5.1) with phantom
  no-op edits.
- **Enterprise best practice:** Stripe requires/honours `Idempotency-Key` on all mutating calls.
- **Recommended implementation:** Honour an `Idempotency-Key` header: persist a key→result fingerprint
  (per the platform idempotency store once built) and short-circuit replays before the `withPlatformTx`
  body. **Deferred** — needs the shared idempotency infra; until then, document the limitation.
- **Expected impact:** Clean audit trail, safe retries.
- **Dependencies:** shared Idempotency-Key store (DEFERRED — infra). **Needs platform sign-off.**
- **Priority:** Low

### 6.2 Pack "in-use" guard on retire/edit

- **Current state:** `setActive(false)` and a price edit succeed unconditionally; nothing checks whether
  a tenant is mid-checkout against that pack.
- **Problem:** Retiring/repricing a pack a customer has in a pending purchase can produce a charge that
  disagrees with the catalog.
- **Enterprise best practice:** Stripe archives a price but **keeps existing subscriptions/links valid**;
  the live catalog and in-flight purchases are decoupled.
- **Recommended implementation:** When checkout exists, snapshot the purchased pack's `priceCents` onto
  the order at purchase time (so the catalog row is purely the *offer*), and on retire just flip `active`.
  Add a read that warns if open carts reference the key. Until a checkout/orders table exists this is a
  spec, not a change.
- **Expected impact:** Catalog edits never retroactively alter a quoted price.
- **Dependencies:** checkout/orders subsystem (not yet built). **Needs platform sign-off.**
- **Priority:** Medium

## 7. Database Improvements

### 7.1 Immutable price history table (archive-and-replace)

- **Current state:** `credit_packs.price_cents` is mutated in place by upsert; prior prices are lost.
- **Problem:** No immutable pricing record; auditing relies entirely on `platform_audit_log` metadata,
  which is the staff action log, not a queryable price book.
- **Enterprise best practice:** Stripe never edits a Price; it creates a new one and archives the old,
  retaining all historical prices indefinitely as an immutable audit trail.
- **Recommended implementation:** Add `credit_pack_prices(id, pack_key, price_cents, credits,
  effective_from, effective_to nullable, created_by)` to `schema/platformOps.ts`; on every upsert that
  changes economics, close the current row (`effective_to = now()`) and insert a new one inside the same
  `withPlatformTx`. Follow the new-platform-table recipe: `schema/platformOps.ts` → `bun generate` →
  `rls/platformOps.sql` deny-all → `REVOKE ALL … FROM leadwolf_app` in `applyMigrations.ts`. `credit_packs`
  becomes the *current offer* view; the history table is the record.
- **Expected impact:** Queryable, immutable pricing history; powers 5.1 without scraping the audit log.
- **Dependencies:** migration + repo method; aligns with 5.1.
- **Priority:** High

### 7.2 Multi-currency price columns

- **Current state:** single `price_cents` (USD implied); `money()` hard-codes USD.
- **Problem:** No regional pricing; blocks international GTM and the ADR-0012 transparent pricing page in
  non-USD markets.
- **Enterprise best practice:** Stripe = multiple Price objects per product (one per currency); Chargebee
  = price points per currency-frequency combination.
- **Recommended implementation:** Add `credit_pack_prices(pack_key, currency CHAR(3), price_cents, …)`
  as a child of the catalog (folds naturally into 7.1's history table with a `currency` column);
  `creditPackUpsertSchema` accepts a `prices: {currency, priceCents}[]` array. Keep USD as the default.
- **Expected impact:** Regional pricing; international transparency.
- **Dependencies:** 7.1 table; `pricingAdmin.ts` schema change; UI multi-row price editor.
- **Priority:** Medium

## 8. API Improvements

### 8.1 Public, read-only pricing endpoint (ADR-0012 transparency)

- **Current state:** No customer-facing read of the pack catalog; `credit_packs` is `REVOKE ALL` from
  `leadwolf_app`, so even `apps/api`'s tenant connection cannot read it.
- **Problem:** ADR-0012 commits to "prices and pack sizes are public; no mandatory demo/sales gate," but
  there is nowhere to read them.
- **Enterprise best practice:** Stripe's embeddable pricing table and public Price API serve the catalog
  to anonymous buyers; ZoomInfo's opacity is precisely the complaint ADR-0012 targets.
- **Recommended implementation:** Add `GET /api/v1/pricing/credit-packs` (unauthenticated, `active=true`
  only) served by a **read-only** repo path on the owner/read connection — do *not* relax the RLS REVOKE
  on the app role. Cache aggressively (catalog changes are rare). Return only `key, name, credits,
  priceCents, sortOrder` for offered packs.
- **Expected impact:** Fulfils the transparent-pricing commitment; unblocks the public pricing page.
- **Dependencies:** a read connection that can see `credit_packs`; caching layer; security review of the
  unauthenticated surface (no PII, low risk, but rate-limit). **Needs security sign-off** on the public
  surface.
- **Priority:** High

### 8.2 Signup-bonus / promo configuration endpoint

- **Current state:** No promo/discount/signup-bonus model; ADR-0012 lists the signup bonus as a
  placeholder pending the pricing decision.
- **Problem:** Promotions are a core acquisition lever and currently require a code change.
- **Enterprise best practice:** Stripe Coupons/Promotion Codes; Chargebee Coupons with scope and expiry.
- **Recommended implementation:** Spec a `promotions` platform table (`code`, `kind` percent|fixed|bonus_credits,
  `value`, `starts_at`, `ends_at`, `max_redemptions`, `active`) with `promotion.set` audit action and a
  `pricing:manage`-gated CRUD mirroring the pack recipe. **Deferred** — gated on the business pricing
  decision (ADR-0012 §placeholders).
- **Expected impact:** Self-serve promotions without deploys.
- **Dependencies:** business pricing decision; new table + enum + coverage attestation. **Needs business
  sign-off.**
- **Priority:** Medium

## 9. Dependency Mapping

- **DB tables:** `credit_packs` (current offer); `platform_audit_log` (raw, `bootstrapAdmin.ts`,
  owner-only); proposed `credit_pack_prices`, `promotions`. Adjacent: `plan_templates` (Plans tab).
- **Services / repositories:** `creditPackRepository.{list,upsert,setActive}`
  (`packages/db/src/repositories/creditPackRepository.ts`); `withPlatformTx` (`packages/db/src/client.ts:121`).
- **API endpoints:** `GET /api/v1/admin/pricing/credit-packs`; `PUT /api/v1/admin/pricing/credit-packs`;
  `POST /api/v1/admin/pricing/credit-packs/:key/active`. Proposed: `GET /api/v1/pricing/credit-packs`
  (public read).
- **Event flow:** UI dialog → `api.ts` `fetchWithAuth` → Hono route → `requireCapability("pricing:manage")`
  → `withPlatformTx(actor, "credit_pack.set", fn, target)` → audit-row INSERT + repo write atomically →
  JSON view back → `reload()`.
- **Background workers:** none. (Public-read caching, if added, would want invalidation on
  `credit_pack.set` — currently no queue dependency.)
- **Queue dependencies:** none.
- **Permission / capability dependencies:** `pricing:manage` (`staffCapability.ts:28`), held only by
  `super_admin` today; `requireCapability` (`apps/api/src/middleware/requireCapability.ts`); coarse
  `platformAdmin` gate + `authn` ('pa' claim) inherited from the parent router.
- **Feature-flag dependencies:** none currently. Recommended: flag the public-read endpoint and
  multi-currency editor behind platform feature flags during rollout.
- **External integrations:** none today. A real billing path (Stripe) would map `credit_packs` to Stripe
  Prices; out of scope for this tab.
- **Cross-module dependencies:** shares `pricingRoutes` and `pricing:manage` with the **Plans** tab
  (`plan_templates`); audit viewer (F4 / `auditLog.ts`) is the natural consumer of `credit_pack.set`;
  `platformAuditCoverage.test.ts` drift-guards the action; the (future) customer billing/checkout flow
  consumes the offered catalog.

## 10. Security Review

- **Authorization:** Correct and layered — `authn` ('pa' claim) → `platformAdmin` (coarse) →
  `requireCapability("pricing:manage")` on `*` (`pricing.ts:24`), re-checked per request. Pricing is
  `super_admin`-only by virtue of the empty non-super bundles. **Strong.**
- **Input validation:** Server-authoritative Zod (`creditPackUpsertSchema`) with tight bounds; client
  validation is UX only. `key` regex `/^[a-z0-9_]+$/` prevents injection into the path param; the toggle
  route `encodeURIComponent`s the key client-side and looks it up parameterised server-side. **Sound.**
- **Tenant isolation:** `credit_packs` is platform-global config — no `tenant_id`. RLS deny-all enabled +
  `REVOKE ALL FROM leadwolf_app` (`applyMigrations.ts:108`) means only the `BYPASSRLS` owner connection
  reads/writes it; the customer app cannot leak it. **Strong** — and this is exactly why the public-read
  surface (8.1) must use a *separate* read path, never a REVOKE relaxation.
- **Audit integrity:** Every write is atomic with its `credit_pack.set` audit row; a 404 on an unknown
  key rolls the audit row back (`pricing.ts:87`). Reads are logged as `admin.list_credit_packs`. **Strong.**
- **JIT elevation:** `credit_pack.set` is **not** in the elevation-consuming sensitive-action set
  (`credit.adjust`, `tenant.suspend`). Repricing the public catalog is arguably as sensitive as a credit
  adjustment — **recommend** adding `credit_pack.set` to the elevation-required set (needs security
  decision; Priority Medium).
- **Findings:** No critical issues. (1) Missing UI render-gate (5.2) is defence-in-depth, not a boundary
  hole. (2) Public-read endpoint (8.1) is a new unauthenticated surface — must be rate-limited and PII-free.

## 11. Performance Review

- **Reads:** `creditPackRepository.list` is `LIMIT 200`, ordered by `(sort_order, name)`, on a tiny
  platform table — sub-millisecond, no pagination needed at this cardinality.
- **Writes:** single-row upsert/update inside one transaction; trivial.
- **Frontend:** full catalog loaded once per mount via `usePricing`; `DataTable` sorts client-side. Fine
  for ≤200 packs. No virtualization needed.
- **Scaling concern:** the public-read endpoint (8.1) would be hit by anonymous traffic — it **must** be
  cached (catalog is near-static) and rate-limited; otherwise the owner connection becomes a hotspot.
- **No N+1, no unbounded scans, no queue pressure.** This tab is not a performance risk; its only future
  hot path is the public read, addressed in 8.1.

## 12. UX/UI Improvements

### 12.1 Enum/typed inputs and derived economics in the dialog

- **Current state:** `credits`, `priceDollars`, `sortOrder` are free `type="number"` inputs; no derived
  `$/credit`; currency label is a static "(USD)".
- **Problem:** No feedback on unit economics; sort order is a raw integer with no preview.
- **Enterprise best practice:** Pricing editors show effective per-unit cost and a live preview row.
- **Recommended implementation:** Show derived `$/credit` live in the dialog and as a table column;
  preview the row's catalog position from `sortOrder`. Keep `money()` but parameterise currency for 7.2.
- **Expected impact:** Fewer mispriced packs; clearer authoring.
- **Dependencies:** none (client-only).
- **Priority:** Medium

### 12.2 Capability-aware empty/read-only state

- **Current state:** Empty state always invites "Create the first pack"; the page assumes write access.
- **Problem:** A read-only viewer (once non-super roles can *view* pricing) sees a call-to-action they
  can't fulfil.
- **Enterprise best practice:** Surfaces adapt copy/affordances to the caller's permissions.
- **Recommended implementation:** When `!canManage`, render a read-only catalog and a neutral empty
  state; hide create/edit/retire (ties to 5.2).
- **Expected impact:** Coherent experience for read-only staff.
- **Dependencies:** 5.2; a `pricing:read`-style capability if pricing view is opened to more roles.
- **Priority:** Low

## 13. Automation Opportunities

- **Cache invalidation on `credit_pack.set`:** if the public-read endpoint (8.1) is cached, emit an
  invalidation on every `credit_pack.set` so the public catalog updates within seconds.
- **Pricing-drift alert:** a scheduled check comparing live `credit_packs` against the last-approved
  snapshot, alerting if an offered pack's `$/credit` falls outside an expected band (catches fat-fingers
  post-hoc until 5.3 lands).
- **Stripe Price sync (future):** when real billing is wired, a job that reconciles each offered pack to
  a Stripe Price (archive-and-replace on change) — directly mirrors the 7.1 immutable model.
- **Audit-export hook:** include `credit_pack.set` rows in the standard `audit.export` so finance can
  reconcile pricing changes against revenue.

## 14. Monitoring & Logging

- **Today:** every mutation writes `credit_pack.set` to `platform_audit_log` with `metadata` snapshots
  (`{credits, priceCents}` on upsert, `{active}` on toggle); reads log `admin.list_credit_packs`. This is
  the system of record for *who changed pricing and when*.
- **Gaps / recommendations:**
  - **Surface** the trail (5.1) — it exists but is invisible to staff.
  - **Metric:** count of `credit_pack.set`/day and count of offered packs (catch accidental mass-retire).
  - **Alert:** any `credit_pack.set` that changes `priceCents` by a large delta (pairs with 5.3/13).
  - **Public-read observability:** request rate, cache hit ratio, and 4xx/5xx on `GET /pricing/credit-packs`
    once it ships (8.1).
  - **No PII** in any pricing log line — safe to ship to general observability (Datadog/CloudTrail-style).

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mispriced pack offered publicly (fat-finger) | Medium | High (revenue/trust on a public catalog) | 5.3 change-confirmation; 13 drift alert; 7.1 history for fast rollback |
| Edit silently overwrites prior price; no rollback record | Medium | Medium | 7.1 immutable history table |
| Public-read endpoint added without rate-limit/cache | Low | High (owner-conn hotspot) | 8.1 caching + rate-limit + flag |
| Retire/reprice mid-checkout disagrees with quoted price | Low | Medium | 6.2 snapshot-at-purchase |
| Non-super staff confused by 403-only actions | High | Low | 5.2 render-gate |
| `pricing:manage` not elevation-gated despite commercial sensitivity | Medium | Medium | add `credit_pack.set` to elevation set (security decision) |

## 16. Technical Debt

- **In-place price mutation** (no history table) — `creditPackRepository.upsert` overwrites economics;
  the only record is `platform_audit_log` metadata. Pay down via 7.1.
- **Hard-coded USD** in `money()` (`PricingPage.tsx:43`) and implicit single-currency `price_cents` —
  blocks i18n pricing. Pay down via 7.2.
- **ADR-0012 unfulfilled** — transparent public pricing is committed in the ADR but unserved (no public
  read; `REVOKE ALL` from the app role). Pay down via 8.1.
- **Placeholder numbers** — actual prices, pack sizes, and signup bonus remain business-pending
  (ADR-0012 §placeholders); the tab can author them but the *values* await the pricing decision.
- **No render-gate** — minor debt; the UI assumes write access (5.2).
- **Shared router coupling** — credit-packs and plan-templates share `pricingRoutes` and one capability;
  acceptable, but worth a note if the two diverge in sensitivity (e.g. only packs get elevation-gated).

## 17. Multi-Phase Implementation Plan

### Phase 1 — UX & correctness quick wins (mostly client; Priority High)

- **Objectives:** Make the tab safe and honest about permissions without backend change.
- **Scope:** Capability render-gate; derived `$/credit`; change-confirmation on large deltas; read-only
  state.
- **Deliverables:** `useStaffMe().canMaybe("pricing:manage")` gating in `PricingPage.tsx`; `$/credit` in
  dialog + table column; typed-confirmation modal on >25% price change; read-only empty state.
- **Technical tasks:** wire `useStaffMe`; add derived computation; extend the dialog; adjust columns;
  unit tests for the confirm-threshold logic.
- **Risks:** none material (client-only).
- **Dependencies:** `lib/staffMe`.
- **Testing requirements:** component tests for gate visibility per role; validation/confirm-threshold
  unit tests; a snapshot of the read-only state.
- **Estimated complexity:** Low (1–2 days).
- **Success criteria:** non-super staff see a read-only catalog; large price edits require confirmation;
  `$/credit` visible.

### Phase 2 — Price history & immutability (backend depth; Priority High)

- **Objectives:** Make pricing an immutable, queryable record and surface the change trail.
- **Scope:** `credit_pack_prices` history table; archive-and-replace on economic change; "History" view
  reusing the F4 audit endpoint.
- **Deliverables:** new platform table (schema → `bun generate` → `rls/platformOps.sql` deny-all →
  `REVOKE ALL` in `applyMigrations.ts`); `creditPackRepository.upsert` closes/opens history rows in-tx;
  `History` drawer in `PricingPage` calling `GET /admin/audit-log?action=credit_pack.set&targetId=<key>`.
- **Technical tasks:** migration; repo change; ensure both writes share the one `withPlatformTx`;
  history drawer UI; keep `platformAuditCoverage` green.
- **Risks:** migration on a live table (small); double-write must be atomic (same tx) to avoid drift.
- **Dependencies:** F4 audit viewer; Phase 1 (for the History affordance placement).
- **Testing requirements:** integration test that an edit writes one history row + one audit row
  atomically and rolls both back on failure; isolation test that `leadwolf_app` cannot read the new table.
- **Estimated complexity:** Medium (3–5 days).
- **Success criteria:** every economic change yields an immutable history row; staff can view a pack's
  full price history in the console.

### Phase 3 — Public transparency & multi-currency (commercial depth; Priority High/Medium)

- **Objectives:** Fulfil ADR-0012 transparent pricing and unlock regional prices.
- **Scope:** Public read endpoint `GET /api/v1/pricing/credit-packs` (active-only, cached, rate-limited,
  PII-free); multi-currency columns folded into the history table; multi-row price editor.
- **Deliverables:** read-only repo path + caching + invalidation on `credit_pack.set`; `currency` on the
  price model; `creditPackUpsertSchema` accepts a `prices[]` array; dialog multi-currency editor;
  currency-aware `money()`.
- **Technical tasks:** add read path (no RLS relaxation); cache + invalidation; schema + Zod changes; UI.
- **Risks:** unauthenticated surface — must rate-limit and cache; multi-currency increases editor
  complexity. **Behind a feature flag for rollout.**
- **Dependencies:** Phase 2 table; caching layer; **security sign-off** on the public surface.
- **Testing requirements:** load/cache test on the public endpoint; security test that it exposes only
  offered packs and no PII; multi-currency round-trip tests.
- **Estimated complexity:** Medium–High (5–8 days).
- **Success criteria:** anonymous users can read offered packs; non-USD pricing authorable and served.

### Phase 4 — Promotions, idempotency & elevation hardening (flag-heavy security phase; Priority Medium/Low)

- **Objectives:** Add the deferred security/commercial controls behind flags and sign-off.
- **Scope:** `promotions` table + CRUD (`promotion.set`); Idempotency-Key on pricing writes; add
  `credit_pack.set` to the elevation-required set; pricing-drift alert.
- **Deliverables:** promotions slice (full recipe: Zod + `platformAuditAction` enum + coverage
  PENDING→WRITTEN + repo + `withPlatformTx` route + `requireCapability` + UI dialog); idempotency wiring;
  elevation consumption in the pricing write tx; monitoring alert.
- **Technical tasks:** all of the above, each flagged.
- **Risks:** business pricing decision still pending (promotions); idempotency needs shared infra;
  elevation-gating changes the staff workflow. **Each needs a sign-off.**
- **Dependencies:** business pricing decision (promotions); shared idempotency store; security decision on
  elevation; monitoring stack.
- **Testing requirements:** promotion CRUD + audit-coverage tests; idempotent-replay test; elevation-
  required 403 test; alert-fires test.
- **Estimated complexity:** High (depends on infra readiness).
- **Success criteria:** promotions authorable; pricing writes idempotent; sensitive pricing changes
  consume an elevation; drift alerts fire.

## 18. Final Recommendations

### R1 — Surface the price-change history (do first)

- **Current state:** `credit_pack.set` is audited but invisible; edits overwrite the prior price.
- **Problem:** No staff-visible accountability for the most commercially sensitive control in the console.
- **Enterprise best practice:** Stripe's indefinite immutable price history; Salesforce Setup Audit Trail.
- **Recommended implementation:** Phase 1 render-gate + Phase 2 history table and History drawer reusing
  the F4 audit endpoint.
- **Expected impact:** Full pricing accountability and instant rollback reference.
- **Dependencies:** F4 audit viewer.
- **Priority:** High

### R2 — Fulfil ADR-0012 with a cached public read endpoint

- **Current state:** Transparent pricing is committed but unserved; `credit_packs` is `REVOKE ALL` from
  the app role.
- **Problem:** The brand's anti-opacity wedge has no surface to express it.
- **Enterprise best practice:** Stripe embeddable pricing table / public Price API.
- **Recommended implementation:** Phase 3 `GET /api/v1/pricing/credit-packs` via a separate read path
  (never relax the REVOKE), cached and rate-limited.
- **Expected impact:** Delivers the ADR-0012 differentiator.
- **Dependencies:** caching; **security sign-off**.
- **Priority:** High

### R3 — Make price an immutable, multi-currency record

- **Current state:** single mutable USD `price_cents`.
- **Problem:** Lossy edits; no regional pricing.
- **Enterprise best practice:** Stripe per-currency immutable Prices; Chargebee price points.
- **Recommended implementation:** Phase 2 history table extended with `currency` (Phase 3).
- **Expected impact:** Auditable, international pricing.
- **Dependencies:** migration; UI.
- **Priority:** High (history) / Medium (multi-currency)

### R4 — Harden the sensitive control (deferred, sign-off required)

- **Current state:** `credit_pack.set` is not elevation-gated; no Idempotency-Key; no promotions.
- **Problem:** A publicly visible commercial control lacks the just-in-time and idempotency guarantees
  applied to credit adjustments.
- **Enterprise best practice:** privileged-action elevation + idempotent mutations.
- **Recommended implementation:** Phase 4 — add `credit_pack.set` to the elevation set, honour
  Idempotency-Key, and ship promotions, **each behind a flag and the relevant sign-off**.
- **Expected impact:** Pricing changes become as controlled as credit grants.
- **Dependencies:** elevation decision; idempotency infra; business pricing decision.
- **Priority:** Medium (elevation) / Low (idempotency, promotions until decided)

**Net:** the Pricing tab is correctly and safely wired for what it does (audited, capability-gated,
RLS-isolated credit-pack CRUD). The work ahead is **commercial depth, not foundational repair** — make
pricing immutable and visible (R1/R3), serve it publicly per ADR-0012 (R2), and harden the sensitive
control last (R4).
