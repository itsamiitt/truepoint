---
title: "Plans, Pricing & Credits — Program Spine (Master Index)"
scope: plans-pricing-credits
docs: 8
last_updated: 2026-06-30
owner: product + platform + billing
status: Plan (not yet built)
---

# TruePoint — Plans, Pricing, Credits, Subscriptions & Billing

> Brand is **TruePoint** (everything a user sees); the npm scope is **`@leadwolf/*`** (the code).
> Both are correct **by design** — this package **never reconciles them**. Do not "fix" a
> `@leadwolf/*` import to read `truepoint`, nor rename the product to `leadwolf` in any surface.
> See `CLAUDE.md` (project guide) for the canonical statement of this rule.

This is the spine/index for the **plans-pricing-credits planning package**: the consolidated,
file-grounded design for everything commercial in TruePoint — **plans, pricing, credits,
subscriptions, and billing** — across the **internal admin console** (`apps/admin`) and the
**customer app** (`apps/web`). It mirrors the two structural precedents in this repo:
`docs/planning/audits/platform-admin/00-README.md` (the multi-doc audit spine) and
`docs/planning/list-plan/00-overview.md` (the locked-decisions + vocabulary spine).

This document is the **canonical source** for: scope, the never-reconcile note, the locked
decisions, the open-decisions register, the shared vocabulary, the document index, the program
roadmap outline, the cross-cutting dependency-matrix skeleton, and the anti-duplication map.
Every numbered doc (`01`–`07`) **cites this file** and must not contradict it.

---

## 1. Scope & non-goals

### 1.1 In scope

| Area | What this package covers | Portals |
|---|---|---|
| **Plans** | `plan_templates` catalog (seat/workspace limits, `monthly_credit_grant`, `features` jsonb), plan assignment/override, plan-change impact, grandfathering, the tier ladder | admin + web |
| **Pricing** | `credit_packs` catalog (price/credits/active/sort), price-change scheduling & simulation, multi-currency (spec), public pricing page | admin + web |
| **Credits** | The reveal-credit economy — counter today, append-only **ledger** target (M11), grant/spend/refund/credit-back, rollover/expiry policy, balance & usage surfaces | admin + web |
| **Subscriptions** | Recurring vs packs-only model, renewal/auto-renew policy, trials, proration — **documented as a proposed amendment**, see OD-1 | admin + web |
| **Billing** | Stripe top-ups, the webhook grant path, purchases/refunds, invoices/receipts (spec), dunning (spec), economics/revenue-ops reporting | admin + web |
| **Allocation** | Hierarchical org → team/workspace → per-user credit allocation (the enterprise target), built on M12 leases — see OD-2 | admin + web |

### 1.2 Out of scope (link, do not re-spec)

| Out of scope | Lives in |
|---|---|
| **Bulk-enrichment billing, forecast & quota internals** (per-job reservation math, enrichment metering) | `docs/planning/decisions/ADR-0038-bulk-enrichment-billing-forecast-and-quota.md`; `docs/planning/07-billing-credits.md §5` |
| **Outreach / email send-quota mechanics** (the M12 send-gate, `sendQuotaRepository` wiring) | the email-planning set; `MEMORY.md` (email M12) — this package only *references* quota as an entitlement type |
| **CRM-sync billing**, downstream connector metering | the CRM/integrations track |
| **The reveal transaction SQL, the counter model, the bulk-lease mechanics** (mechanism, not policy) | `docs/planning/07-billing-credits.md §3/§4/§5/§8/§11` — **linked, never restated** here |
| **Platform-admin RBAC / JIT / audit substrate internals** | `docs/planning/audits/platform-admin/15-foundations-and-security.md`; ADR-0011 |

This package owns the **commercial policy, surfaces, and target-state architecture**; it builds
**on top of** the mechanisms above, never around them.

---

## 2. The never-reconcile note (TruePoint vs `@leadwolf/*`)

The **product brand is TruePoint** — the name on every screen, every domain (`app.` / `auth.` /
`api.truepoint.in`), every piece of customer-facing copy and admin chrome. The **code identity is
`leadwolf`** — the npm root and every workspace package (`@leadwolf/auth`, `@leadwolf/db`,
`@leadwolf/core`, …). This divergence is **intentional and permanent**. In every doc in this
package: write **TruePoint** in prose and UI copy; write **`@leadwolf/*`** when naming a package,
import, or repo path. **Never** edit one to match the other, and **never** flag the mismatch as a
bug.

