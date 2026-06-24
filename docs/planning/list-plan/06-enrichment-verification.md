# List Tab — Enrichment & Verification (06)

> **Status:** Plan (not yet built). **Owner:** Data + Platform. **Last updated:** 2026-06-24.
> Cites the **Locked Decisions (D1–D5)** and **Shared Vocabulary** in `00-overview.md` verbatim and must
> not contradict them. This doc covers **work-the-list** enrichment, verification, data-health, the money
> rules, bulk-on-a-list, and the isolation guarantee for everything a customer enriches.
>
> **Skills consulted (per root `CLAUDE.md`):** `truepoint-data` (enrichment/verification/the model),
> `truepoint-platform` (queues, tenancy, the write path), `truepoint-security` (isolation, untrusted input,
> spend abuse), `truepoint-design` (cost-before-spend UX, the four states). Read those `SKILL.md`s before
> building any unit here.

---

## 1. What exists today (build on this, don't reinvent)

The enrichment subsystem is **already built** at M4 volume; the List tab **surfaces and wires** it, it does
not author a new engine. Ground truth from the code:

- **Provider waterfall + trust/cost** — `packages/integrations/src/enrichment/providers.ts` ships three
  first-wave adapters with static **trust** and **per-call cost**: Apollo (`trust 0.8`, `$0.03`/call),
  ZoomInfo (`trust 0.85`, `$0.06`/call), Clearbit (`trust 0.7`, `$0.02`/call). `defaultProviders()` is the
  configured set; **order is decided by core's waterfall** (`trust ÷ cost`), never array order. An absent
  API key makes an adapter a permanent `miss` (it never throws on config).
- **The waterfall itself** — `packages/core/src/enrichment/waterfall.ts`: `orderProviders` sorts by
  `trust ÷ estimateCostMicros`, `runWaterfall` calls in order until the first **hit**, **per-process circuit
  breakers** (3 consecutive errors → open, 60 s cooldown, half-open probe) skip a failing provider, and a
  thrown adapter error degrades to a zero-cost `error` status. A **parallel-cheap** variant
  (`runWaterfallBulk`) races sub-threshold providers concurrently and falls through to the expensive ones —
  the cost-disciplined bulk path.
- **The orchestration** — `packages/core/src/enrichment/enrichContact.ts`: one `withTenantTx`, in strict
  order **(1) cache-first → (2) daily budget breaker → (3) waterfall → (4) persist (overlay upsert +
  `source_imports` provenance + `provider_calls` cost row)**. Crucially, the header states **"Enrichment is a
  SYSTEM cost — users pay only on reveal."** Enrichment fills the overlay; the **reveal** is the chargeable
  unmask (D5).
- **Cache (the `provider_calls` request hash)** — `requestHash(request)` over `{workspace, entity, fields,
  subject}`; `providerCallRepository.findCached` answers a repeat with **no call and no cost**. The cache is
  **workspace-scoped** (the hash is keyed on `workspaceId`), consistent with D1.
- **Budget breaker** — `providerCallRepository.spendSince(startOfUtcDay)` vs
  `env.ENRICH_DAILY_BUDGET_MICROS`; over budget throws `ProviderBudgetExceededError` **before any paid call**.
  This is the **daily** breaker; the waterfall breaker is the **per-provider** one.
- **Auto-enrich policy gate (G-ENR-1)** — for **system-initiated** runs (a `trigger` is set), `policy.ts`
  enforces the per-workspace auto-enrich policy first: trigger must be enabled, fields are narrowed to an
  allowlist, the run is skipped at the monthly budget cap. A **manual** enrich (no trigger) bypasses the gate
  exactly as before — additive.
- **The chunked `enrichment_jobs` ledger** — `packages/db/src/schema/enrichmentJobs.ts`: a control row
  `enrichment_jobs` (one per job; `status ∈ {queued, estimating, awaiting_confirmation, running, paused,
  completed, failed, cancelled}`, `total/processed/matched/enriched/charged` row counters,
  **`credit_estimate_micros`** and **`credit_spent_micros`**, `idempotency_key` with a per-workspace unique
  index), `enrichment_job_chunks` (the claimable contiguous row band a runner works), and the high-volume
  per-row ledger `enrichment_job_rows` (`match_method`, `match_outcome`, `matched_contact_id` /
  `matched_master_person_id`, `match_confidence`, `enriched_fields`, `provider_source`, `cost_micros`,
  **`charged`**, `email_status`). The row ledger **reuses the exact `contacts.email_status` closed set**, so
  a bulk verdict stays comparable to a contact's.
