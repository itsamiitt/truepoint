---
title: Platform Admin — Billing & Revenue Ops Tab Audit
tab: billing
status: read-only
last_audited: 2026-06-29
owner: platform-admin
---

# Platform Admin — Billing & Revenue Ops Audit

## 1. Executive Summary

The Billing & Revenue Ops tab (route `/billing`, spec 13a Area 4 / 13 §3.4) is **read-only-wired**: a single cross-tenant economics dashboard, no write actions, no drill-down. It renders six `StatTile`s (revenue, provider spend, gross margin, cost-per-reveal, credits sold/consumed, reveals charged/total) plus a trailing-window selector (7d/30d/90d/12m), all driven by one endpoint — `GET /api/v1/admin/billing/economics?sinceDays=N` — backed by `platformBillingReadRepository.economicsSummary` (three raw aggregate scans over `purchases × contact_reveals × provider_calls`). The read is gated by `requireCapability("billing:read")` (super_admin + billing_ops) and wrapped in the audited `withPlatformTx(actor, "admin.billing_economics", …)`.

The implementation is correct and well-isolated for what it does: aggregates only, never per-tenant PII or row dumps; bounded by the audited owner-connection read path. But for a finance/revenue-ops console it is **thin**. There is no drill-down (which tenants drove the margin?), no per-tenant economics, no MRR/ARR/churn/cohort view, no failed-payment/dunning surface, no reconciliation status, no CSV export, and no write action surfaced on this tab — the only billing mutation that exists (`refundPurchase`) lives on the Tenants detail, gated by `tenants:credits`, and audited as `credit.adjust`. The underlying credit model is a **bare counter** (`tenants.reveal_credit_balance`); the append-only `credit_ledger` that gives a provable `balance == SUM(delta)` invariant is **deferred to M11** (ADR-0029), and the `billing-recon` worker (07 §8) is **not built**. This audit specifies the path from a read-only economics tile board to an enterprise revenue-ops console, sequencing UX/correctness quick wins first, then drill-down + reconciliation depth, then the ledger-dependent and Stripe-dependent capabilities that require M11 infrastructure.

## 2. Current Implementation Audit

**Frontend** (`apps/admin/src/features/billing/`, ~139 LOC across 5 files):
- `index.ts` — exports `BillingEconomicsPage`.
- `components/BillingEconomicsPage.tsx` — the dashboard; `StateSwitch` four-state wrapper, `TpSelect` period picker, a responsive grid of six `StatTile`s. `money()`/`count()` formatters local to the file.
- `hooks/useEconomics.ts` — vanilla React (`useState`/`useEffect`/`useCallback`), `setPeriod` + `reload`; default 30 days. No TanStack Query (consistent with the apps/admin convention).
- `api.ts` — `fetchEconomics(sinceDays)` via `fetchWithAuth` against `${API_BASE}/api/v1/admin/billing/economics`; RFC 9457 `detail`/`title` extraction on error.
- `types.ts` — `EconomicsSummary` view type (mirrors the API payload).
- Route: `apps/admin/src/app/(shell)/billing/page.tsx` — thin mount.

**Backend** (`apps/api/src/features/admin/billing.ts`, 54 LOC):
- `billingRoutes` mounted under `/api/v1/admin/billing`; parent already applied `authn` → `platformAdmin`. `billingRoutes.use("*", requireCapability("billing:read"))`.
- `GET /economics` — validates `economicsQuerySchema` (`packages/types/src/billingAdmin.ts`: `sinceDays` int 1–365, default 30), computes `since`, runs `economicsSummary` inside `withPlatformTx(actorOf(c), "admin.billing_economics", …)`. Derives `providerSpendCents = round(providerSpendMicros / 10_000)`, `costPerRevealCents`, `marginCents = revenueCents − providerSpendCents`. Returns `{ summary }`.

**Repository** (`packages/db/src/repositories/platformBillingReads.ts`):
- `economicsSummary(tx, since)` — three `tx.execute(sql…)` aggregate queries (purchases sold/revenue/refunded with `FILTER` by status; contact_reveals consumed/count/charged; provider_calls `sum(cost_micros)`), all `coalesce(...,0)::bigint`. `Number(...)` coercion at the boundary.
- `listPurchases(tx, tenantId)` — one tenant's purchases, newest first, `LIMIT 100`, no Stripe ids projected. **Used by the Tenants detail, not this tab.**