---

## 3. Locked decisions (owner-approved — canonical, cite verbatim)

> Confirmed with the owner. These are **not open for re-litigation** inside `01`–`07`. The
> remaining open items are tracked in the register at §4.

- **LD-1 (from OD-1) — Subscriptions: document both, recommend the hybrid, defer the pick.**
  Every doc that touches the billing model **documents both** the recurring-subscription model
  **and** the ADR-0012 no-lock-in model, and presents a clear recommendation: a **hybrid** where
  **month-to-month / no-auto-renewal stays the DEFAULT**, with **opt-in annual/subscription for
  enterprise that is never defaulted-on**. The final pick is **deferred to implementation
  approval**. Any auto-renewal, credit-expiry, or annual-lock design is framed as a **PROPOSED
  AMENDMENT via a future `ADR-0041`** — never asserted as decided fact, and never silently
  contradicting `ADR-0012`. (Next free ADR number is **0041**; `ADR-0040` is the last in use.)

- **LD-2 (from OD-2) — Credit allocation: design the full hierarchical model as the enterprise
  target.** The **tenant credit pool stays authoritative** (the `tenants.reveal_credit_balance`
  counter today; the M11 ledger tomorrow). On top of it we design **per-team/per-workspace
  budgets** and **per-user soft limits**, phased across the roadmap, aligned with **ADR-0029
  (M12 per-workspace/team leases)** and proposed as **`ADR-0042`**. This is the documented
  enterprise target — not a claim that hierarchy exists today.

---

## 4. Open-decisions register

Each open decision has a **recommended default** (so the docs can build coherently) with the
**final pick deferred** to implementation approval. `01`–`07` apply the recommended default and
flag where the alternative would change the design.

| ID | Decision | Options | Recommended default (deferred) | Gating tag |
|---|---|---|---|---|
| **OD-1** | Subscriptions vs packs-only | (a) packs-only; (b) subscriptions-only; (c) hybrid | **Hybrid:** month-to-month / no-auto-renew is the DEFAULT; opt-in annual/subscription for enterprise, never defaulted-on. Amendment via proposed `ADR-0041`. *(LD-1)* | `[decision-gated]` `[Stripe]` |
| **OD-2** | Flat tenant pool vs hierarchical allocation | (a) flat pool; (b) org→team/workspace→user | **Hierarchical** org→team→user; tenant pool authoritative, per-team budgets + per-user soft limits, phased. Proposed `ADR-0042`. *(LD-2)* | `[M12-lease]` `[decision-gated]` |
| **OD-3** | Consolidate vs separate commercial surfaces per portal | (a) one mega-page; (b) per-concern tabs | **Admin: keep separated** (Billing / Plans / Pricing / Tenant detail tabs). **Web: one billing hub** (Plan / Credits / Usage / Invoices / Subscription) **+ a separate public pricing page**. | `[exists-partial]` |
| **OD-4** | Credit rollover & expiry | (a) never expire; (b) expire; (c) roll-over with cap | **No-expiry stays default.** If subscriptions land, monthly grants **roll over with a cap**, announced in advance, per `ADR-0012`. | `[decision-gated]` `[M11-ledger]` |
| **OD-5** | Real invoicing & multi-currency now vs spec-only | (a) build now; (b) spec-only | **Spec now; build behind Stripe + a feature flag.** **USD authoritative** until international GTM. | `[Stripe]` `[flag]` `[decision-gated]` |
| **OD-6** | M11 ledger timing | (a) ledger first; (b) defer; (c) split | **Ledger is the program keystone (Phase 3).** Pull only **job-scoped batch reservation** forward of it. | `[M11-ledger]` |
| **OD-7** | Trials | (a) signup-bonus credits; (b) time-boxed trial; (c) both | **Signup-bonus credits = the MVP trial.** Full time-boxed trials **deferred**. | `[decision-gated]` |
| **OD-8** | Permission-based billing / peer-approval | (a) open; (b) capability matrix; (c) +peer-approval | **Billing-permission matrix** (admin caps + JIT elevation; web **workspace-admin-only** purchase/allocate). **Peer-approval spec-ed, not enforced v1.** | `[capability]` `[decision-gated]` |

---

## 5. Shared vocabulary (canonical — cite, do not redefine)

