# 08 — Data-Enrichment Workflow

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored · **Prev:**
> [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) · **Next:**
> [`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md)

## Objective

Design the **Enrichment & Verification console** — a staff (Surface 1, `apps/admin`) and customer (Surface
2, `apps/web`) control plane over the **already-shipped** enrichment engine, the verification subsystem, and
the freshness/reverification loop. The engine itself is `Shipped` (per-field waterfall, breakers, cost
ledger); what is missing is **operational surface**: nobody can see a bulk-enrichment run's cost and
hit-rate, re-run a failed slice, run a 25–50 row **test batch** before committing spend, route/throttle a
provider, escalate a `catch_all`/`unknown` email to a commercial verifier, or read the per-field provenance
that survivorship wrote. This document specifies that console end-to-end.

Five subsystems compose here:

1. **The per-field waterfall** — ordered providers, stop at first PASS, fall through on empty/invalid,
   **charge only on success** ([`02` §4.8](./02-Enterprise-Research.md#48-enrichment-pipelines)). Shipped in
   `packages/core/src/enrichment/waterfall.ts`.
2. **Provider routing / budget / health** — extend `features/provider-configs`; `cost_micros` ledger;
   `ProviderBudgetExceededError` 429.
3. **The `enrichment_jobs` run console** — per-run cost, hit-rate, provider attribution, re-run, test batch
   ([`02` §4.8](./02-Enterprise-Research.md#48-enrichment-pipelines),
   [`02` §4.16](./02-Enterprise-Research.md#416-approval-workflows)).
4. **The verification subsystem** — `hybridVerifier` (Reacher → commercial escalation on `catch_all`/
   `unknown`), `passThroughVerifier` today, the **open vendor decision**
   ([`02` §4.4](./02-Enterprise-Research.md#44-data-validation)).
5. **The freshness / reverification loop** — `reverifyContacts`, the `last_verified_at` decay clock,
   re-verify on access ([`02` §4.8](./02-Enterprise-Research.md#48-enrichment-pipelines),
   [`02` §4.23](./02-Enterprise-Research.md#423-performance-optimization)).

Status legend: `Shipped` · `Dark` (built, env/flag-gated off) · `Inert` (wired, does nothing yet) ·
`Partial` · `Planned` · `Missing`.

> **Precedence note.** Enrichment is a **metered, money-moving, PII-writing** path. Per TruePoint precedence:
> Security has final say (suppression, residency, no spend without an authorized actor); Platform owns the
> tenancy mechanism (every overlay write through `withTenantTx`; every cross-tenant staff op through the
> audited `withPlatformTx`); Data owns the model and survivorship semantics. A bulk-enrichment write without
> an RLS-enforced, ownership-checked, audited path **is a bug**, not a style choice.

---

## 1. Current Challenges

The engine works; the operator is blind and the spend is unguarded. Concretely, on branch
`feat/data-mgmt-01-research-brief`:

| # | Challenge | Evidence | Status |
|---|---|---|---|
| C1 | **No run console.** `enrichment_jobs` / `_chunks` / `_rows` exist (`packages/db/src/schema/enrichmentJobs.ts`, migration 0030-era) and the worker writes a full ledger, but no admin or customer screen reads it. There is `GET /enrichment/jobs(/:jobId)` and nothing renders it. | `schema/enrichmentJobs.ts:42`; brief §API | `Missing` (UI) |
| C2 | **Spend is uncapped at the operator level.** A bulk run can charge thousands of `cost_micros` rows with no pre-flight worst-case estimate shown to a human and no maker/checker gate. The schema *anticipates* this — `enrichment_jobs.status` includes `estimating` and `awaiting_confirmation` (`enrichmentJobs.ts:75`) — but no UI drives that transition. | `enrichmentJobs.ts:50,75` | `Partial` (schema ready, no gate UI) |
| C3 | **Verification is `Dark`.** `hybridVerifier` exists (Reacher → commercial), but with no `REACHER_*` creds (`packages/config/src/env.ts:110`) the system ships `passThroughVerifier`; every email comes back `unknown`/unverified. The **commercial email vendor is not chosen** (NeverBounce vs ZeroBounce vs Bouncer). Phone is the same: no `TWILIO_*` (`env.ts:117`). | `env.ts:110,117`; brief §state | `Dark` |
| C4 | **No test-batch path.** [`02` §4.8](./02-Enterprise-Research.md#48-enrichment-pipelines) (Clay) mandates testing 25–50 rows first. Today you either enrich one contact (`POST /enrichment/:entity/:id`) or commit a whole file. | brief §API | `Missing` |
| C5 | **Provider health is read-only and narrow.** `features/provider-configs` shows enable/disable, masked key, rate limit, monthly budget + MTD spend, health `healthy|degraded|down`. It does **not** show the waterfall *order* actually used, per-provider hit-rate, or the **circuit-breaker** state that `waterfall.ts` keeps per-process (`BREAKER_THRESHOLD=3`, 60 s cooldown). | brief §provider-configs; `waterfall.ts:8` | `Partial` |
| C6 | **Freshness is a clock with no loop UI.** `last_verified_at` exists on `contacts`, `reverifyContacts.ts` exists, the `reverification`/`reverification-sweep` queues exist, but the `data_health.reverification` flag is off and there is no console to set a decay SLA or watch yield. | brief §contacts, §queues | `Inert` |
| C7 | **Provenance is written but never read.** `contacts.field_provenance` (jsonb per-field winner-map) and `accounts.field_provenance` are populated by survivorship, but no surface shows *which provider won which field and why* — the audit trail [`02` §4.11](./02-Enterprise-Research.md#411-audit-logs)/[§4.14](./02-Enterprise-Research.md#414-data-governance) demands. | `schema/contacts.ts:103` | `Missing` (UI) |
| C8 | **Dedupe-before-enrichment is convention, not enforced in the console.** [`02` §4.23](./02-Enterprise-Research.md#423-performance-optimization) is explicit: dedupe BEFORE enrichment so you never pay to enrich a duplicate. The import fan-out enqueues `dedup` then `firmographics`, but a *staff-triggered* bulk enrichment has no pre-flight "N rows are duplicates, exclude them?" guard. | brief §queues; [`07`](./07-Deduplication-and-Linking.md) | `Partial` |
| C9 | **No `data:*` capability.** Staff RBAC has 16 capabilities, none scoped to data ops (`packages/types/src/staffCapability.ts:13`). Enrichment runs today would have to borrow `providers:manage`, conflating provider config with run execution. | `staffCapability.ts:13` | `Missing` |

---

## 2. Enterprise Best Practices (cited)

All citations resolve into [`02-Enterprise-Research`](./02-Enterprise-Research.md); dimension numbers are
that doc's `### 4.x` anchors.

- **D8 — Enrichment pipelines** ([`02` §4.8](./02-Enterprise-Research.md#48-enrichment-pipelines)): an
  **ordered waterfall PER FIELD**, stop at the first result that **PASSES validation**, fall through on
  empty/invalid, **CHARGE ONLY ON SUCCESS**. Stage order: `identity → eligibility → enrich → standardize →
  validate → writeback`. **Test 25–50 rows first.** Treat freshness as **decaying** (Clay data waterfalls).
- **D16 — Approval workflows** ([`02` §4.16](./02-Enterprise-Research.md#416-approval-workflows)):
  **PREVIEW-THEN-COMMIT** — Cognism Enrich previews with no spend / no PII reveal, then a separate **Redeem**
  reveals and charges. **Pre-compute worst-case spend** before a bulk run.
- **D4 — Data validation** ([`02` §4.4](./02-Enterprise-Research.md#44-data-validation)): email status is
  **multi-valued** — `catch_all` and `unknown` are **distinct risk tiers**, and you **NEVER auto-promote**
  them to `valid`. This is the trigger for commercial-verifier escalation.
- **D11 — Audit logs** ([`02` §4.11](./02-Enterprise-Research.md#411-audit-logs)): attach **source/workflow
  provenance** to every record; **log match decisions**; record match composition.
- **D14 — Data governance** ([`02` §4.14](./02-Enterprise-Research.md#414-data-governance)):
  **ATTRIBUTE-LEVEL survivorship** — per-field source-priority / recency / frequency / completeness /
  quality-score with cascading fallbacks (Profisee MDM). One field can win from provider A while a sibling
  field wins from provider B.
- **D10 — Quality scoring** ([`02` §4.10](./02-Enterprise-Research.md#410-quality-scoring)): **last-updated
  recency** is a top feature; recompute on every change. Verification yield and freshness feed this.
- **D18 — Queue management** ([`02` §4.18](./02-Enterprise-Research.md#418-queue-management)): a **dedicated
  bulk lane** below interactive; multi-window limits, quota/reset headers, `429`.
- **D19 — Error handling** ([`02` §4.19](./02-Enterprise-Research.md#419-error-handling)): never fail the
  whole batch — per-record status array + a separate failed-results artifact; **bill only 200s**; idempotency
  keys replay the first response; backoff+jitter on 429/5xx.
- **D23 — Performance** ([`02` §4.23](./02-Enterprise-Research.md#423-performance-optimization)): **DEDUPE
  BEFORE ENRICHMENT**; **stop the waterfall at the first hit**; **re-verify on access / incremental update**.

---

## 3. Gaps in Current Implementation

Cross-references: [`01-Current-State-Analysis` §5.4–5.5](./01-Current-State-Analysis.md#54-enrichment--engine-shipped---learning-stubs)
and [`03-Gap-Analysis`](./03-Gap-Analysis.md).

| Gap | Best practice owed | Today | Target tier |
|---|---|---|---|
| G1 Run console (cost/hit-rate/attribution) | D8, D20 | `enrichment_jobs` ledger written, never rendered | **Phase 1** |
| G2 Test-batch (25–50 rows) before commit | D8, D16 | absent | **Phase 1** |
| G3 Preview-then-commit spend gate | D16 | `awaiting_confirmation` status exists, no driver | **Phase 1 → 2** |
| G4 Commercial email verifier chosen + wired | D4 | `Dark`; `passThroughVerifier` | **Phase 1** |
| G5 Provider waterfall order + breaker visibility | D8, D18 | config-only view | **Phase 1** |
| G6 Freshness SLA + reverification yield console | D8, D23 | `Inert` clock | **Phase 1 → 2** |
| G7 Provenance / survivorship explain view | D11, D14 | written, unread | **Phase 1** |
| G8 Dedupe-before-enrichment pre-flight guard | D23 | convention only | **Phase 1** |
| G9 Maker/checker on high-spend runs | D16 | none (see [`09`](./09-Review-and-Approval-System.md)) | **Phase 2** |
| G10 Audited bulk export of enriched data | D19, D21 | none (see [`09`](./09-Review-and-Approval-System.md)) | **Phase 2** |
| G11 `data:*` capabilities | D15 | none | **Phase 0 → 1** |

The MVP/Phase-0 deliverable from this doc is **read-only**: the admin **Data management → Enrichment**
screen that composes the existing `enrichment_jobs` ledger + `provider-configs` health behind the new
`data:read` capability. Everything that *executes* a run or *changes* spend is Phase 1+ and gated by
`data:manage` / maker-checker.

---

## 4. Recommended Solution

### 4.1 The engine, as a pipeline (what the console operates)

The shipped per-field waterfall, expressed as the canonical six stages
([`02` §4.8](./02-Enterprise-Research.md#48-enrichment-pipelines)):

```
                    ┌──────────────────────── per CONTACT ───────────────────────────┐
  identity   ──►    resolve who this is: email_blind_index / linkedin_public_id /
                    master_person_id  (overlayMatcher → masterGraphMatcher STUB)
                                          │
  eligibility ─►    assertNotSuppressed (global suppression/blocklist) + TCPA gate
                    (phone_line_type) + dedupe check (skip duplicate_of_contact_id)   ──► D23
                                          │
  enrich     ──►    ┌──── per FIELD ────────────────────────────────┐
                    │  orderProviders(trust ÷ estimateCostMicros)    │  waterfall.ts
                    │  for provider in order:                        │
                    │    if breakerOpen(provider): skip              │  BREAKER_THRESHOLD=3
                    │    r = provider.enrich(req)                    │  cooldown 60s
                    │    if r.empty or !validate(r): continue (free) │  ◄── fall through
                    │    else: STOP, charge cost_micros, record win  │  ◄── charge ONLY on success
                    └───────────────────────────────────────────────┘
                                          │
  standardize ─►    normalize (email lower, phone E.164, domain canonicalize)
                                          │
  validate   ──►    emailVerifier (hybrid Reacher→commercial) / phoneVerifier (Twilio)
                    → email_status ∈ {valid,risky,invalid,catch_all,unknown}          ──► D4
                                          │
  writeback  ──►    attribute-level survivorship → field_provenance winner-map        ──► D14
                    set last_verified_at, recompute priority_score (rescore)          ──► D10
```

Key invariants the console must surface and never violate:

- **Charge only on success** — a provider miss / invalid result is free; `enrichment_job_rows.charged`
  is the source of truth (`enrichmentJobs.ts:134`). The run console's "cost" column sums `cost_micros`
  WHERE `charged = true`.
- **Stop at first PASS** — order is `trust ÷ estimateCostMicros` (`waterfall.ts:providerScore`); the console
  shows the *actual* order and per-provider hit count.
- **Dedupe before enrich** — eligibility stage excludes `duplicate_of_contact_id IS NOT NULL`; the bulk
  estimate pre-flight reports the duplicate count and lets the operator exclude them
  ([`07`](./07-Deduplication-and-Linking.md)).

### 4.2 Surface 1 — Staff Enrichment console (`apps/admin`)

A new feature folder `apps/admin/src/features/data-enrichment/` under the **Data management** nav group
([`04`](./04-Control-Panel-Architecture.md)), modeled on `features/imports` (read-only monitor) +
`features/retention` (read/write + tabs + super-admin gate). Three tabs:

1. **Runs** — cross-tenant table of `enrichment_jobs` (status, tenant/ws, rows, hit-rate, charged cost,
   provider attribution). Drill into a run → chunks → rows, with a **rejects/errors** filter and a
   **failed-results download** ([`02` §4.19](./02-Enterprise-Research.md#419-error-handling)). Actions:
   **re-run failed slice**, **pause/resume/cancel**, **promote `awaiting_confirmation` → running** (the
   commit half of preview-then-commit), each behind `data:manage` and audited via `withPlatformTx`.
2. **Providers** — extend `features/provider-configs`: add the **live waterfall order**, per-provider
   **hit-rate** and **MTD spend vs budget**, and **circuit-breaker state** (`open`/`half-open`/`closed`).
3. **Verification & Freshness** — verifier vendor + creds status (`passThroughVerifier` vs `hybridVerifier`),
   the per-tier verification **yield** (`valid`/`risky`/`catch_all`/`unknown`/`invalid` distribution), and
   the **freshness SLA** editor (decay window per workspace; `reverification` flag state and last sweep).

### 4.3 Surface 2 — Customer Enrichment usage (`apps/web`)

Extend `apps/web/src/features/data-health` with an **Enrichment usage** panel (own-workspace, `withTenantTx`,
gated by `requireOrgRole` — **not** staff RBAC): own bulk-enrichment runs, **preview-then-commit** (the
Cognism Enrich → Redeem pattern — preview shows worst-case spend + match count, no PII revealed, no charge;
Redeem reveals + charges), test-batch on own data, and the data-health freshness view already live.

### 4.4 Preview-then-commit (the spend gate)

This is the load-bearing control and ties directly to [`09`](./09-Review-and-Approval-System.md). The
schema already encodes it via the `enrichment_jobs.status` ladder
(`queued → estimating → awaiting_confirmation → running`). The flow:

```
upload/select N rows
   │  enqueue estimate (dedicated bulk lane, below interactive — D18)
   ▼
estimating ──► estimate.ts computes WORST-CASE spend (every row hits the most-expensive
   │           capable provider) + match preview (overlay-matchable vs provider-only) + dup count
   ▼
awaiting_confirmation  ─── PREVIEW shown: { eligibleRows, duplicateRows(excludable),
   │                        worstCaseCostMicros, providerBreakdown, estimatedHitRate }
   │                        NO charge, NO PII reveal yet  (Cognism "Enrich" half — D16)
   │
   ├── if worstCaseCostMicros > approvalThreshold → maker/checker (09) BEFORE commit
   ▼
running ──► COMMIT (Cognism "Redeem" half): waterfall executes, charges only on success,
            writes field_provenance, sets last_verified_at
   ▼
completed | partial | failed   (per-row ledger; bill only 200s — D19)
```

Worst-case spend is computed **before** any provider call so FinOps
([`truepoint-operations`](../../../.claude/skills/truepoint-operations/SKILL.md)) can enforce a per-tenant
ceiling and the `ProviderBudgetExceededError` 429 path is exercised *at estimate time*, not mid-run.

---

## 5. Implementation Steps (sequenced)

**Phase 0 — Observe & Enable (read-only):**

1. Add capability `data:read` to `packages/types/src/staffCapability.ts`; bundle into `super_admin`
   (implied), `compliance_officer`, `read_only`, `support` via `ROLE_CAPABILITIES`. Regenerate
   `capabilitiesForRole` tests.
2. Backend read router `apps/api/src/features/admin/data/enrichmentRoutes.ts` mounted at
   `/api/v1/admin/data/enrichment/*`, gated `platformAdmin` + `requireCapability("data:read")`. Read path
   uses `withPlatformTx` (audited) for cross-tenant rollups; per-tenant drill uses a tenant-scoped read.
3. `apps/admin/src/features/data-enrichment/` scaffold: `index.ts`, `api.ts` (the only network seam),
   `types.ts`, `hooks/useEnrichmentRuns.ts`, `hooks/useRun.ts`, `components/EnrichmentPage.tsx` with the
   three tabs (Runs read-only; Providers reuses provider-configs reads; Verification & Freshness read-only).
4. Add the **Data management → Enrichment** `NavDestination` to `navConfig.ts` (under the group introduced
   by [`04`](./04-Control-Panel-Architecture.md)).

**Phase 1 — Validate, Enrich, Re-run:**

5. Add `data:manage` (run execution) and `data:review` (clerical) capabilities.
6. Write router for run control: re-run failed slice, pause/resume/cancel, promote `awaiting_confirmation`.
   All cross-tenant writes via `withPlatformTx`; high-spend ops require JIT elevation.
7. **Test-batch**: `POST …/enrichment/test-batch` runs 25–50 rows synchronously-ish (queued, capped), returns
   per-row outcome + cost, **never** auto-commits the rest.
8. **Pick & wire the commercial email verifier** (the open decision — §6.3). Wire `REACHER_*`
   (`env.ts:110`) and `TWILIO_*` (`env.ts:117`); flip `hybridVerifier`. Keep `passThroughVerifier` as the
   no-creds fallback.
9. Provider tab: surface live waterfall order, per-provider hit-rate, breaker state.

**Phase 2 — Approve, Export, Self-Serve:**

10. Maker/checker gate on runs above the spend threshold ([`09`](./09-Review-and-Approval-System.md)).
11. Audited bulk **export** of enriched results with suppression re-check + `data:export`.
12. Surface 2 customer preview-then-commit + freshness SLA self-service.

**Phase 3+ — Govern & Scale:** Redis-shared circuit breaker (`waterfall.ts` TODO, the M12 follow-up);
CRM bidirectional enrichment sync (cross-link `docs/planning/crm-sync/00-enterprise-implementation-plan.md`,
see [`15`](./15-Future-Enhancements.md)); freshness decay model tuning.

---

## 6. UI/UX Requirements

### 6.1 Key screen — Run detail (ASCII wireframe)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Data management ▸ Enrichment ▸ Run a91f…                       [ Re-run failed ] [ Cancel ] │
│ ──────────────────────────────────────────────────────────────────────────────────────── │
│ Tenant: Northwind (ws: Sales-NA)         Status: ● awaiting_confirmation   StatusBadge      │
│                                                                                            │
│ ┌─ StatTile ─┐ ┌─ StatTile ─┐ ┌─ StatTile ─┐ ┌─ StatTile ─┐ ┌─ StatTile ──────────────┐   │
│ │ Rows       │ │ Matched    │ │ Hit-rate   │ │ Charged    │ │ Worst-case spend (est.)  │   │
│ │ 4,812      │ │ 3,944      │ │ 82.0%      │ │ $0.00      │ │ $241.60   ⚠ needs approve │   │
│ └────────────┘ └────────────┘ └────────────┘ └────────────┘ └──────────────────────────┘   │
│                                                                                            │
│ Preview (no charge / no PII revealed yet)            Provider attribution (est.)            │
│  • Eligible rows ........ 4,640                       Clearbit   58%  $0.0040/hit            │
│  • Duplicates (excluded)  172  [ Re-include ]         Apollo     27%  $0.0025/hit            │
│  • Suppressed ........... 0                           Master-gr  15%  $0.0000 (internal)     │
│                                                                                            │
│  [ ✗ Discard ]                              [ ✓ Commit run (Redeem · charges on success) ]  │
│ ──────────────────────────────────────────────────────────────────────────────────────── │
│ Tabs:  ( Rows )  Chunks   Rejects   Provenance                                  DataTable   │
│ ┌────────────────────────────────────────────────────────────────────────────────────┐    │
│ │ Row  │ Match method        │ Outcome          │ Provider │ email_status │ cost      │    │
│ │ 0001 │ deterministic_email │ matched_internal │ —        │ valid        │ $0.0000   │    │
│ │ 0002 │ provider            │ matched_provider │ Clearbit │ catch_all ⚠  │ $0.0040   │    │
│ │ 0003 │ none                │ unmatched        │ —        │ unknown      │ $0.0000   │    │
│ │ 0004 │ provider            │ error            │ Apollo   │ —            │ $0.0000   │    │
│ └────────────────────────────────────────────────────────────────────────────────────┘    │
│                                            Pagination (keyset · nextCursor)                  │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

The **Provenance** tab renders the `field_provenance` winner-map per field
([`02` §4.14](./02-Enterprise-Research.md#414-data-governance)):

```
Field        Winning value            Source     Confidence  Won by         Validated at
email        j.doe@northwind.com      Clearbit   0.94        recency        2026-06-28
title        VP Engineering           Apollo     0.88        completeness   2026-06-27
phone        +1 415 555 0142          Twilio     0.81        source-priority 2026-06-29
```

### 6.2 Components & four states

- **Components (`@leadwolf/ui`):** `Tabs`/`SegmentedControl` (Runs|Providers|Verification), `DataTable`
  + `Column<T>` (`sortValue`, `rowKey`) for runs/rows, `StatTile` for the cost/hit-rate row, `StatusBadge`
  + `StatusTone` for run/email status, `Dialog` for the commit/discard and re-run confirmations (with a
  **mandatory justification reason** like `TenantActions.tsx`), `TpButton`, `Combobox` (provider/status
  filters), `Pagination` (keyset), `Tooltip` (explain `catch_all`/`unknown` tiers), `useToast` for
  action results, `StateSwitch` wrapping every panel.
- **Loading:** `StateSwitch` → `LoadingState` / `Skeleton` rows in the table; StatTiles show skeletons.
- **Empty:** `EmptyState` "No enrichment runs yet" (Runs) / "No rejects for this run" (Rejects tab).
- **Error:** `ErrorState` reading `problemMessage(res, fallback)` (RFC-7807 `detail`/`title`); a `429`
  budget error renders a distinct "Provider budget exceeded — adjust budget in Providers" message.
- **Data:** the table + tiles above. The **Commit** button is disabled when `worstCaseCostMicros` exceeds the
  approval threshold until a checker approves ([`09`](./09-Review-and-Approval-System.md)).

### 6.3 The verifier-vendor decision (must be visible)

Verification tab shows the **active verifier** and a status taxonomy crosswalk so an operator understands a
`catch_all`/`unknown` verdict ([`02` §4.4](./02-Enterprise-Research.md#44-data-validation)):

| TruePoint `email_status` | Reacher | NeverBounce | ZeroBounce | Action |
|---|---|---|---|---|
| `valid` | safe | valid | valid | deliverable |
| `risky` | risky | accept-all/disposable | do_not_mail (some) | flag, never auto-promote |
| `catch_all` | risky (catch-all) | accept-all | catch-all | **escalate** to commercial |
| `unknown` | unknown | unknown | unknown | **escalate** / retry later |
| `invalid` | invalid | invalid | invalid | suppress from send |

Recommendation to capture: **NeverBounce or ZeroBounce** as the commercial escalation tier behind Reacher
(self-hosted, cheap first pass) — `hybridVerifier` already encodes `Reacher → commercial` escalation on
`catch_all`/`unknown`. Final vendor pick is a one-line config swap (`emailVerifier.ts` adapter); the open
work is the **commercial contract + creds**, not code.

---

## 7. Database & Backend Changes

### 7.1 Reused tables (no change)

`enrichment_jobs` (control row; `status` ladder already includes `estimating`/`awaiting_confirmation` —
`enrichmentJobs.ts:50,75`; `options` jsonb holds providers/dedup policy `:59`; `idempotency_key`
ws-unique `:60,70`), `enrichment_job_chunks`, `enrichment_job_rows` (`match_method`, `match_outcome`,
`match_confidence`, `provider_source`, `cost_micros`, `charged`, `email_status` — `enrichmentJobs.ts:124-152`),
`contacts.field_provenance` / `last_verified_at` / `email_status` / `phone_status` (`schema/contacts.ts:103`),
`accounts.field_provenance`, `provider_configs` (provider routing/budget/health), `audit_log`
(`schema/billing.ts:169`), `platform_audit_log`.

### 7.2 New columns (additive, next sequential migration 0035+)

Two additive columns on `enrichment_jobs` to drive the preview-then-commit gate and FinOps ceiling. Both are
nullable/defaulted so the migration is non-breaking and the dark engine keeps working.

```sql
-- next sequential migration (0035+, assigned at implementation)  (additive, non-breaking)
ALTER TABLE enrichment_jobs
  ADD COLUMN worst_case_cost_micros  bigint  NOT NULL DEFAULT 0,  -- pre-flight ceiling (D16)
  ADD COLUMN approval_status         varchar(20) NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  ADD COLUMN approved_by             uuid    NULL REFERENCES users(id),
  ADD COLUMN approved_at             timestamptz NULL,
  ADD COLUMN test_batch_of_job_id    uuid    NULL REFERENCES enrichment_jobs(id); -- a test batch points at its parent

-- index the staff cross-tenant "what's awaiting approval" read
CREATE INDEX idx_enrichment_jobs_approval
  ON enrichment_jobs (approval_status)
  WHERE approval_status = 'pending';
```

New table for the **freshness SLA** per workspace (decay window) — small, governance-style, mirrors how
`retention_class_policies` is global+mode-gated:

```sql
-- same sequential migration (cont.) — freshness SLA per workspace
CREATE TABLE enrichment_freshness_policies (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id)    ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reverify_after_days integer NOT NULL DEFAULT 90
    CHECK (reverify_after_days BETWEEN 7 AND 730),       -- decay window (D8/D23)
  mode              varchar(12) NOT NULL DEFAULT 'shadow'  -- disabled|shadow|enforce, like retention
    CHECK (mode IN ('disabled','shadow','enforce')),
  reverify_on_access boolean NOT NULL DEFAULT false,       -- re-verify on access (D23)
  updated_by        uuid NOT NULL REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_freshness_ws UNIQUE (workspace_id)
);
ALTER TABLE enrichment_freshness_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_freshness_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY freshness_ws_isolation ON enrichment_freshness_policies
  USING      (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
```

### 7.3 RLS posture & tx wrappers

- `enrichment_freshness_policies` is **overlay** (per-workspace) → ENABLE + FORCE RLS, isolation on
  `workspace_id` (the standard `NULLIF(current_setting('app.current_workspace_id',true),'')::uuid` idiom from
  `packages/db/src/rls/*.sql`). Customer self-service reads/writes it via **`withTenantTx`**
  (`packages/db/src/client.ts:74`) — the only scoped path.
- Staff cross-tenant reads (Runs/Providers rollups) and writes (re-run, commit, approve) go through
  **`withPlatformTx(actor, action, …)`** (`client.ts:121`) — owner connection (BYPASSRLS) that writes a
  `platform_audit_log` row **in the same transaction**. Actions: `enrichment.run.commit`,
  `enrichment.run.rerun`, `enrichment.run.cancel`, `enrichment.freshness.set`,
  `enrichment.provider.budget.set`.
- The enrichment worker reading the **master graph** for matching uses **`withErTx`** (`client.ts:56`,
  role `leadwolf_er`, no overlay grant, no GUCs). Overlay write-back of enriched fields is **`withTenantTx`**
  scoped to the run's `tenant_id`/`workspace_id` — never the request body
  ([`12`](./12-Security-and-Compliance.md)).
- `enrichment_jobs` itself is workspace-scoped (carries `tenant_id`/`workspace_id`); the staff console reads
  it cross-tenant under `withPlatformTx`, the customer reads its own under `withTenantTx`.

---

## 8. API Requirements

All routes mount under `apps/api/src/features/admin/data/enrichmentRoutes.ts` →
`/api/v1/admin/data/enrichment/*`; every route passes `authn` (Bearer) → `platformAdmin` (signed
`claims.pa===true`) → `requireStaffRole` (active role per-request) → `requireCapability(...)`. Scope is
**always** from the verified token, never the body. Customer Surface-2 routes live under
`/api/v1/enrichment/*` gated by `requireOrgRole`. Shared Zod parsed at the edge with `safeParse`; responses
re-validated with `parse`. Keyset pagination per `packages/types/src/search.ts` (`limit` 1..200 default 50,
`nextCursor` string|null). Errors are RFC-9457 problem envelopes (`middleware/error.ts`).

| METHOD path | Gate · capability | Request (Zod) | Response | Errors | Idem / Page |
|---|---|---|---|---|---|
| `GET /admin/data/enrichment/runs` | `data:read` | `{ status?, tenantId?, workspaceId?, provider?, cursor?, limit? }` | `{ runs: EnrichmentRunSummary[], nextCursor }` | — | keyset |
| `GET /admin/data/enrichment/runs/:jobId` | `data:read` | path `jobId` | `EnrichmentRunDetail` (tiles + attribution + preview) | `NotFoundError` | — |
| `GET /admin/data/enrichment/runs/:jobId/rows` | `data:read` | `{ outcome?, charged?, emailStatus?, cursor?, limit? }` | `{ rows: EnrichmentRowLedger[], nextCursor }` | `NotFoundError` | keyset |
| `GET /admin/data/enrichment/runs/:jobId/export` | `data:export` (Phase 2) | `{ format: "csv" }` | streamed CSV (bounded window) | `ForbiddenError` | — |
| `POST /admin/data/enrichment/test-batch` | `data:manage` | `{ tenantId, workspaceId, source, sampleSize:25..50, options }` | `{ jobId, rows: RowOutcome[], totalCostMicros }` | `ValidationError 422`, `SuppressedError`, `ProviderBudgetExceededError 429` | **Idempotency-Key** |
| `POST /admin/data/enrichment/runs/:jobId/estimate` | `data:manage` | path `jobId` | `{ status:"awaiting_confirmation", worstCaseCostMicros, eligibleRows, duplicateRows, providerBreakdown, estimatedHitRate }` | `NotFoundError`, `ProviderBudgetExceededError 429` | — |
| `POST /admin/data/enrichment/runs/:jobId/commit` | `data:manage` (+ checker if over threshold) | `{ reason, excludeDuplicates?:bool }` | `{ status:"running" }` | `ValidationError 422`, `ForbiddenError`, `InsufficientCreditsError 402`, `ProviderBudgetExceededError 429` | **Idempotency-Key** (money path) |
| `POST /admin/data/enrichment/runs/:jobId/rerun-failed` | `data:manage` | `{ reason }` | `{ jobId, requeued }` | `NotFoundError` | **Idempotency-Key** |
| `POST /admin/data/enrichment/runs/:jobId/{pause,resume,cancel}` | `data:manage` | `{ reason }` | `{ status }` | `NotFoundError`, `ValidationError 422` (bad transition) | — |
| `GET /admin/data/enrichment/providers` | `data:read` | — | `{ providers: ProviderHealth[], waterfallOrder, breakers }` | — | — |
| `PATCH /admin/data/enrichment/providers/:id/budget` | `providers:manage` | `{ monthlyBudgetMicros, reason }` | `ProviderConfig` | `ValidationError 422` | — |
| `GET /admin/data/enrichment/verification` | `data:read` | `{ workspaceId? }` | `{ activeVerifier, yieldByTier, freshness }` | — | — |
| `PUT /admin/data/enrichment/freshness` (Surface-2: `/enrichment/freshness`) | `data:manage` / `requireOrgRole` | `{ reverifyAfterDays:7..730, mode, reverifyOnAccess }` | `FreshnessPolicy` | `ValidationError 422` | — |

**Idempotency:** money-moving endpoints (`commit`, `rerun-failed`, `test-batch`) carry `Idempotency-Key`
(`middleware/idempotency.ts`); the DB uniques (`uniq_enrichment_jobs_ws_idempotency`, `enrichmentJobs.ts:70`)
are the real guard — a replay returns the **first** response including failures
([`02` §4.19](./02-Enterprise-Research.md#419-error-handling)).

**Queue lane:** commits enqueue on the `enrichment` queue (`enqueueEnrichment`), which is a **dedicated bulk
lane below interactive** ([`02` §4.18](./02-Enterprise-Research.md#418-queue-management)); each queue has its
`.dlq` partner; the `reverification`/`reverification-sweep` queues drive the freshness loop.

---

## 9. Edge Cases & Failure Scenarios

1. **Provider succeeds but returns invalid data** (e.g., malformed email). Waterfall `validate(r)` fails →
   **fall through** to the next provider, **no charge** for the invalid hit
   ([`02` §4.8](./02-Enterprise-Research.md#48-enrichment-pipelines)). Row shows `match_outcome=error` only if
   *all* providers fall through.
2. **Budget exhausted mid-run.** `ProviderBudgetExceededError` 429 → that provider is skipped (treated like
   an open breaker); the run completes `partial`; the console flags "budget cap hit, N rows unprocessed" and
   offers a re-run after budget bump. Never silently double-charges.
3. **Idempotent re-submit of a commit.** Same `Idempotency-Key` collapses onto the existing job
   (`uniq_enrichment_jobs_ws_idempotency`) — returns the original `running`/`completed` state, **no second
   charge**.
4. **`catch_all` / `unknown` email.** Never auto-promoted to `valid`
   ([`02` §4.4](./02-Enterprise-Research.md#44-data-validation)); `hybridVerifier` escalates to the commercial
   tier; if still ambiguous, status stays `catch_all`/`unknown` and the contact is flagged "do not bulk-send"
   downstream.
5. **Suppressed contact in a bulk run.** Eligibility stage `assertNotSuppressed` excludes it →
   `match_outcome=suppressed`, **never enriched, never charged** ([`12`](./12-Security-and-Compliance.md)).
6. **Duplicate contact selected for enrichment.** Eligibility excludes `duplicate_of_contact_id IS NOT NULL`;
   the preview reports the duplicate count and the operator confirms exclusion — **never pay to enrich a
   duplicate** ([`02` §4.23](./02-Enterprise-Research.md#423-performance-optimization),
   [`07`](./07-Deduplication-and-Linking.md)).
7. **Circuit breaker open.** `breakerOpen()` (3 consecutive errors, 60 s cooldown) → provider skipped,
   waterfall proceeds; breaker is per-process today (the Redis-shared breaker is the M12 scale follow-up — a
   second worker can still hit a flaky provider; console must caption "breaker state is per-worker").
8. **Verifier creds missing.** No `REACHER_*`/`TWILIO_*` → `passThroughVerifier`; every email returns
   `unknown`. Console shows a banner "Verification inactive — no commercial verifier wired" so a `100%
   unknown` yield is never mistaken for a data problem.
9. **Survivorship tie.** Two providers return the same field with equal confidence → deterministic tiebreak by
   source-priority then recency ([`02` §4.14](./02-Enterprise-Research.md#414-data-governance)); the
   `field_provenance` "Won by" column records the rule, so the decision is auditable.
10. **Approval expires.** A run sits `awaiting_confirmation` past the budget month → re-estimate is forced on
    commit (prices/budgets may have changed) rather than committing a stale worst-case.
11. **Master-graph matcher stub.** `masterGraphMatcher` is a STUB — identity resolution falls back to overlay
    matching only; the console must not claim a master-graph hit it didn't make (attribution shows
    `overlay`/`provider` only until the stub lands).
12. **Re-run failed slice double-counts.** Re-run targets only `match_outcome IN ('error')` rows; already
    `charged` rows are excluded so a re-run never re-bills a success.

---

## 10. Testing Strategy

- **Unit (`packages/core`):** `waterfall.ts` — stop-at-first-PASS, fall-through-on-invalid, **no charge on
  miss/invalid**, breaker open/half-open/closed transitions, `orderProviders` trust÷cost ordering
  (extend existing `waterfall.test.ts`). `estimate.ts` — worst-case spend = every row × most-expensive
  capable provider. `emailVerifier.ts` — hybrid escalation on `catch_all`/`unknown`; `passThroughVerifier`
  fallback when no creds. `reverifyContacts.ts` — decay-window selection.
- **Integration (`apps/api`):** the preview-then-commit ladder (`queued→estimating→awaiting_confirmation→
  running→completed`); `commit` charges only on `charged=true` rows; idempotent re-submit returns first
  response; `ProviderBudgetExceededError` 429 envelope shape; capability gates (a `read_only` staff cannot
  `commit`; `providers:manage` ≠ `data:manage`).
- **itest (the mandatory tenant-isolation test — data is written):** a `withTenantTx` enrichment write-back
  for workspace A is **invisible** to a `withTenantTx` read scoped to workspace B; a staff `withPlatformTx`
  commit writes a `platform_audit_log` row **in the same transaction** (assert the row exists and references
  the actor); `enrichment_freshness_policies` RLS denies cross-workspace read. This isolation test is
  **non-negotiable** for every path that writes enriched PII.
- **Note (sandbox):** `bun`/Biome/typecheck/itests run in the user's CI step (no bun/docker in sandbox); the
  diff is self-reviewed and the gates flagged.

---

## 11. Rollout & Migration Plan

| Stage | Gate | Behavior |
|---|---|---|
| **Migrate** | 0035+ additive | New columns/table land nullable+defaulted; engine unaffected. |
| **Phase 0 GA** | `data:read` capability | Read-only console; no writes, no spend. Safe to ship immediately. |
| **Verifier shadow** | wire `REACHER_*`, `hybridVerifier` behind `data_health.reverification` shadow mode | Verify in shadow — write `email_status`, **do not** change send eligibility; watch per-tier yield. |
| **Verifier canary** | one internal workspace | Flip a commercial verifier on one ws; compare yield vs shadow. |
| **Run-control canary** | `data:manage` + per-tenant flag | Enable commit/re-run for a single pilot tenant; maker/checker on > threshold spend. |
| **Freshness shadow → enforce** | `enrichment_freshness_policies.mode` shadow→enforce | Shadow computes "would re-verify N"; enforce drives the `reverification-sweep`. Graduates per-workspace like retention. |
| **GA** | flags default-on, budgets set | Full preview-then-commit; FinOps ceilings active. |

Backfill: none required for reads (ledger already populated). Optional one-time `field_provenance`
backfill for pre-engine contacts is **out of scope** here (handled in [`07`](./07-Deduplication-and-Linking.md)
survivorship). No destructive migration; rollback = disable `data:manage` and the verifier flag (engine
returns to `Dark`/`passThroughVerifier`).

---

## 12. Success Metrics & Acceptance Criteria

**Metrics ([`02` §4.20](./02-Enterprise-Research.md#420-monitoring-dashboards)):** per-run cost (charged
micros), hit-rate, provider attribution share, per-tier verification yield
(`valid`/`risky`/`catch_all`/`unknown`/`invalid`), waterfall stop-position distribution, freshness coverage
(% contacts within `reverify_after_days`), reverification yield, % spend prevented by dedupe-before-enrich,
budget-cap-hit rate.

**Acceptance criteria (testable checklist):**

- [ ] `data:read` capability exists in `staffCapability.ts`; bundled into roles; `roleHasCapability` tests
      pass.
- [ ] **Data management → Enrichment** `NavDestination` renders for staff with `data:read`, hidden without.
- [ ] Runs tab lists `enrichment_jobs` cross-tenant with status, rows, hit-rate, charged cost; keyset
      paginates; all four states (loading/empty/error/data) render via `StateSwitch`.
- [ ] Run detail shows StatTiles (rows/matched/hit-rate/charged/worst-case) and provider attribution; rows
      drill-down filters by outcome/charged/`email_status`; a `429` budget error renders the distinct message.
- [ ] **Charge only on success**: an integration test proves a provider miss/invalid leaves `charged=false`
      and `cost_micros=0`.
- [ ] **Preview-then-commit**: estimate returns `awaiting_confirmation` + `worst_case_cost_micros` with **no
      charge / no PII reveal**; commit transitions to `running` and charges only `charged=true` rows.
- [ ] **Test batch** (25–50 rows) returns per-row outcome + cost and never auto-commits the remainder.
- [ ] **Dedupe-before-enrich**: preview reports duplicate count; excluded duplicates are never charged.
- [ ] Provider tab shows live waterfall order, per-provider hit-rate, and breaker state.
- [ ] Verification tab shows the active verifier; when no creds, a "verification inactive" banner appears and
      yield is correctly attributed (not mistaken for a data fault).
- [ ] Provenance tab renders `field_provenance` per-field winner-map (value/source/confidence/won-by).
- [ ] **Audited writes**: every staff commit/re-run/cancel/freshness-set writes a `platform_audit_log` row in
      the same `withPlatformTx` transaction.
- [ ] **Tenant-isolation itest** passes: workspace-A enrichment write-back invisible to a workspace-B
      `withTenantTx` read; `enrichment_freshness_policies` RLS denies cross-workspace access.
- [ ] **Idempotency**: a replayed commit returns the first response with no second charge.
- [ ] Surface-2 customer panel enforces `requireOrgRole` and `withTenantTx` (own workspace only), with its own
      preview-then-commit.

---

### Cross-references

- [`01-Current-State-Analysis`](./01-Current-State-Analysis.md#54-enrichment--engine-shipped---learning-stubs)
  — engine `Shipped`, verification `Dark`, freshness `Inert`.
- [`02-Enterprise-Research`](./02-Enterprise-Research.md) — D4, D8, D10, D11, D14, D16, D18, D19, D23.
- [`03-Gap-Analysis`](./03-Gap-Analysis.md) · [`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md)
  (nav group) · [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) (dedupe-before-enrich) ·
  [`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) (maker/checker spend gate) ·
  [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) (run dashboards) ·
  [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) (`data:*`) ·
  [`12-Security-and-Compliance`](./12-Security-and-Compliance.md) (suppression, residency) ·
  [`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) (bulk lane, breakers at scale) ·
  [`15-Future-Enhancements`](./15-Future-Enhancements.md) — CRM bidirectional enrichment sync
  (`docs/planning/crm-sync/00-enterprise-implementation-plan.md`).
- FinOps / cost ceilings: [`truepoint-operations`](../../../.claude/skills/truepoint-operations/SKILL.md).