**Related mutation** (not on this tab): `POST /api/v1/admin/tenants/:id/purchases/:purchaseId/refund` in `routes.ts` (line ~501) — `requireCapability("tenants:credits")`, audited `credit.adjust`, calls `platformAdminWriteRepository.refundPurchase` (clamps the reversal to available balance; `FOR UPDATE` on the purchase row and the tenant row). 404 on unknown, 422 on already-refunded.

**Data model:** `purchases` (status `completed|refunded`, `stripe_event_id` unique → idempotent grants), `contact_reveals` (event log; `credits_consumed`), `provider_calls` (`cost_micros`), and the bare counter `tenants.reveal_credit_balance` (CHECK ≥ 0). No `credit_ledger` table exists.

**Verdict:** correct, isolated, but read-only and shallow. The economics view reports *what happened* (07 §9 "Internal"); it does not let finance *act*, *drill down*, or *reconcile*.

## 3. Enterprise Benchmark Research

Revenue-ops consoles in mature billing platforms go far beyond a static aggregate tile board:

- **Stripe Billing** ships a configurable analytics overview with real-time **MRR, churn rate, and active subscribers**, drill-down by dimension, and downloadable **MRR + subscriber roll-forward** reports; admins reconfigure how MRR/churn are computed (e.g. include/exclude discounts) and changes propagate in 24–48h. ([docs.stripe.com/billing/subscriptions/analytics](https://docs.stripe.com/billing/subscriptions/analytics))
- **Stripe Smart Retries** uses ML trained across the Stripe network to pick the optimal retry time for a failed payment and, per Stripe, recovers on average **57% of originally-failed recurring payments**; Stripe also ships prebuilt **dunning** email flows (card-expiry, failed-payment, renewal reminders) with one-click payment-update links. ([docs.stripe.com/billing/revenue-recovery/smart-retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries))
- **Recurly Intelligent Dunning** distinguishes **soft declines (retry immediately) vs hard declines (require customer action)** by decline code and card issuer, routing each path differently — a capability TruePoint has no surface for. ([chargebee.com/recurring-payments/dunning-management](https://www.chargebee.com/recurring-payments/dunning-management/))
- **Maxio** is built around **ASC 606 / IFRS 15 revenue recognition** and SaaS finance metrics — the GAAP rev-rec layer TruePoint's counter model cannot produce, and which the M11 `credit_ledger` (ADR-0029) is the prerequisite for. ([withorb.com/blog/maxio-review](https://www.withorb.com/blog/maxio-review))

The takeaway: the table stakes for a billing/revenue-ops admin surface are **drill-down + per-tenant attribution, recurring-revenue (MRR/ARR/churn) metrics, dunning/failed-payment recovery, reconciliation status, and exportable reports**. TruePoint currently has none of these on this tab.

## 4. Gap Analysis

| # | Gap | Today | Enterprise bar | Blocker |
|---|---|---|---|---|
| G1 | No drill-down / per-tenant economics | Cross-tenant aggregates only | "Which tenants drove the margin?" cohort + tenant list | None — additive read |
| G2 | No refund/adjust surfaced on this tab | Refund only on Tenants detail | Finance acts where they look | None — wire existing mutation |
| G3 | No reconciliation status | `billing-recon` not built | `balance == SUM(delta)` per-tenant assertion | **M11 ledger** (ADR-0029) |
| G4 | No MRR/ARR/churn/cohort | Counter + one-off packs | Recurring-revenue metrics | Subscription model + ledger |
| G5 | No failed-payment / dunning view | None | Smart Retries / soft-vs-hard decline | **Stripe API** + worker |
| G6 | No CSV/financial export | None | Downloadable roll-forward report | None — additive |
| G7 | No `Idempotency-Key` on credit/refund path | Best-effort `FOR UPDATE` | Replay-safe money mutations | None — table exists (`idempotency_keys`) |
| G8 | Counter, not ledger | Bare counter, audit-log archaeology | Append-only ledger, dispute trail | **M11** (ADR-0029) |
| G9 | No capability render-gate on refund UI | N/A (no UI) | Hide actions caller can't perform | None |

## 5. Functional Improvements

### 5.1 Per-tenant economics drill-down
- **Current state:** the economics endpoint returns one cross-tenant aggregate; there is no way to see which tenants drove revenue, spend, or margin.
- **Problem:** finance cannot investigate a margin swing or a spend spike — the single number is unactionable.
- **Enterprise best practice:** Stripe/Chargebee dashboards let you group and drill into metrics by customer.
- **Recommended implementation:** add `GET /api/v1/admin/billing/economics/by-tenant?sinceDays=N&cursor=` — keyset-paginated, `PLATFORM_READ_LIMIT=500`, ordered by margin/revenue desc, returning `tenantId`, name, `revenueCents`, `providerSpendCents`, `marginCents`, `chargedReveals`. New repo method `economicsByTenant(tx, since, cursor)`; audited read `admin.list_tenant_economics`. New feature sub-view with a `TpTable`, StateSwitch, keyset "load more".
- **Expected impact:** turns the tile board into an investigable surface; unblocks G1.
- **Dependencies:** none (additive read on existing tables).
- **Priority:** High.

### 5.2 Surface refund/adjust on the Billing tab
- **Current state:** `refundPurchase` exists but only on the Tenants detail.
- **Problem:** revenue-ops works in the Billing tab; context-switching to a tenant page to refund is friction and hides the action from the people who own it.
- **Enterprise best practice:** refunds/credits are first-class from the billing console.
- **Recommended implementation:** in the per-tenant drill-down (5.1), surface a "Refund purchase" action that calls the existing `POST /tenants/:id/purchases/:purchaseId/refund` behind a `useStaffMe().canMaybe("tenants:credits")` render-gate; confirm dialog with mandatory reason. No new endpoint.
- **Expected impact:** finance acts where it looks; reuses an audited path.
- **Dependencies:** 5.1 (drill-down), existing `tenants:credits` capability.
- **Priority:** Medium.

### 5.3 CSV / financial export
- **Current state:** no export.
- **Problem:** finance reconciles in spreadsheets; no way to pull the numbers out.
- **Enterprise best practice:** Stripe ships downloadable MRR/subscriber roll-forward reports.
- **Recommended implementation:** `GET /api/v1/admin/billing/economics/export?sinceDays=N` streaming CSV (per-tenant rows from 5.1), audited `admin.billing_export` (or reuse `audit.export` semantics); bounded by `PLATFORM_READ_LIMIT`. UI: "Export CSV" button, `billing:read`-gated.
- **Expected impact:** closes G6; supports SOC 2 / finance audits.
- **Dependencies:** 5.1.
- **Priority:** Medium.

## 6. Backend Improvements

### 6.1 `Idempotency-Key` on the refund/credit mutation path
- **Current state:** `refundPurchase` relies on `FOR UPDATE` + the `refunded` status guard; the credit endpoints accept no idempotency key. The `idempotency_keys` table and stored-response replay (07 §3) exist but are not applied here.
- **Problem:** a retried POST (network blip, double-click) can attempt a second refund; the status guard catches the double-refund but not all credit mutations, and there is no replayed-response guarantee for the caller.
- **Enterprise best practice:** every money mutation is idempotent on a client-supplied key (Stripe's model).
- **Recommended implementation:** accept `Idempotency-Key` header on `POST …/refund` (and any future `credit.adjust`); inside `withPlatformTx`, look up `(tenantId,key)` in `idempotency_keys`, replay the stored response on hit, else execute and store. This is the established money-endpoint recipe (07 §3, schema/billing.ts `idempotencyKeys`).
- **Expected impact:** replay-safe credit mutations; closes G7.
- **Dependencies:** `idempotency_keys` table (exists); needs a small platform-side helper (the table is tenant-scoped RLS — platform writes go via the owner connection).
- **Priority:** High.

### 6.2 `billing-recon` reconciliation worker
- **Current state:** not built. 07 §8 specifies it; it has no home in `apps/workers`.
- **Problem:** no automated assertion that balances and Stripe settlements agree; drift is invisible until a dispute.
- **Enterprise best practice:** scheduled reconciliation that asserts the invariant and alerts on drift.
- **Recommended implementation:** BullMQ scheduled job asserting per tenant: `reveal_credit_balance >= 0` (also a DB CHECK), `Stripe settled == purchases rows` (unique `stripe_event_id`), and the spend sanity check. **Caveat (07 §8):** with a counter there is *no* `balance == SUM(delta)` invariant — drift must be reconstructed from `credit.adjust` audit rows. The full invariant assertion lands with the **M11 ledger** (6.3). Emit a structured metric + alert on mismatch; surface a "Reconciliation: OK / drift" badge on this tab.
- **Expected impact:** closes G3 (partially pre-ledger, fully post-M11).
- **Dependencies:** `apps/workers` queue; full version needs 6.3.
- **Priority:** High (counter version) → Critical (ledger version).

### 6.3 Append-only `credit_ledger` (M11, ADR-0029)
- **Current state:** bare counter; "no native refund/adjustment history beyond the audit trail" (07 §7).
- **Problem:** disputes/refunds reconstruct history from audit-log archaeology; no provable accounting for finance/SOC 2 auditors; the single-row `FOR UPDATE` serializes reveals tenant-wide.
- **Enterprise best practice:** Maxio/ASC-606-grade replayable ledger; `balance == SUM(delta)`.
- **Recommended implementation:** per ADR-0029 — `credit_ledger` (one row per grant/spend/credit-back/adjustment: `entry_type`, signed `delta`, idempotency key, actor, reason, refs to `purchases`/`contact_reveals`); `reveal_credit_balance` becomes a derived cache maintained in-tx; recon worker asserts the invariant directly. **This is M11 infrastructure — document as a spec, do not claim it exists.** Mark needs sequencing sign-off.
- **Expected impact:** provable accounting, dispute trail, reconciliation invariant; unblocks MRR/churn rev-rec.
- **Dependencies:** M11 milestone; careful migration backfilling the ledger from `purchases` + `contact_reveals` + `credit.adjust` audit rows.
- **Priority:** Critical (but milestone-gated).

## 7. Database Improvements

### 7.1 `credit_ledger` table (the M11 model)
- **Current state:** no ledger; `purchases` + counter only.
- **Problem:** as 6.3.
- **Enterprise best practice:** append-only signed-delta ledger.
- **Recommended implementation:** new tenant-scoped table in `schema/billing.ts` (tenant data, not a platform table): `id`, `tenant_id`, `entry_type` (`grant|spend|credit_back|adjustment|lease|settle|release`), `delta integer`, `idempotency_key`, `actor_user_id`, `reason`, `purchase_id`/`reveal_id` refs, `created_at`; CHECK on `entry_type`; index `(tenant_id, created_at desc)`. `bun generate`; RLS in `rls/billing.sql`; UPDATE/DELETE blocked by trigger (append-only, like `audit_log`). **M11 — spec only.**
- **Expected impact:** the backing store for provable accounting and reconciliation.
- **Dependencies:** ADR-0029, M11.
- **Priority:** Critical (milestone-gated).

### 7.2 Index for per-tenant economics drill-down
- **Current state:** economics scans `provider_calls`/`contact_reveals`/`purchases` by time column only.
- **Problem:** a per-tenant GROUP BY over the window will seq-scan + sort at scale.
- **Enterprise best practice:** composite indexes matching the read predicate.
- **Recommended implementation:** add composite `(tenant_id, called_at)` on `provider_calls`, `(tenant_id, revealed_at)` on `contact_reveals` (the latter complements the existing `(workspace_id, revealed_at desc)`), and confirm `(tenant_id, created_at)` on `purchases`, so 5.1's grouped scan is index-backed.
- **Expected impact:** keeps drill-down within budget at 10x.
- **Dependencies:** 5.1.
- **Priority:** Medium.

## 8. API Improvements

### 8.1 Drill-down + export endpoints (keyset, bounded)
- **Current state:** one endpoint, aggregate-only.
- **Problem:** no per-tenant attribution or export.
- **Enterprise best practice:** paginated, exportable revenue analytics.
- **Recommended implementation:** add `GET /economics/by-tenant` (keyset `cursor`, base64url, `limit+1` probe, `PLATFORM_READ_LIMIT=500`) and `GET /economics/export` (CSV), both `billing:read`, both audited (`admin.list_tenant_economics`, `admin.billing_export`) inside `withPlatformTx`. Add the read action strings to the `admin.list_*` convention (recorded reads, not enum mutations).
- **Expected impact:** the API surface for §5.
- **Dependencies:** 7.2 indexes.
- **Priority:** High.

### 8.2 Refund/credit-adjust contract hardening
- **Current state:** `POST …/refund` returns `{ purchaseId, reversed, balanceAfter }`; `RefundResult` schema exists in `billingAdmin.ts` but the route hand-builds the object.
- **Problem:** drift risk between the route response and the shared `refundResultSchema`; no `Idempotency-Key`.
- **Enterprise best practice:** the API validates its own response against the shared contract; money mutations are idempotent.
- **Recommended implementation:** parse the route output through `refundResultSchema` before `c.json`; accept `Idempotency-Key` (6.1). When the ledger lands, add a generic `POST /api/v1/admin/tenants/:id/credit-adjust` ( `credit.adjust` audited, `tenants:credits`, JIT-elevation-consuming) writing a ledger row.
- **Expected impact:** contract-safe, replay-safe credit mutations.
- **Dependencies:** 6.1; ledger version needs 7.1.
- **Priority:** High.

## 9. Dependency Mapping

- **DB tables:** `purchases`, `contact_reveals`, `provider_calls`, `tenants.reveal_credit_balance` (counter), `stripe_customers`, `idempotency_keys`, `audit_log` (tenant), `platform_audit_log` (raw, bootstrapAdmin.ts). **Deferred:** `credit_ledger` (M11).
- **Services / repositories:** `platformBillingReadRepository` (`economicsSummary`, `listPurchases`), `platformAdminWriteRepository.refundPurchase`, `withPlatformTx` (`packages/db/src/client.ts`).
- **API endpoints:** `GET /api/v1/admin/billing/economics`; (related) `GET /api/v1/admin/tenants/:id/purchases`, `POST /api/v1/admin/tenants/:id/purchases/:purchaseId/refund`. **Proposed:** `/economics/by-tenant`, `/economics/export`, `/tenants/:id/credit-adjust`.
- **Event flow:** UI `useEconomics` → `fetchEconomics` (`fetchWithAuth`) → Hono `billingRoutes` → `requireCapability("billing:read")` → `withPlatformTx("admin.billing_economics")` → three aggregate scans → derived `EconomicsSummary` → `StatTile`s.
- **Background workers:** none today. **Proposed:** `billing-recon` (apps/workers, scheduled); dunning/retry worker (Stripe-dependent, deferred).
- **Queue dependencies:** none today; recon + dunning need BullMQ/Redis.
- **Permission / capability dependencies:** `billing:read` (super_admin, billing_ops) for reads; `tenants:credits` for refund/adjust; JIT elevation consumed by `credit.adjust` (sensitive action) or 403 `elevation_required`.
- **Feature-flag dependencies:** none today. **Proposed:** gate the ledger-backed view and dunning surface behind admin feature flags during rollout (security phase).
- **External integrations:** Stripe (webhook is the source of truth for `purchases`; dunning/Smart-Retries needs the Stripe API — deferred).
- **Cross-module dependencies:** Tenants tab (shares `refundPurchase`, per-tenant purchases), Provider Configs (`cost_micros` rollup, `/10_000` cents convention), Audit Log (every mutation → `platform_audit_log`), Pricing (credit-pack catalog feeds revenue).

## 10. Security Review

- **Isolation:** the economics read runs on the BYPASSRLS owner connection inside `withPlatformTx` and returns **aggregates only** — never per-tenant PII or row dumps. The per-tenant drill-down (5.1) must keep this discipline: project only economics columns (revenue/spend/margin/counts + tenant name), never contact PII, and bound by `PLATFORM_READ_LIMIT=500` keyset.
- **AuthZ:** reads gated by `requireCapability("billing:read")`; capability is re-checked per request (no JWT staleness on revoke). The refund mutation is correctly a *different, stronger* capability (`tenants:credits`) — surfacing it on this tab (5.2) must keep that gate; the UI render-gate (`canMaybe`) is defence-in-depth only, the API is the boundary.
- **Elevation:** `credit.adjust` is a sensitive action — any new credit-adjust endpoint (8.2) **must** consume a JIT elevation in-tx (`jit_elevations`, FOR UPDATE SKIP LOCKED) or 403 `elevation_required`. Peer-approval (`approved_by_user_id`) is **not enforced** (self-service v1) — note as a gap requiring security sign-off before enterprise GA.
- **Audit:** every mutation already flows through `withPlatformTx` → `platform_audit_log`. New audited actions (`admin.billing_export`, a ledger-backed `credit.adjust`) must clear the `platformAuditCoverage.test.ts` PENDING→WRITTEN drift guard.
- **Idempotency:** the missing `Idempotency-Key` (6.1) is a security-adjacent correctness gap on a money path — a replay could double-act. Treat as High.

## 11. Performance Review

- **Today:** three single-pass aggregate scans per economics load; time columns are indexed (`revealed_at`, etc.). The 12-month window over `contact_reveals`/`provider_calls` is the heaviest read — acceptable at current volume but the unbounded `sinceDays=365` scan is the one to watch as those high-volume event logs grow.
- **At 10x:** the aggregate FILTER scans on `purchases` are cheap; `contact_reveals` and `provider_calls` are the cost. The drill-down (5.1) adds a per-tenant GROUP BY — without the 7.2 indexes this becomes seq-scan + sort. Recommend the composite `(tenant_id, time)` indexes before shipping drill-down.
- **Caching:** economics is a cross-tenant aggregate that changes slowly — a short (60–120s) server-side cache keyed by `sinceDays` would cut repeated heavy-window scans; invalidate aggressively or simply TTL (finance tolerates minute-level staleness). Low priority until load warrants.
- **Partitioning:** 03 §12 already targets monthly range-partitioning for `contact_reveals`/`audit_log` — when that lands, the windowed economics scans become partition-pruned, materially cheaper for short windows.

## 12. UX/UI Improvements

### 12.1 Capability render-gates + four-state polish
- **Current state:** the tab renders for anyone who reaches it; no action gating (no actions exist). `StateSwitch` covers loading/error/data but the empty state (zero activity in window) renders six "$0.00" tiles with no framing.
- **Problem:** when actions arrive (5.2), they must be hidden from callers who lack the capability; and a genuinely empty window reads as "broken" rather than "no activity".
- **Enterprise best practice:** gate actions by capability; distinguish empty from zero.
- **Recommended implementation:** wrap any future action in `useStaffMe().canMaybe("tenants:credits")`; add an explicit empty-state copy ("No billing activity in the last N days") when all aggregates are zero.
- **Expected impact:** safe, legible UI as the tab grows.
- **Dependencies:** 5.2 for the action gate.
- **Priority:** Medium.

### 12.2 Trend / drill affordance on tiles
- **Current state:** static tiles, no trend, no click-through.
- **Problem:** a number with no period-over-period context or drill path is low-signal for finance.
- **Enterprise best practice:** Stripe tiles show deltas and drill into the contributing rows.
- **Recommended implementation:** add a period-over-period delta sublabel (compare window to the preceding window — one extra aggregate call), and make Revenue/Margin/Provider-spend tiles click through to the 5.1 per-tenant breakdown.
- **Expected impact:** the tile board becomes a navigable analytics surface.
- **Dependencies:** 5.1.
- **Priority:** Medium.

## 13. Automation Opportunities

- **Reconciliation (6.2):** scheduled `billing-recon` asserting balance/Stripe/spend invariants and surfacing a status badge — replaces manual dispute archaeology.
- **Dunning / Smart Retries (deferred):** Stripe-API-backed failed-payment recovery (soft vs hard decline routing, ML-timed retries) — needs the Stripe API + a worker; document as a spec, do not claim it exists.
- **Drift alerts:** the recon worker should emit a structured alert (not just a badge) on any balance/Stripe mismatch, wired to the ops alerting path.
- **Scheduled finance export:** a cron that drops the per-tenant CSV (5.3) to a finance bucket on a monthly close cadence.

## 14. Monitoring & Logging

- **Audit:** the economics read is recorded as `admin.billing_economics` via `withPlatformTx` (the read-as-action convention); the refund is `credit.adjust`. New reads/exports must add their `admin.*` action strings and clear `platformAuditCoverage.test.ts`.
- **Metrics to emit:** economics query latency (split by window), per-window scan row counts, and — once recon lands — `recon.drift` count per tenant and `recon.ok` gauge.
- **Alerting:** any reconciliation drift, any Stripe-settled-vs-`purchases` mismatch, and refund-rate anomalies (sudden spike in `credit.adjust`/refund volume) should page ops.
- **Gaps:** no current dashboard for economics-query performance; no alert on a stale/failing economics endpoint (finance silently sees stale numbers). Add a synthetic probe (systemHealthProbes pattern) hitting `/economics?sinceDays=7`.

## 15. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Counter has no `balance == SUM(delta)` invariant; drift unprovable | High | M11 `credit_ledger` (6.3); interim recon from `credit.adjust` audit rows |
| Refund clamps to available balance — already-spent credits unrecoverable | Medium | Documented (ADR-0029); ledger reconciliation closes it |
| Missing `Idempotency-Key` on money mutation → replay double-act | High | 6.1 (table already exists) |
| Per-tenant drill-down could leak PII if projection is sloppy | High | Aggregate-only projection, code review, isolation test |
| `sinceDays=365` scan over high-volume event logs degrades at scale | Medium | 7.2 indexes + partitioning (03 §12) |
| Peer-approval not enforced on `credit.adjust` (self-service v1) | Medium | Security sign-off; enforce `approved_by_user_id` pre-GA |
| No dunning/failed-payment recovery → silent revenue loss | Medium | Deferred Stripe-backed worker (needs infra) |

## 16. Technical Debt

- **Counter, not ledger** — the single largest debt; explicitly accepted (ADR-0007) with a documented upgrade path (ADR-0029/M11). Every refund/dispute pays interest as audit-log archaeology.
- **`refundResultSchema` unused by the route** — the route hand-builds its response instead of validating against the shared contract (8.2).
- **`billing-recon` worker specified (07 §8) but not built** — the reconciliation guarantee is on paper only.
- **No `Idempotency-Key` despite the `idempotency_keys` table existing** — the replay-safety machinery is present but unused on the platform credit path.
- **Cents/micros convention duplicated** — the `/10_000` micros→cents conversion lives in both `billing.ts` and the provider-config rollup; should be one shared helper.
- **DELIBERATELY DEFERRED (need infra / security sign-off — specs, not features):** M11 `credit_ledger`, batch-reservation lease (ADR-0029), Stripe-backed dunning/Smart-Retries, MRR/ARR rev-rec, peer-approval enforcement.

## 17. Multi-Phase Implementation Plan

### Phase 1 — UX/correctness quick wins (Critical/High)
- **Objectives:** make the tab safe-by-default and replay-safe; no new infra.
- **Scope:** `Idempotency-Key` on `refund` (6.1, 8.2), validate refund response through `refundResultSchema`, capability render-gate scaffolding (12.1), explicit empty state, synthetic health probe (14).
- **Deliverables:** idempotent refund endpoint; contract-validated response; render-gated UI scaffold; empty-state copy; `/economics` probe.
- **Technical tasks:** wire `idempotency_keys` lookup/store in `withPlatformTx` for the refund; parse output through `refundResultSchema`; add `canMaybe` gate; add probe to systemHealthProbes.
- **Risks:** platform-side write to a tenant-RLS table (`idempotency_keys`) — must go via owner connection.
- **Dependencies:** none (tables exist).
- **Testing:** replay test (same key → one effect, stored response replayed); already-refunded 422; capability-gate isolation test.
- **Estimated complexity:** Low.
- **Success criteria:** a retried refund is a no-op returning the stored response; refund response matches the shared schema; probe green.

### Phase 2 — Drill-down, attribution & export (High)
- **Objectives:** turn the tile board into an investigable, exportable revenue console.
- **Scope:** per-tenant economics (5.1), refund surfaced on the tab (5.2), CSV export (5.3), supporting indexes (7.2), tile deltas + click-through (12.2), API endpoints (8.1).
- **Deliverables:** `/economics/by-tenant`, `/economics/export`, the drill-down sub-view, period-over-period deltas.
- **Technical tasks:** `economicsByTenant` repo method (keyset, bounded); composite indexes via `bun generate`; CSV stream; new audited read actions + `platformAuditCoverage` PENDING→WRITTEN; `TpTable` sub-view.
- **Risks:** PII leakage in projection; unindexed GROUP BY at scale.
- **Dependencies:** Phase 1 (idempotent mutation), 7.2 indexes.
- **Testing:** isolation test (aggregate-only, no PII); keyset pagination test; capability gate on export and refund-action; performance test on a 12-month window.
- **Estimated complexity:** Medium.
- **Success criteria:** finance can rank tenants by margin, refund from the tab, and export the window; reads stay aggregate-only and bounded.

### Phase 3 — Ledger, reconciliation & rev-rec depth (Critical, M11-gated)
- **Objectives:** provable accounting, automated reconciliation, recurring-revenue metrics.
- **Scope:** `credit_ledger` table + migration backfill (7.1, 6.3), `billing-recon` worker asserting `balance == SUM(delta)` (6.2 full version), ledger-backed `credit.adjust` endpoint (8.2), reconciliation status badge.
- **Deliverables:** the ledger, the recon worker, a credit-adjust mutation, drift alerts.
- **Technical tasks:** schema/billing.ts ledger + `bun generate` + `rls/billing.sql` + append-only trigger; backfill from `purchases`/`contact_reveals`/`credit.adjust`; BullMQ scheduled recon; counter→derived-cache cutover (ADR-0029).
- **Risks:** migration backfill correctness; cutover correctness under concurrency; this is M11 — needs sequencing/security sign-off.
- **Dependencies:** M11 milestone, ADR-0029.
- **Testing:** invariant property test (`balance == SUM(delta)`); backfill reconciliation test; concurrent-reveal no-double-spend; recon drift detection test.
- **Estimated complexity:** High.
- **Success criteria:** the recon worker proves the invariant per tenant; disputes read the ledger, not the audit log.

### Phase 4 — Stripe revenue recovery & flag-gated rollout (Medium, deferred-infra)
- **Objectives:** failed-payment recovery and MRR/churn, behind feature flags.
- **Scope:** Stripe-backed dunning/Smart-Retries worker (soft-vs-hard decline routing), MRR/ARR/churn view (subscription model + ledger), feature-flag gating, enforce peer-approval on `credit.adjust`.
- **Deliverables:** dunning worker spec→build, recurring-revenue dashboard, peer-approval enforcement.
- **Technical tasks:** Stripe API integration; subscription/rev-rec model; flag gates on the new surfaces; enforce `approved_by_user_id`.
- **Risks:** external Stripe dependency; requires human security decision on peer-approval; rev-rec correctness (ASC 606).
- **Dependencies:** Phase 3 (ledger), Stripe API access, security sign-off.
- **Testing:** Stripe CLI webhook replay; decline-routing test; flag on/off behaviour; peer-approval enforcement test.
- **Estimated complexity:** High.
- **Success criteria:** failed payments recover automatically; finance sees MRR/churn; sensitive credit moves require a second approver.

## 18. Final Recommendations

- **Do first (Phase 1, High):** make the credit/refund path idempotent (6.1) and validate its response against `refundResultSchema` (8.2) — cheap, the tables already exist, and it closes a real money-path replay risk. **Priority: High.**
- **Do next (Phase 2, High):** ship per-tenant drill-down + export with the supporting indexes (5.1, 5.3, 7.2, 8.1) and surface the existing refund on the tab behind its capability gate (5.2). This is the single biggest jump in usefulness and needs no new infra. **Priority: High.**
- **Plan and sequence (Phase 3, Critical, M11):** the `credit_ledger` (ADR-0029) is the foundation everything finance-grade depends on — reconciliation, dispute trail, rev-rec. It is milestone-gated; treat it as the program's billing keystone and do not let downstream features (MRR, dunning) start before it. **Priority: Critical (gated).**
- **Defer with eyes open (Phase 4, Medium):** Stripe dunning/Smart-Retries and MRR/churn are real gaps versus Stripe/Recurly/Maxio, but they need the ledger, Stripe API, and (for peer-approval) a human security decision. Keep them as implementation-ready specs, flag-gated. **Priority: Medium.**
- **Non-negotiables throughout:** aggregate-only cross-tenant reads (no PII), every mutation through `withPlatformTx` clearing the `platformAuditCoverage` drift guard, `credit.adjust` consuming a JIT elevation, and the API as the authoritative boundary (UI gates are defence-in-depth).