| Term | Definition (in this package's sense) | Ground truth |
|---|---|---|
| **Credit** | The unit of spend for a reveal. Authoritative balance is the tenant **counter** today; the **ledger** is the M11 target. | `tenants.reveal_credit_balance`; `07-billing-credits.md §3` |
| **Reveal** | The chargeable event of unmasking a contact (`email`/`phone`/`full_profile`); per-workspace first-wins, idempotent, suppression-gated. | `billing.ts contact_reveals`; ADR-0007; `07 §4` |
| **Credit pack** | A purchasable top-up bundle (key/name/credits/price_cents/active/sort_order). | `platformOps.ts credit_packs` |
| **Plan template** | A reusable plan tier (key/name/seat_limit/workspace_limit/`monthly_credit_grant`/`features`/active/sort_order). | `platformOps.ts plan_templates` |
| **Entitlement** | A capability/limit a plan confers, denormalized onto the tenant (`features` jsonb, `seat_limit`, `workspace_limit`). | `tenants.features`, `…seat_limit`, `…workspace_limit` |
| **Quota** | A periodic, resettable allowance distinct from credits (e.g. email send quota). | `tenants.email_send_quota/used/period_start`; `sendQuotaRepository` |
| **Lease** | A scoped reservation of credits for a batch/job/team/workspace (M12). | ADR-0029 (M12 leases); `07 §5` |
| **Ledger** | An append-only, double-entry-style record of every credit movement (grant/spend/refund). **Target (M11), does not exist yet.** | ADR-0029; ADR-0007 (M11 upgrade path) |
| **Counter** | The single mutable `reveal_credit_balance` int that is the balance source-of-truth today (CHECK ≥ 0; hot-lock risk G-BIL-2). | `tenants.reveal_credit_balance`; `28 §G-BIL-2` |
| **Subscription** | A recurring commercial relationship (term, renewal, grant cadence). **Proposed amendment**, see OD-1 — not built. | proposed `ADR-0041` |
| **Seat** | A licensed user slot under a plan (`seat_limit`). | `tenants.seat_limit` |
| **Budget** | A per-team/per-workspace credit cap that subdivides the tenant pool (enterprise target). | OD-2 / proposed `ADR-0042` |
| **Allocation** | The act/structure of distributing the tenant pool down the org → team → user hierarchy. | OD-2; ADR-0029 (leases) |
| **Dunning** | The retry/notification flow when a recurring charge fails. **Spec-only**, gated on OD-1/OD-5. | proposed `ADR-0041`; `[Stripe]` |
| **Proration** | Mid-term adjustment of charges on plan change. **Spec-only**, gated on OD-1. | proposed `ADR-0041` |
| **MRR / ARR** | Monthly / Annual Recurring Revenue — the revenue-ops rollups for the admin economics surface. | `admin/billing.ts economics`; audit `03-billing.md` |

---

## 6. Document index (`00`–`07`)

| Doc | Purpose (one line) | Status |
|---|---|---|
| **`00-README.md`** (this) | Spine: scope, never-reconcile note, locked + open decisions, vocabulary, index, roadmap outline, dependency-matrix skeleton, anti-duplication map | **Authored** (spine complete; matrix/roadmap finalized in synthesis) |
| **`01_Industry_Research.md`** | Web/market research: how Apollo/ZoomInfo/Clearbit/Lusha and billing platforms (Stripe/Chargebee/Recurly/Maxio) model credits, packs, subscriptions, trials, dunning, proration | Planned |
| **`02_Industry_Best_Practices.md`** | Distilled best-practice patterns for credit ledgers, idempotent grants, rollover/expiry, hierarchical budgets, invoicing, multi-currency, peer-approval | Planned |
| **`03_Current_System_Observations.md`** | File-grounded as-built audit of the module across `apps/admin` + `apps/web` + `apps/api` + `packages/*`; reuses the three tab audits' gap IDs | Planned |
| **`04_Admin_Experience.md`** | Target-state design for the **internal** commercial surfaces (Billing/economics, Plans, Pricing, Tenant credit/plan/refund ops) — wireframes under `wireframes/admin/` | Planned |
| **`05_Web_Experience.md`** | Target-state design for the **customer** surfaces (billing hub, public pricing page, self-serve up/down/cancel, invoices, credit history, allocation UI) — wireframes under `wireframes/web/` | Planned |
| **`06_Architecture_And_Data.md`** | Target data model (ledger, subscriptions, invoices, budgets), APIs, workers, RLS, migrations (hand-authored — no `drizzle-kit generate`), diagrams under `diagrams/` | Planned |
| **`07_Implementation_Roadmap.md`** | **Synthesis doc.** Reconciles all above into the finalized **P0–P6 roadmap** + the completed **cross-cutting dependency matrix** + testing/rollback per phase | Planned (synthesis) |

> Every numbered doc carries the **required 12-section spine** (Executive Summary → Objectives →
> Research Findings → Industry Best Practices → Current System Observations → Recommendations →
> Diagrams → Tables → Dependencies → Risks → Future Enhancements → References).

---

## 7. Program-roadmap OUTLINE (P0–P6)

> **Outline only.** The phases below are **finalized in `07_Implementation_Roadmap.md`**, where
> the synthesis reconciles objectives, scope, deliverables, risks, dependencies, testing,
> complexity, and success-criteria per phase against every other doc. Ordering follows
> value-to-risk: cheap correctness first, then revenue depth, then the ledger keystone, then
> allocation, subscriptions, invoicing, and the enterprise-governance finish.

| Phase | Name | Theme | Key gating |
|---|---|---|---|
| **P0** | **Correctness & idempotency quick wins** | Idempotent credit/refund POSTs, balance/usage surface polish, four-state QA, audit attestation on any new action | `[exists]` `[capability]` |
| **P1** | **Revenue-ops & economics depth (admin)** | MRR/ARR/churn rollups, per-tenant economics drill-down, refund reason taxonomy, low-balance ops, monthly-grant UI | `[exists-partial]` `[Stripe]` |
| **P2** | **Self-serve web billing hub + public pricing** | Customer billing hub (Plan/Credits/Usage/Invoices/Subscription), public pricing page, credit-history pagination/filter/export | `[exists-partial]` `[Stripe]` `[flag]` |
| **P3** | **Credit-ledger keystone (M11)** | Append-only `credit_ledger`, job-scoped batch **reservation** pulled forward, reconciliation invariant (closes G-BIL-1) | `[M11-ledger]` |
| **P4** | **Hierarchical allocation (M12 leases)** | Per-team/workspace budgets + per-user soft limits on the ledger; allocation UI; proposed `ADR-0042` | `[M12-lease]` `[decision-gated]` |
| **P5** | **Subscriptions, trials, invoicing & multi-currency (behind flags)** | Opt-in recurring/annual, signup-bonus trial, real invoices/receipts, dunning, proration, USD-authoritative multi-currency spec; proposed `ADR-0041` | `[Stripe]` `[flag]` `[decision-gated]` |
| **P6** | **Enterprise governance, peer-approval & final QA** | Billing-permission matrix hardening, peer-approval enforcement on high-risk money paths, rollover/expiry policy rollout, console-wide QA | `[capability]` `[decision-gated]` |

---

## 8. Cross-cutting dependency-matrix SKELETON

> **Skeleton only — completed in synthesis (`07_Implementation_Roadmap.md`).** Rows are the
> module's tables / repos / endpoints / workers / capabilities / flags / Stripe touchpoints.
> Columns mark which numbered doc covers each. Cells: `●` primary owner, `○` secondary mention,
> `—` n/a. **Every row carries its gating tag** so deferred infra is never presented as built.
> The synthesis fills the `○`/`●` grid and adds an isolation/RLS column.

| Module element | Gating | `03` Obs | `04` Admin | `05` Web | `06` Arch | `07` Synth |
|---|---|---|---|---|---|---|
| `contact_reveals` (reveal log) | `[exists]` | ● | ○ | ○ | ○ | ● |
| `purchases` (Stripe top-ups) | `[exists]` `[Stripe]` | ● | ○ | ○ | ○ | ● |
| `stripe_customers` | `[exists]` `[Stripe]` | ● | — | ○ | ○ | ● |
| `suppression_list` (DNC) | `[exists]` | ● | — | — | ○ | ● |
| `idempotency_keys` | `[exists]` | ● | ○ | — | ○ | ● |
| `audit_log` (append-only) | `[exists]` | ● | ○ | — | ○ | ● |
| `tenants.reveal_credit_balance` (counter) | `[exists]` | ● | ○ | ○ | ● | ● |
| `tenants.{plan,seat_limit,workspace_limit,features}` | `[exists]` | ● | ● | ○ | ○ | ● |
| `tenants.email_send_quota/used/period_start` | `[exists]` | ○ | — | — | ○ | ● |
| `credit_packs` | `[exists]` | ● | ● | ○ | ○ | ● |
| `plan_templates` | `[exists]` | ● | ● | ○ | ○ | ● |
| `account_holds` | `[exists]` | ○ | ○ | — | ○ | ● |
| `credit_ledger` (append-only) | `[M11-ledger]` | ○ | ○ | ○ | ● | ● |
| `subscriptions` | `[decision-gated]` `[Stripe]` | — | ○ | ○ | ● | ● |
| `invoices` / `invoice_line_items` | `[Stripe]` `[flag]` | — | ○ | ● | ● | ● |
| `payment_methods` | `[Stripe]` | — | ○ | ● | ● | ● |
| `team/workspace budgets` | `[M12-lease]` `[decision-gated]` | — | ○ | ○ | ● | ● |
| `per-user soft limits` | `[M12-lease]` `[decision-gated]` | — | ○ | ○ | ● | ● |
| `creditRepository` (lock/decrement/grant) | `[exists]` | ● | ○ | — | ● | ● |
| `revealRepository` (claim/list) | `[exists]` | ● | — | ○ | ○ | ● |
| `creditPackRepository` / `planTemplateRepository` | `[exists]` | ● | ● | — | ○ | ● |
| `platformBillingReads` / `platformAdminWrites` | `[exists]` | ● | ● | — | ○ | ● |
| `sendQuotaRepository` (unwired) | `[exists]` | ○ | — | — | ● | ● |
| `POST /billing/webhook` (grant path) | `[exists]` `[Stripe]` | ● | — | — | ● | ● |
| `GET /credits/balance`, `/credits/usage` | `[exists]` | ● | — | ● | ○ | ● |
| `/admin/billing/*` economics + export | `[exists]` | ● | ● | — | ○ | ● |
| `/admin/pricing/*`, `/admin/plans` handlers | `[exists]` | ● | ● | — | ○ | ● |
| `POST /admin/tenants/:id/credits` (grant/adjust) | `[exists]` `[capability]` | ● | ● | — | ○ | ● |
| `POST /admin/tenants/:id/plan` (override) | `[exists]` `[capability]` | ● | ● | — | ○ | ● |
| `/admin/tenants/:id/purchases[/:pid/refund]` | `[exists]` `[capability]` | ● | ● | — | ○ | ● |
| `POST /credits/checkout` (web top-up) | `[exists]` `[Stripe]` | ○ | — | ● | ○ | ● |
| monthly-grant worker | `[M11-ledger]` `[decision-gated]` | — | ○ | — | ● | ● |
| renewal / dunning worker | `[Stripe]` `[decision-gated]` | — | ○ | — | ● | ● |
| reconciliation / lease-reaper / low-balance-notifier workers | `[M11-ledger]` `[M12-lease]` | — | ○ | — | ● | ● |
| `billing:read` / `pricing:manage` / `plans:manage` caps | `[capability]` | ● | ● | — | ○ | ● |
| web `workspace-admin` purchase/allocate gate | `[capability]` `[decision-gated]` | ○ | — | ● | ○ | ● |
| invoicing / multi-currency feature flag | `[flag]` `[Stripe]` | — | ○ | ● | ● | ● |
| Stripe (Checkout, webhooks, Billing, invoices) | `[Stripe]` | ● | ○ | ● | ● | ● |

**Gating legend.** `[exists]` shipped today · `[exists-partial]` partially built, gap remains ·
`[M11-ledger]` blocked on the append-only ledger keystone · `[M12-lease]` blocked on the
per-workspace/team lease layer · `[Stripe]` needs Stripe Billing/Checkout wiring · `[flag]`
behind a feature flag · `[capability]` gated by a staff/workspace capability · `[decision-gated]`
blocked on an open decision (§4). **Never present a non-`[exists]` row as built.**

---

## 9. Anti-duplication map (existing source → boundary)

Every existing doc/ADR below is **the** owner of its mechanism. This package **links** it and adds
only **target-state analysis** — it never restates the mechanism. Reuse the gap IDs, the `7.x`/`8.x`
table designs, and the competitor citations from the three tab audits verbatim.

| Existing source | What it owns (do NOT restate) | This package's boundary (what it MAY add) |
|---|---|---|
| `docs/planning/07-billing-credits.md §3/§4/§5/§8/§11` | The counter model, the reveal-transaction SQL, the bulk-lease mechanics, entitlements/quota, refunds, reconciliation, reporting | Link these sections; add only target-state (ledger, subscriptions, allocation, invoicing) analysis on top |
| `docs/planning/03-database-design.md` (§8 billing/compliance) | The shipped schema definitions | Cite as the as-built baseline; propose *additive* tables only, with hand-authored migrations |
| `docs/planning/28-enterprise-readiness-audit.md` | **G-BIL-1** (no-recon invariant), **G-BIL-2** (tenant-row hot-lock) | Cite the gap IDs; map them onto P3 (ledger) — do not re-derive |
| `docs/planning/audits/platform-admin/03-billing.md` | Billing tab audit: 18-section template, **gap IDs G1..Gn**, competitor citations, 4-phase plan | Reuse its gap IDs + tables + citations; extend into target state — never re-audit the tab |
| `docs/planning/audits/platform-admin/04-plans.md` | Plans tab audit (same structure) | Reuse gap IDs/tables/citations; extend only |
| `docs/planning/audits/platform-admin/05-pricing.md` | Pricing tab audit (same structure) | Reuse gap IDs/tables/citations; extend only |
| `ADR-0007` | Per-workspace reveal + credit counter; the M11 ledger upgrade path | Cite; build the ledger design *as* that upgrade path |
| `ADR-0012` | Transparent no-lock-in policy (no auto-renew, no MVP credit expiry, no churn data-destroy, transparent self-serve, placeholder prices) | Cite as the **default that subscriptions must not silently contradict**; frame amendments as proposed `ADR-0041` |
| `ADR-0013` | Charge-by-verified-result + credit-back on bounce | Cite; do not restate the charge matrix |
| `ADR-0029` | M11 append-only ledger + batch reservation + M12 per-workspace/team leases | Cite as the basis for P3/P4 |
| `ADR-0038` | Bulk-enrichment billing/forecast/quota | Cite as **out of scope** (§1.2); reference for the enrichment-spend boundary |
| `ADR-0011` / `ADR-0032` | Platform-admin privileged access; audit action vocabulary | Cite for the billing-permission matrix + audit-action names; do not re-spec RBAC |

---

## 10. Implementation note — how this package gets built

- **Docs first, code never (in this package).** This folder is **enterprise planning
  documentation**. No source under `apps/**` or `packages/**` is modified by this work.
- **Defer-honest.** Every proposed table/job/endpoint carries a gating tag; deferred infra is
  **never** presented as built. Auto-renewal/expiry/annual-lock are **proposed amendments**
  (`ADR-0041`), not decided facts.
- **No `drizzle-kit generate`.** This host has **no docker**; any new-table migration is
  **hand-authored** and **CI/docker-verified** — `generate` causes stale-snapshot drift. Every
  doc's testing/rollback/migration section reflects this.
- **Synthesis reconciles.** `07_Implementation_Roadmap.md` is the single place where the P0–P6
  roadmap and the dependency matrix are **finalized**; if `01`–`06` and `07` ever disagree, `07`
  (and then this spine) win.

> Structure rules never override correctness rules. No multi-tenant money path ships without an
> RLS-enforced, ownership-checked, audited design — that is a correctness requirement, not a
> style choice. Security has the final say on any access/PII/compliance point.

---

## 11. References

- `CLAUDE.md` — project guide (brand vs scope, skill routing, precedence).
- `docs/planning/07-billing-credits.md` — canonical billing/credit spec.
- `docs/planning/03-database-design.md` §8 — billing/compliance schema.
- `docs/planning/28-enterprise-readiness-audit.md` — G-BIL-1, G-BIL-2.
- `docs/planning/audits/platform-admin/{03-billing,04-plans,05-pricing}.md` — tab audits.
- `docs/planning/audits/platform-admin/00-README.md`; `docs/planning/list-plan/00-overview.md` — structural precedents.
- `docs/planning/decisions/ADR-0007, ADR-0011, ADR-0012, ADR-0013, ADR-0029, ADR-0032, ADR-0038, ADR-0040` — decisions (next free: **0041**; proposed: `ADR-0041` subscriptions amendment, `ADR-0042` hierarchical allocation).
