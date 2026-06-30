---
title: "05 — Implementation Roadmap & Build Status (synthesis)"
scope: plans-pricing-credits
doc: "05"
last_updated: 2026-06-30
owner: product + platform + billing
status: First build cycle SHIPPED (P2 self-serve slice) — forward P0–P6 roadmap
---

# 05 — Implementation Roadmap & Build Status

> **Synthesis doc.** This is the single place the program's roadmap is **finalized** and the
> **as-built status** is recorded. It reconciles [`00-README`](./00-README.md) (locked decisions,
> OD register, gating legend, dependency-matrix skeleton), [`02_Current_System_Audit`](./02_Current_System_Audit.md)
> (the as-built baseline), [`03_Information_Architecture`](./03_Information_Architecture.md) (surface
> placement), and [`04_Enterprise_Features`](./04_Enterprise_Features.md) (the 15-feature catalog),
> plus the subdirectory artifacts (`database/`, `api/`, `wireframes/`, `diagrams/`). It plays the
> role the `00-README §6` index reserved for "07 — Implementation Roadmap"; the package's structure
> diverged (the 05/06 content lives under `database/` + `api/` + `wireframes/`), so the synthesis is
> numbered `05` here. **If `01`–`04` and this doc ever disagree on schedule or status, this doc wins.**
>
> **Defer-honest contract.** Every row carries a gating tag from `00-README §8`. A non-`[exists]`
> capability is **never** presented as built. Subscriptions / auto-renew / expiry / multi-currency
> stay **proposed `ADR-0041`/`ADR-0042`** amendments and never silently contradict `ADR-0012`.

---

## 1. Executive Summary

The first build cycle shipped the **gate-respecting self-serve slice** of the commercial program —
the work that needs **no Stripe key, no Docker-verified new table this host can't test, and no
owner-deferred decision**. It turns the audit's verdict (*counter, not ledger; packs, not
subscriptions; admin-deep, web-thin*) into a materially **less web-thin** product:

- A **public, transparent pricing page** (`/pricing`, unauthenticated) — a real conversion surface
  that did not exist, backed by a new **public pricing read API**.
- The customer **billing hub** (`/settings/billing` re-shaped into Plan / Credits / Usage tabs +
  defer-honest Invoices / Subscription), wired to a new **`GET /credits/me`** plan envelope.
- **Credit-history depth**: keyset pagination, type/source filters, and a formula-injection-guarded
  **CSV export** on `GET /credits/usage`.
- The **OD-8 workspace-admin gate** on the Top-up control.
- **OD-7 signup-bonus credits** (the MVP trial = a credit grant), configurable per plan template and
  seeded once on org creation — backward-compatible (0 by default).
- A **dark, read-only low-balance notifier sweep** scaffold (charges/deletes nothing; off by default).

Everything heavier — the **M11 ledger keystone**, **M12 hierarchical allocation**, **Stripe**
(checkout / invoices / payment methods / dunning), and the **subscription decision (OD-1)** — remains
**correctly deferred** (§5). The forward roadmap (§3) sequences them value-to-risk.

---

## 2. What shipped this cycle (as-built, on `main`)

Ten commits (one planning, nine build). All gated locally with `turbo typecheck` (13/13 packages
green at cycle close) + `biome` (LF-normalized); migrations are CI/docker-verified (this host has no
docker). Brand **TruePoint** vs scope **`@leadwolf/*`** is intentional and never reconciled.

| # | Commit theme | Surfaces | Feature / OD | Gating |
|---|---|---|---|---|
| 0 | Planning package | `docs/planning/plans-pricing-credits/**` | — | docs |
| 1 | **Public pricing read API** — `GET /api/v1/pricing/{credit-packs,plans}` (unauth, rate-limited, owner-read of active catalog via new `withPlatformReadTx`; new `@leadwolf/types` `pricing.ts`; repo `listActive`) | `apps/api`, `packages/{types,db}` | F12 (public read), ADR-0012 | `[exists]` |
| 2 | **`GET /credits/me`** plan envelope (RLS read of tenant row + active member/workspace counts; plan name resolved against owner catalog) | `apps/api`, `packages/{types,db}` | F1-adjacent (entitlement read) | `[exists]` |
| 3 | **Public `/pricing` page** (new `(public)` route group, unauth; plan tiers + packs; USD; no token/tenant/balance) | `apps/web` | F12, OD-3 | `[exists]` |
| 4 | **Billing hub** — tabbed Plan/Credits/Usage + defer-honest Invoices/Subscription; `?tab=` deep-link | `apps/web` | OD-3 | `[exists-partial]` |
| 5 | **Credit-history depth** — keyset pagination + type/source filters + CSV export on `/credits/usage` | `apps/api`, `packages/{types,db}`, `apps/web` | F2-adjacent (usage), `02 §9.1` | `[exists-partial]` |
| 6 | **OD-8 workspace-admin gate** on Top-up (shared `useSessionRole` + `isWorkspaceAdmin`) | `apps/web` | F10, OD-8 | `[capability]` |
| 7 | **OD-7 signup-bonus credits** — `plan_templates.trial_bonus_credits` (migration 0037), admin field, idempotent grant on org creation | `packages/{db,types}`, `apps/{api,admin}` | F6, OD-7 | `[exists-partial]` |
| 8 | **Low-balance notifier sweep** scaffold — leader-locked daily, read-only, DARK (env-gated off) | `apps/workers`, `packages/config` | F15 | `[exists-partial]` (dark) |