- **The bulk-enrich endpoint** — `apps/api/src/features/contacts-bulk/routes.ts`
  `POST /contacts/bulk/enrich` → `bulkEnrich` (core), returns **`{ affected, jobId }`**. Selection is
  **exactly-one-of `{ contactIds }` or `{ criteria: ContactQuery }`** (select-all-across-search), resolved to
  **visible** ids in core, capped at `BULK_SELECTION_CAP`. The single-contact path is
  `POST /enrichment/contact/:id`; job status is the **read-only** `GET /enrichment/jobs[/:jobId]` surface
  (G-ENR-4). Scope is taken from the **verified token**, never the body (`08 §security`).
- **Data-health scoring** — `packages/core/src/data-health/dataQualityScore.ts`: the pure `0–100`
  `data_quality_score` (`0.4·completeness + 0.3·verification + 0.3·freshness`) with cold-start re-weighting,
  per-field freshness SLAs (email 90 d, phone 180 d, employment 60 d, firmographics 180 d, intent 30 d),
  `freshness_status ∈ {fresh, aging, stale, expired}`, and a `verificationSubScore` (`valid=1`,
  `catch_all/unknown=0.5`, `invalid=0`, `unverified→excluded`). This is the math the data-health column reuses.
- **Match-first is STUBBED (ADR-0037).** The match-first port exists — `matchPort.ts` (contract),
  `overlayMatcher.ts` (**real now**), `masterGraphMatcher.ts` (**stub now**, real when the M12/M13 scale infra
  lands) — and `bulk/estimate.ts` already prices a run from a sample. But `bulkEnrich` in
  `prospect/bulkActions.ts` today only **creates a job** (`mode: 'bulk_reverify'`, `contactIds`) and returns;
  the worker that *runs* match-first → waterfall on a list selection is the work this plan wires in **Phase 3**.

> **Implementation status.** Today's `bulkEnrich` enqueues a job but **does not yet run the match-first →
> waterfall pipeline through the job rows**, and `masterGraphMatcher` is a stub (overlay-only matching). The
> mandates below are the **target**; the gap is Phase-3 work, never a license to skip a rule (especially D1/D5).

---

## 2. Match-first → waterfall (the model)

Per **D1 (match-against, contribute-to OFF)** and **ADR-0037**, an enrich on a list member resolves
**match-first**, paying a provider only on the residual. The order is strict and short-circuiting — the first
confident stage wins (`matchPort.ts`, `enrichContact.ts`):

1. **Workspace overlay match — `overlayMatcher.ts` (real now), free + instant.** Blind-index / exact match of
   the normalized keys against the calling workspace's own Layer-1 overlay (`(workspace_id,
   email_blind_index)`, `linkedin_public_id`, E.164 phone, registrable domain → account). The workspace
   already owns this record → **dedup/link for free**, outcome `matched_internal`, `match_confidence = 1.0`.
2. **Global master-graph Layer-0 candidate match — `masterGraphMatcher.ts` (stub now, real at M12/M13).**
   A **read against the already-resolved master graph** (Redis KV deterministic lookup for the ~95% common
   case; blocking + MinHash/LSH + Splink for the `fuzzy_name_company` tail) — **not** a re-resolution. Free +
   instant, outcome `matched_internal`. Until the scale infra lands this returns `unmatched` and falls
   through, **with no caller change** when the real matcher drops in (the seam pattern). A fuzzy match below
   the accept threshold sets `needsReview` and stays `unmatched` (never silently merged, never billed).
3. **Provider waterfall on residual misses only — `runWaterfall(Bulk)` (`waterfall.ts`).** Only rows that
   missed both internal layers fan out to paid providers in **`trust ÷ cost` order (A→B→C)** with the circuit
   breakers. Enrichment is **field-level**: the waterfall fills each requested `EnrichField`
   (`email | phone | jobTitle | seniorityLevel | department`) and the next provider can supply a field an
   earlier one missed (field-level fallback), so a partial earlier hit doesn't waste the residual. A provider
   hit is `matched_provider` — the **only** outcome that spends credits (ADR-0038); a provider miss is
   `unmatched`.

**Canonical normalization (shared with the global ER pipeline — no drift, ADR-0037):** email → lowercased,
plus-addressing stripped, blind-indexed; domain → registrable via the Public Suffix List; phone → E.164 via
libphonenumber; name canonicalized; LinkedIn → public id. The **same** keys a row matches on in bulk are the
keys it would match on in batch.

**Why match-first is the model, not provider-first.** Multi-source resolution materially out-matches a single
provider: industry figures put a **multi-source / waterfall coverage at ~85–95%** against **~50–60% for a
single source** (`01-research-summary.md`; per-channel ADR-0037 figures: ~70–85% on email, ~50–65% on phone,
~85–95% on company — *approximate industry figures, not a TruePoint promise*). Internal matches are an
**indexed read of data the workspace already owns** — no network, no rate limit, **no spend** — so most rows
on a typical list resolve free and instantly, and only the genuine residual costs provider money. That is what
makes a "work-the-whole-list" enrich both fast and cheap.

> **Note.** While `masterGraphMatcher` is a stub, only **stage 1 (overlay)** matches internally; Layer-0-only
> rows fall through to providers, so early in-list match-rate (and cost) trends toward provider-first for
> non-overlay rows. This is the consciously-accepted ADR-0037 gap, not a defect — the overlay matcher is real
> from day one and the stub falls through **safely** to the proven waterfall.

---

## 3. Verification & data health

Verification is **field correctness/currency**, never lead quality (`dataQualityScore.ts` header — never
conflate). Per-member it has three parts.

### 3.1 Email verification (syntax → MX → SMTP)

A staged check producing the **canonical closed status** (`contacts.email_status` /
`enrichment_job_rows.email_status`, identical sets):
`valid | risky | invalid | catch_all | unverified | unknown`.

| Stage | Rejects/labels |
|---|---|
| **Syntax** | malformed local/domain → `invalid` |
| **MX / domain** | no MX, dead domain → `invalid`; disposable/role → `risky` |
| **SMTP probe** | mailbox confirmed → `valid`; mailbox rejects → `invalid`; server accepts-all → `catch_all`; greylist/timeout/blocked → `unknown` |

`risky` is borderline-deliverable (charged per policy, ADR-0013); `unverified` is the pre-check default;
`unknown` is "couldn't confirm either way". The verification sub-score (`dataQualityScore.ts`) reads exactly
these: `valid=1`, `catch_all/unknown=0.5`, `invalid=0`, `unverified→excluded from the mean` (an unrun check is
not punished).

### 3.2 Phone status & confidence

`contacts.phone_status` (the `direct/mobile/hq/valid` vs `invalid/unknown` family per ADR-0013) is set on
verification. Each verified field also carries a **confidence** — for matched data, the
`enrichment_job_rows.match_confidence` (`1.0` deterministic, a Splink score on the fuzzy tail).

### 3.3 The data-health column on the list

The list-detail members table (`04-list-workspace-ui.md`) carries a **Data Health** column powered by
`computeContactDataQuality` (non-PII, safe on the masked DTO): the `0–100` score + a `freshness_status` badge
(`fresh/aging/stale/expired`) + the email/phone status. It is **read-side, derived** — no schema needed beyond
the existing `email_status`/`phone_status` and a last-verified age.

> **Implementation status / gap.** `computeContactDataQuality` takes `ageDaysSinceVerified`, but `contacts`
> has **no `last_verified_at` column today** (only `revealed_at`, `last_activity_at`, `updated_at`). Phase 3
> must add a **`last_verified_at`** (and, if surfaced, a denormalized `data_quality_score`/`freshness_status`
> cache, mirroring `priority_score`) or freshness defaults to cold-start "aging". Tracked here, not skipped.

### 3.4 Staleness, decay & re-verification cadence

Contact data **decays continuously** — email at roughly **~2.1%/month** (`01-research-summary.md`), so a list
left untouched silently rots. Re-verification is therefore a **cadence**, not a one-time action:

- **Freshness SLAs** (`dataQualityScore.ts` `FRESHNESS_SLA_DAYS`): email 90 d, phone 180 d, employment 60 d.
  The continuous decay curve degrades the freshness sub-score linearly to 0 by `1.5×SLA` (the `expired` band).
- **Cadence:** a **monthly re-verification** sweep for **active lists** (members in a sequence / touched in
  the window), and an SLA-driven re-verify for the rest — prioritizing `stale`/`expired` members. This is the
  **freshness sweep** (`dataQualityScore.ts §4` re-verify priority); for a list it runs as the same chunked
  job as a manual re-verify, surfaced as a "X members need re-verification" affordance on the list.
- **Re-verify ≠ re-charge.** Re-running verification on already-owned overlay data is a **system cost** (it
  hits the cache / re-probes, it does not re-reveal) — no credit is spent to keep a member fresh. New paid
  provider data only enters via the residual waterfall, gated by the money rules (§4).

### 3.5 Bounce handling

A **hard bounce** (SES SNS→SQS feedback, ADR-0013, `08 §security-compliance`) flips the member's
`email_status` to `invalid`, drops its freshness/quality, and — if the email was a **charged `valid` reveal
within the guarantee window** — triggers the **credit-back** (§4). A bounce is also a **suppression signal**:
the address is suppressed so it is not re-enriched/re-revealed into the same dead mailbox.

---

## 4. Money rules (D5, ADR-0013)

D5 is **inherited, not reinvented**: reveal is per-workspace **first-wins, idempotent, suppression-gated**;
**charge only for matched/valid data**; **credit-back on hard bounce**; **always show cost + estimate before
spend**. Enrichment fills the overlay (system cost); the **reveal** is what bills.

### 4.1 Charge only for matched/valid data

Per ADR-0013, the charge is a **function of the verified result**, decided **inside the reveal transaction**:

| Verified result | Charge |
|---|---|
| email `valid` | full cost |
| email `invalid` / `catch_all` / `unknown` / provider-miss | **0 credits** (a `contact_reveals` row is still written with `credits_consumed = 0` so the user sees the empty outcome) |
| email `risky` | charged per policy, flagged borderline-deliverable (default: charge) |
| phone resolved (`direct`/`mobile`/`hq`/`valid`) | full cost |
| phone `invalid` / `unknown` | **0 credits** |

In bulk terms (ADR-0038): only **`matched_provider` valid** rows spend credits; `matched_internal` and
`unmatched` rows contribute **0** to spend. The `enrichment_job_rows.charged` flag and the
`enrichment_jobs.charged_rows` counter record exactly which rows billed.

### 4.2 Credit ESTIMATE before run (mandatory, D5)

Before a bulk enrich/reveal runs, the job enters **`estimating` → `awaiting_confirmation`** and shows a
**credit estimate** the user must confirm. The estimate (`bulk/estimate.ts`) runs a **bounded random sample**
(~1,000 rows or 1%) through the match-first path **but STOPS before any paid reveal**, measures the internal
match-rate, then extrapolates: `expected charged rows ≈ residual × provider expected-valid-rate`, priced at
the per-match credit model. It is a **range estimate, never a guarantee** (it depends on live provider
hit/verify rates). The result is persisted to `enrichment_jobs.credit_estimate_micros`; actual spend
accumulates in `credit_spent_micros`. **No bulk action spends a credit without showing this first** — the
design surface (`truepoint-design`) renders the estimate, the affected count, and the post-spend balance.

### 4.3 Credit-back on hard bounce (guarantee window)

A charged `valid` email that **hard-bounces within the guarantee window** is **automatically credited back**
(ADR-0013): an **audited** counter increment on `tenants.reveal_credit_balance` via the
`credit.adjust` audit action. The window is a bounded placeholder (`07-billing-credits`); leakage/abuse is
tracked and is the explicit *revisit-if* trigger for an append-only ledger (ADR-0007).

### 4.4 First-reveal-wins & idempotency (per-workspace)

Reveal ownership is **per-workspace first-wins** and **immutable** (`contacts.revealed_by_user_id` /
`revealed_at`, the AFTER-INSERT trigger; the `contacts_reveal_owner` CHECK keeps `is_revealed ⇔
revealed_by_user_id IS NOT NULL`). A second reveal of an already-revealed member in the same workspace is a
**no-op, no double charge**. Bulk runs are **idempotent** via `enrichment_jobs.idempotency_key` (per-workspace
unique index) — a re-submit of the same upload **collapses onto the existing job** rather than re-spending.
Suppression (DNC/consent, bounce) gates the reveal: a suppressed identity yields `suppressed`, never a billed
reveal.

---

## 5. Bulk on a list (work-the-list)

The list-detail bulk-action bar reuses the **prospect bulk framework** (`contacts-bulk/routes.ts` +
`prospect/bulkActions.ts`), so enrich / re-verify / reveal / assign-owner / tags / status / archive / export
all work on a list selection. The list adds a **third selection shape** on top of the existing
`{ contactIds } | { criteria }`:

- **`{ listId }`** — the whole list (resolved to its visible `list_members` in core, scoped + masked).
- **`{ contactIds }`** — an explicit member selection (the checkbox set).
- **`{ criteria }`** — select-all-across a filtered list view (capped at `BULK_SELECTION_CAP`).

Every endpoint returns an **`affected` count** (and enrich/reveal additionally a **`jobId`**). Per
`00 §metrics`, bulk-action **affected-count accuracy must be 100%** — counts reflect only **visible**
(workspace-scoped, non-suppressed, in-list) members, resolved server-side; the client's list/contact ids are
**never trusted** (`08 §security`).

- **Enrich / re-verify** → async **chunked job** (`enrichment_jobs` + `_chunks` + `_rows`), so a 10k-member
  list streams through the same partitioned pipeline as a CSV import (`03 §import`). The
  `GET /enrichment/jobs[/:jobId]` surface drives a **progress UI** (processed/matched/enriched/charged) and a
  **surfaced job history** on the list (the read-only G-ENR-4 surface). Long-running spend stays on the
  **worker queue**, never the request path.
- **Reveal (single + bulk)** → the per-workspace first-wins reveal (§4.4), estimate-gated (§4.2),
  suppression-gated, credit-back-eligible (§4.3).
- A new list bulk action sets `list_members.added_via`/audit appropriately; the customer-visible `audit_log`
  records the bulk action (`09 §Phase 0`). The bulk-enrich path itself is **not** in the closed audit-action
  enum today (noted in `bulkActions.ts`) — the **job ledger** is its record of truth.

---

## 6. Isolation (D1) — match-against only

**Nothing a customer enriches contributes to the shared graph.** This is **D1**, **ADR-0021**
(`match-against ≠ contribute-to`, co-op OFF by default), and it is enforced by the existing code, not a new
promise:

- **Match-against, never contribute-to.** Stages 1–2 of §2 are **reads** — the overlay matcher reads the
  workspace's own rows; the master-graph matcher does a **read against already-resolved clusters**. Neither
  writes anything a customer uploaded/enriched back into Layer-0. There is **no co-op ingestion path** in this
  plan (`00 §out-of-scope`).
- **Provider responses land only in the customer's overlay.** `enrichContact.ts` persists the winning payload
  via `contactRepository.update` (the **workspace's** overlay row) + `source_imports` provenance +
  `provider_calls` (workspace-scoped) — all inside one `withTenantTx`. The **cache key is workspace-scoped**
  (`requestHash` includes `workspaceId`; `findCached` is per-workspace), so one workspace's enriched payload
  is **never served to another**.
- **The hard boundary is Postgres RLS (D4).** Every enrichment/verification write goes through `withTenantTx`
  (`app.current_workspace_id` GUC), with FORCE RLS where the writer is `leadwolf_app`. The
  `enrichment_job_rows` table is **denormalized with its own `workspace_id`** precisely so RLS applies
  directly on the high-volume ledger. List ownership is a **filter**, not an access wall (D4).
- **The proof is a test, not an assertion.** The Phase-0/Phase-5 **isolation-guarantee itest**
  (`09 §verification`) must include enrichment: two workspaces enrich/verify/reveal overlapping subjects and
  assert that **no enriched value, cache hit, or job row crosses `app.current_workspace_id`**, and that
  nothing written by a customer enrich appears in any Layer-0/shared structure.

---

## 7. Cross-references

- **`03-upload-and-import.md`** — **enrich-on-import**: the import wizard's optional **match-first enrichment**
  on landed rows uses this exact pipeline (`enrichment_jobs` ledger, estimate-before-run, match-first →
  waterfall). The in-list bulk enrich (here) and enrich-on-import share the engine; they differ only in the
  entry point (`source_file: 'bulk-reenrich'` vs the uploaded file).
- **`05-prospect-to-list.md`** — reveal-from-Prospect → add-to-list lands members already revealed; this doc
  is what then **re-verifies and keeps them fresh** on the list, and what enriches members added via import.
- **`08-security-compliance.md`** — RLS/encryption details, the SES bounce → suppression → credit-back wiring,
  DNC/suppression gating, scope-from-verified-token, and the residency/PII handling for provider responses.
- **`04-list-workspace-ui.md`** — where the Data Health column, the estimate/confirm modal, the four states,
  and the job-progress/history UI render (`truepoint-design`).
- **`09-rollout-phases.md`** — this is **Phase 3** (work-the-list bulk ops + match-first enrich + estimate +
  credit-back), work-unit **#10** (`enrichment` slice). The freshness sweep/cadence touches the worker units.