**New durable building blocks** later phases reuse: `withPlatformReadTx` (non-auditing owner read
for system-owned non-PII config), the `pricing.ts` public contract, `tenantRepository.getBillingProfile`,
`revealRepository.listUsagePage`/`listUsageForExport` (keyset + filtered), the shared `useSessionRole`
hook, and the dark-worker env-gate pattern for billing sweeps.

---

## 3. The finalized P0–P6 roadmap

> Ordering follows value-to-risk: cheap correctness first, then revenue depth, then the ledger
> keystone, then allocation, subscriptions/invoicing, and the enterprise-governance finish. Status
> reflects this cycle. Per phase: theme · key deliverables · gating · **testing/rollback**.

### P0 — Correctness & idempotency quick wins · `[exists]` `[capability]` · **PARTIAL**
- **Done:** OD-8 workspace-admin gate on Top-up; defer-honest stubs (Invoices/Subscription panels,
  Top-up "coming soon"); CSV export formula-injection guard reused.
- **Remaining:** idempotency attestation review on any *new* money POST (none added this cycle that
  mutate credits except the org-creation seed, which is single-shot by construction); four-state QA
  pass on the new hub tabs.
- **Testing/rollback:** UI-only + read paths → revert is a frontend/route revert; no migration.

### P1 — Revenue-ops & economics depth (admin) · `[exists-partial]` `[Stripe]` · **NOT STARTED**
- MRR/ARR/churn rollups, per-tenant economics drill-down depth, refund-reason taxonomy, low-balance
  ops surfacing of the notifier (§P-extra), monthly-grant activation UI (blocked on the grant worker).
- **Testing/rollback:** additive admin reads; revert is route/UI revert. No schema needed for the
  rollups (aggregate over existing `purchases`/`contact_reveals`/`provider_calls`).

### P2 — Self-serve web billing hub + public pricing · `[exists-partial]` `[Stripe]` `[flag]` · **SHIPPED (this cycle)**
- **Done:** public pricing API + page, billing hub tabs, `GET /credits/me`, credit-history
  pagination/filter/export, OD-8 gate.
- **Remaining (blocked):** a *working* Top-up needs `POST /credits/checkout` (`[Stripe]`); the
  Invoices/Subscription tabs need P5.
- **Testing/rollback:** new routes/pages are additive; `withPlatformReadTx` is read-only; revert is
  per-commit. No migration in P2.

### P3 — Credit-ledger keystone (M11) · `[M11-ledger]` · **DEFERRED (no docker on this host)**
- Append-only `credit_ledger` (`database/01-credit_ledger.sql`, hand-authored), job-scoped batch
  **reservation** pulled forward, reconciliation invariant `balance == SUM(delta)` (closes G-BIL-1).
  The counter becomes a derived cache.
- **Testing/rollback:** the ledger is the riskiest migration — must be CI/docker-verified with an
  itest proving the invariant + a backfill from `purchases`/`contact_reveals`; rollback is a
  forward-only reconciliation (never drop the ledger once writing). **Do not author on this host
  without CI green.**

### P4 — Hierarchical allocation (M12 leases) · `[M12-lease]` `[decision-gated]` · **DEFERRED**
- `team_budgets`/`user_budgets`, per-scope ledger attribution, lease-reaper worker, allocation UI
  (`wireframes/web/allocation.md`). Tenant pool stays authoritative (LD-2). Proposed `ADR-0042`.

### P5 — Subscriptions, trials, invoicing & multi-currency (behind flags) · `[Stripe]` `[flag]` `[decision-gated]` · **DEFERRED**
- Opt-in recurring/annual (month-to-month stays default — LD-1), real invoices/receipts, payment
  methods, dunning, USD-authoritative multi-currency spec. Proposed `ADR-0041`. The signup-bonus
  trial (OD-7) shipped this cycle is the MVP slice of F6; time-boxed trials remain deferred.

### P6 — Enterprise governance, peer-approval & final QA · `[capability]` `[decision-gated]` · **PARTIAL**
- **Done:** the OD-8 web purchase gate (the first governance control).
- **Remaining:** peer-approval enforcement on high-risk money paths, rollover/expiry policy rollout
  (gated on M11 + OD-4), console-wide QA.

### P-extra (this cycle, cross-phase)
- **OD-7 signup-bonus** (migration 0037) — F6 MVP trial, shipped.
- **Low-balance notifier sweep** (dark) — F15 detector, shipped; customer delivery channel is the
  next wiring step.

---

## 4. Cross-cutting dependency matrix (finalized)

> Completes the `00-README §8` skeleton. `●` shipped this cycle · `○` exists pre-cycle · `◐` partial
> · `—` deferred (tag). RLS/isolation column notes the enforced boundary.

| Element | Gating | Status | Isolation / boundary |
|---|---|---|---|
| `GET /pricing/{credit-packs,plans}` (public) | `[exists]` | ● | unauth; owner read of non-PII catalog only (`withPlatformReadTx`); IP rate-limit |
| `withPlatformReadTx` (non-auditing owner read) | `[exists]` | ● | system-owned non-PII config ONLY; never tenant PII (that's `withTenantTx`) |
| `creditPack/planTemplate.listActive` | `[exists]` | ● | active-only projection; owner read |
| `GET /credits/me` (plan envelope) | `[exists]` | ● | RLS tenant-scoped; plan name via owner catalog |
| `tenantRepository.getBillingProfile` | `[exists]` | ● | RLS: own tenant row + own member/workspace counts |
| public `/pricing` page | `[exists]` | ● | `(public)` route group — outside the AppShell auth gate |
| billing hub tabs (`/settings/billing`) | `[exists-partial]` | ● | authed; `?tab=` validated → default Credits |
| `GET /credits/usage` (paginated/filtered/CSV) | `[exists-partial]` | ● | RLS workspace-scoped; keyset over v7 id; CSV formula-guarded |
| OD-8 workspace-admin gate (Top-up) | `[capability]` | ● | UI gate (fail-closed) + server gate lands with checkout |
| `plan_templates.trial_bonus_credits` (mig 0037) | `[exists-partial]` | ● | owner-written catalog; seeded into the new tenant counter once |
| signup-bonus grant (provisionNewOrg) | `[exists-partial]` | ● | atomic with org creation; 0 by default (backward-compatible) |
| low-balance notifier sweep (dark) | `[exists-partial]` | ● | leader-locked; owner read; READ-ONLY; env-gated off |
| `credit_packs` / `plan_templates` CRUD (admin) | `[exists]` | ○ | `pricing:manage` + `withPlatformTx` audited |
| admin economics / low-balance reads | `[exists]` | ○ | `billing:read` + `withPlatformTx` audited |
| tenant credit grant/adjust/refund/plan (admin) | `[exists]` `[capability]` | ○ | `tenants:*` + JIT elevation, audited |
| `POST /billing/webhook` (Stripe grant) | `[exists]` `[Stripe]` | ○ | HMAC signature; `stripe_event_id` dedupe |
| `POST /credits/checkout` (web Top-up) | `[Stripe]` | — | needs Stripe wiring + server workspace-admin gate |
| `credit_ledger` (M11) | `[M11-ledger]` | — | append-only; reconciliation invariant; **no docker here** |
| `subscriptions` / `billing_cycles` | `[decision-gated]` `[Stripe]` | — | proposed `ADR-0041`; never default auto-renew |
| `invoices` / `payment_methods` | `[Stripe]` `[flag]` | — | Stripe is system-of-record; no PAN stored |
| `team/user_budgets` + leases (M12) | `[M12-lease]` `[decision-gated]` | — | proposed `ADR-0042`; pool stays authoritative |
| monthly-grant / renewal / dunning / reconciliation / lease-reaper workers | mixed | — | each tagged; none built (notifier scaffold is the only billing sweep) |

---

## 5. Deferred register (what is NOT built, and why)

| Deferred thing | Tag | Why deferred | Unblocks |
|---|---|---|---|
| `credit_ledger` + reconciliation | `[M11-ledger]` | New table needs docker-verified migration + invariant itest; this host has no docker | P3, expiry/rollover, refund-of-spent, allocation |
| `team/user_budgets`, leases, allocation UI | `[M12-lease]` `[decision-gated]` | Builds on M11 + OD-2 decision (proposed `ADR-0042`) | P4 |
| Subscriptions, proration, annual, dunning | `[decision-gated]` `[Stripe]` | OD-1 owner decision + Stripe Billing; must not contradict ADR-0012 (proposed `ADR-0041`) | P5 |
| `POST /credits/checkout`, invoices, payment methods, multi-currency | `[Stripe]` `[flag]` | No Stripe key wired; USD authoritative until intl GTM (OD-5) | working Top-up, P5 |
| Monthly-grant activation (dormant `monthly_credit_grant`) | `[decision-gated]` `[M11-ledger]` | No grant worker; recurring grant is decision+ledger gated — **NOT advertised** on the public page | P1/P5 |
| Time-boxed trials | `[decision-gated]` | OD-7 MVP = signup-bonus (shipped); time-box is the deferred path | P5 |
| Low-balance customer delivery (email/in-app) | — | Detector scaffold shipped; delivery channel (ADR-0027) is the next wiring step | F15 |
| Peer-approval enforcement on money paths | `[capability]` `[decision-gated]` | Spec-ed, not enforced v1 (OD-8) | P6 |

---

## 6. Testing & rollback discipline (per cycle)

- **Local gates run this host:** `turbo typecheck` (13/13 green), `biome` (LF-normalized — `core.autocrlf=true`
  here, so the working tree is CRLF but commits LF; verify Biome on LF content). **Gap:** itests +
  migration-apply need docker (CI only).
- **Migration 0037** (`trial_bonus_credits`) is hand-authored (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`)
  + a `_journal.json` entry (idx 37) — **never `drizzle-kit generate`** (stale-snapshot drift). CI
  must prove it applies; the column is nullable and the grant is 0 by default, so the migration is
  forward-safe and the feature is inert until staff configure a bonus.
- **Rollback granularity:** every shipped slice is its own commit; routes/pages/reads revert cleanly.
  The one schema change (0037) is additive and backward-compatible — a revert of the *consumer* leaves
  a harmless dormant column.
- **Read-only by construction:** the public pricing reads, `/credits/me`, usage reads, and the
  low-balance sweep mutate nothing; the only writes this cycle are the admin plan-template upsert (the
  new field) and the single org-creation seed.

---

## 7. Risks & ADR-0012 discipline

| # | Risk | Mitigation |
|---|---|---|
| R1 | A reader treats the dormant `monthly_credit_grant` as delivered recurring credits | **Not advertised** on the public page; only seats/workspaces/features shown; packs are the real mechanism |
| R2 | The signup-bonus seed is read as a general "credits can be minted anywhere" precedent | It is a **single, intentional** ingress at org creation (OD-7), 0 by default; on M11 it becomes a ledger `grant` entry |
| R3 | Public pricing read leaks tenant data or is abused | Unauth read of the **active catalog only** (no PII), IP rate-limited; owner read never touches tenant rows |
| R4 | Subscriptions/expiry surfaces imply auto-renew | Subscription tab states the month-to-month / no-auto-renew / no-expiry posture explicitly; recurring stays proposed `ADR-0041` |
| R5 | The dark notifier is read as "low-balance emails are live" | DARK by default; logs ids only; documented as a detector scaffold awaiting a delivery channel |
| R6 | New-table work (ledger/subscriptions/invoices/budgets) authored without docker → stale-snapshot drift | Hand-author + CI/docker-verify; **never `generate`**; P3+ blocked on CI green |

---

## 8. References

- [`00-README.md`](./00-README.md) — locked decisions (LD-1/LD-2), OD register (OD-1…OD-8), gating
  legend (§8), anti-duplication map (§9), build constraints (§10).
- [`02_Current_System_Audit.md`](./02_Current_System_Audit.md) — as-built baseline + `§9.1` "what does
  NOT exist" master table.
- [`03_Information_Architecture.md`](./03_Information_Architecture.md) — OD-3 per-portal IA + flows.
- [`04_Enterprise_Features.md`](./04_Enterprise_Features.md) — the 15-feature catalog + gating graph.
- `database/` (proposed schema — ledger/subscriptions/invoices/budgets, hand-authored), `api/`
  (endpoint contracts), `wireframes/`, `diagrams/`.
- ADRs: `ADR-0007` (counter + M11 path), **`ADR-0012`** (no-lock-in default), `ADR-0029` (M11 ledger +
  M12 leases), `ADR-0032` (audit vocabulary); proposed **`ADR-0041`** (subscriptions/rollover),
  **`ADR-0042`** (hierarchical allocation).
- Source shipped this cycle: `apps/api/src/features/{pricing,billing,admin/pricing}`;
  `packages/types/src/{pricing,billing,planTemplateAdmin}.ts`;
  `packages/db/src/{client,repositories/{creditPackRepository,planTemplateRepository,revealRepository,workspaceRepository}}`;
  `apps/web/src/features/{public-pricing,settings-billing}`, `apps/web/src/lib/useSessionRole.ts`,
  `apps/web/src/app/(public)/pricing`; `apps/admin/src/features/plans`;
  `apps/workers/src/queues/lowBalanceNotifierSweep.ts`; `packages/db/src/migrations/0037_plan_trial_bonus.sql`.

---

> **Cross-reference handle:** cite this file as `05 §<n>` (e.g. *"the shipped P2 slice, `05 §2`"*,
> *"the deferred register, `05 §5`"*). This doc is the program's status + schedule source of truth.
