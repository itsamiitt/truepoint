# Phase 0 — Current-State Audit & Constraints (prospect↔company data model)

> **Gate: RESEARCH.** Phase 0 of the prospect↔company data initiative. This is the unambiguous
> baseline every later phase (BRAINSTORM, PLAN, the Layer-0 build, the per-field-provenance design)
> builds on. It depends on no sibling doc — it is the first artifact in this folder. Ground truth:
> the shipped Drizzle schema + core pipeline code (cited `file:line`), `03-database-design.md` §5/§9/§11/§12,
> and ADR-0021 / ADR-0006 / ADR-0007 / ADR-0015 / ADR-0037 / ADR-0039. It is an **internal audit**:
> what is *built in code*, what is *planned in docs but unbuilt*, and what is *undesigned anywhere*.
> No code, schema, SQL, or settings are modified by this gate — only this file is written.

---

## 0. Method & how to read this

Every "BUILT" claim below points at a shipped source line. Every "PLANNED" claim points at a doc/ADR
that specifies a target with no corresponding code. Every "UNDESIGNED" claim is a true gap — neither
code nor a doc defines it — and is the invention surface for later phases. The three states are kept
strictly distinct because the whole initiative is the act of closing the BUILT→PLANNED→UNDESIGNED
distance for the **prospect↔company edge** and **field-level provenance**.

The verified package layout: `packages/db/src/schema/*.ts` are the Drizzle table defs (21 schema files,
`schema/index.ts` registers them); `packages/db/src/rls/*.sql` are the idempotent RLS/trigger files;
`packages/core/src/` holds the import + enrichment + dedup pipeline. Grep confirms **no
`master_persons` / `master_companies` / `master_employment` / `master_emails` table or repository
exists anywhere in the codebase** — Layer 0 is 100% docs.

---

## 1. The target in one paragraph, and the headline gap

ADR-0021 (Accepted 2026-06-09) defines a **two-layer** model: **Layer 0**, a system-owned, not-RLS-scoped
global master graph (`master_persons`, `master_companies`, `master_employment`, `master_emails`,
`master_phones`, `source_records`, `match_links`); and **Layer 1**, the existing per-workspace
`contacts`/`accounts` re-cast as RLS-scoped *overlays* that each carry a `master_person_id`/`master_company_id`
back-reference (ADR-0021 Decision; `03-database-design.md:379-557`). The prospect↔company link is meant to
live in `master_employment` — a person↔company edge with title/dates/`is_current`, resolved by
email-domain → `master_companies.primary_domain` (`03-database-design.md:428-436`).

**What is actually built is Layer 1 only, and not even the overlay's master back-reference.** The headline gap:

| Concern | TARGET (ADR-0021 / 03 §5) | BUILT today | State |
|---|---|---|---|
| Global golden universe | Layer-0 `master_*` tables | nothing | **planned, unbuilt** |
| Overlay → master link | `contacts.master_person_id`, `accounts.master_company_id` (03 §5.2) | absent from `contacts.ts`/`accounts.ts` | **planned, unbuilt** |
| Prospect↔company link | `master_employment` edge (history + multi-affiliation + edge provenance) | single `contacts.account_id` FK | **built, but degenerate** |
| Identity resolution | global cross-source Splink ER + survivorship | per-workspace soft-pointer dedup + deterministic keys | **built within-workspace; global unbuilt** |
| Provenance | `source_records` lineage + per-field source/confidence/timestamp | batch/job-level `source_imports` only | **built batch-level; per-field undesigned** |
| Scale topology | Citus + OpenSearch + ClickHouse + S3/Iceberg + Splink-on-Spark | single Aurora + Typesense (overlay) | **planned, unbuilt** |

The rest of this doc is the precise version of each row.

---

## 2. Prospect & company entities that exist TODAY (code)

### 2.1 `accounts` — companies, workspace-scoped (`packages/db/src/schema/contacts.ts:41-89`)

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | `uuid_generate_v7()` (`contacts.ts:28`) |
| `tenant_id` | `uuid NOT NULL` | FK → `tenants.id` cascade (`:31-34`) — denormalized for RLS/billing |
| `workspace_id` | `uuid NOT NULL` | FK → `workspaces.id` cascade (`:35-38`) — **the RLS key** |
| `name` | `varchar(255) NOT NULL` | |
| `domain` | `citext` (nullable) | **the per-workspace account dedup key** (`:48`) |
| `linkedin_company_url`, `sales_nav_account_url` | `varchar(500)` | |
| `industry`, `sub_industry`, `revenue_range`, `hq_country`, `hq_city`, `funding_stage`, `company_stage` | `varchar` | firmographic facets |
| `employee_count`, `founded_year`, `icp_fit_score` | `integer` | `icp_fit_score` CHECK 0–100 (`:75-78`) |
| `technologies` | `jsonb` `[]` | GIN-indexed (`:81`) |
| `custom_fields` | `jsonb` `{}` | GIN-indexed (`:79`), shallow-merge (ADR-0028) |
| `created_at`, `updated_at` | `timestamptz` | `updated_at` by trigger (`rls/contacts.sql:23-25`) |

- **Dedup key (the only one):** partial unique `uniq_accounts_ws_domain` on `(workspace_id, domain) WHERE domain IS NOT NULL` (`contacts.ts:72-74`). Companies without a domain are **not** deduplicated at all.
- **No** `master_company_id`, `owner_user_id`, `assigned_team_id`, `visibility`, `data_quality_score`, `name_normalized`, `alt_domains`, `parent_company_id` — all of which the 03 §5.2 / ADR-0021 / ADR-0022 / ADR-0025 target defines (`03-database-design.md:491-511`). Accounts are firmographic facets + a domain key, nothing more.

### 2.2 `contacts` — people, workspace-scoped, masked until reveal (`contacts.ts:92-207`)

| Column group | Columns | Notes |
|---|---|---|
| Identity/PK | `id` (v7), `tenant_id`, `workspace_id` | `workspace_id` = RLS key |
| **Company link** | `account_id uuid → accounts.id ON DELETE SET NULL` (`:98`) | **the entire prospect↔company link** — see §3 |
| Ownership | `owner_user_id → users.id SET NULL` (`:103`), `revealed_by_user_id` (`:129`), `is_revealed`/`revealed_at` (`:128-130`) | soft owner ≠ first-reveal credit owner |
| PII (encrypted) | `email_enc`, `email_blind_index`, `phone_enc` (`bytea`) | masked until reveal; `email_domain citext` kept clear as facet (`:106-117`) |
| Person attrs | `first_name`, `last_name`, `job_title`, `seniority_level`, `department`, `location_country/city` | `seniority_level` CHECK enum (`:169-172`) |
| External ids | `linkedin_url`, `linkedin_public_id`, `sales_nav_profile_url`, `sales_nav_lead_id` | dedup keys (below) |
| State | `email_status` (CHECK enum, `:165-168`), `phone_status`, `outreach_status` (CHECK, `:173-176`), `priority_score` (0–100), `pipeline_stage_id` (`:125`) | |
| Freshness | `last_verified_at` (`:135`) | drives the freshness sub-score; NULL = never verified |
| Dedup pointer | `duplicate_of_contact_id` self-FK (`:141-146`) | set by the dedup worker — **soft pointer, never a merge** |
| Compliance | `deleted_at` (DSAR tombstone, `:147`), `jurisdiction`, `region` | |
| Custom | `custom_fields jsonb` GIN (`:150,187`) | |

- **Three per-workspace dedup keys (partial unique):** `(workspace_id, email_blind_index)`, `(workspace_id, linkedin_public_id)`, `(workspace_id, sales_nav_lead_id)`, each `WHERE … IS NOT NULL` (`contacts.ts:156-164`). These guarantee one contact per identity key **per workspace** — never globally.
- **Reveal invariants** as CHECK constraints: `is_revealed = (revealed_by_user_id IS NOT NULL)` and `… = (revealed_at IS NOT NULL)` (`:182-186`), enforced atomically with the first-reveal trigger (`03-database-design.md:705`).
- **No** `master_person_id`, `assigned_team_id`, `visibility`, `data_quality_score`, `freshness_status` — present in the 03 §5.2 target (`03-database-design.md:513-556`) but absent from code. `owner_user_id` and `last_verified_at` **are** built; the rest of the ownership/visibility/quality block is not.

### 2.3 `source_imports` — per-import provenance (`contacts.ts:212-245`)

The **only** lineage that exists today. One row per landed contact per import: `contact_id` (FK cascade,
`:218-220`), `imported_by_user_id`, `source_name` (CHECK enum: apollo|zoominfo|linkedin|sales_navigator|hubspot|salesforce|clearbit|manual, `:240-243`), `source_file`, `raw_data jsonb`, `content_hash bytea`, `imported_at`.

- **Idempotency:** partial unique `(workspace_id, content_hash) WHERE content_hash IS NOT NULL` (`:230-232`) — identical re-imports are no-ops.
- This is **batch/row-level** provenance: "this whole contact came from this import payload." It is **not** field-level — see §5. The 03 §5.2 target adds an `import_job_id` FK for revert-by-batch (`03-database-design.md:562`); the code row has no `import_job_id`.

### 2.4 Satellite tables that hang off a contact (for completeness)

- **`scores`** (`intel.ts:40-61`), **`intent_signals`** (`:64-85`): append-per-rescore + typed/weighted signals, both `contact_id`-scoped; a trigger syncs `contacts.priority_score`.
- **`provider_calls`** (`intel.ts:88-114`): the enrichment cache/cost ledger, unique `(workspace_id, request_hash)` (`:104`), `cost_micros`, `cache_hit`. **`provider_configs`** (`:120-127`) is platform-global config (no secrets).
- **`lists` / `list_members`** (`lists.ts:35-114`): workspace-scoped collections; `list_members` unique `(list_id, contact_id)` (`:108`), per-member provenance `added_via` + `source_import_id` (`:97-103`).
- **`enrichment_jobs` / `enrichment_job_chunks` / `enrichment_job_rows`** (`enrichmentJobs.ts`): the bulk-CSV ledger. The per-row ledger carries `match_method` + `match_outcome` (CHECK enums `:142-149`), `matched_contact_id` (FK, overlay hit), and — notably — **`matched_master_person_id uuid` with no FK** (`:129`, comment: *"cross-workspace master graph (no FK in Wave 1)"*). This is the single place a `master_person_id` is referenced anywhere in code, and it is a soft, nullable, target-less column. This matches the 03 §5.3 note that it is a *soft reference into the system-owned Layer-0 graph* (`03-database-design.md:667-669`).

---

## 3. The prospect↔company link TODAY — and its four structural limits

The link is one nullable FK: `contacts.account_id → accounts.id ON DELETE SET NULL` (`contacts.ts:98`).
It is populated by the import pipeline's **upsert-by-domain** step.

```
  ┌────────────┐   account_id (nullable, SET NULL)   ┌────────────┐
  │  contacts  │ ───────────────────────────────────►│  accounts  │
  │ (a person) │   exactly ONE company, no history    │ (a company)│
  └────────────┘                                      └────────────┘
        ▲  workspace-scoped, RLS                              ▲
        └──── both isolated by workspace_id ─────────────────┘
            (no master_*_id on either side today)
```

**How it is set (`packages/core/src/import/runImport.ts:204-219`, `accountRepository.upsertByDomain` `accountRepository.ts:26-42`):**
per row, *if* a registrable account domain is present, the importer upserts the company on
`(workspace_id, domain)` with `ON CONFLICT DO UPDATE SET name=…` and links the returned `accountId` onto the
contact. A domainless company row is **skipped** (`AccountUpsertInput.domain` is required, comment at
`accountRepository.ts:20-21`; importer guards `if (prepared.accountDomain)` at `runImport.ts:205`), so such a
contact carries `account_id = NULL`.

**The four limits this design imposes (each is a thing a later phase must fix):**

1. **No employment history.** The edge is a single current pointer. There is no `started_on`/`ended_on`/`is_current`, so a job change overwrites — the prior affiliation is lost. The target `master_employment` carries current **+ past** edges (`03-database-design.md:428-436`).
2. **No multi-affiliation.** A person at two companies (advisor, dual role, contractor) cannot be represented — `account_id` is 1:1. `master_employment` is many-to-many per person.
3. **No edge provenance.** Title/department/seniority live **on the contact row**, not on the edge — there is no record of "*this title came from this source at this company as of this date*." The edge itself carries no source, confidence, or timestamp. (Edge-level provenance is **undesigned anywhere** — see §5 / §7.)
4. **Per-workspace, no shared company identity.** `accounts` dedups only within a workspace and only by exact domain. The same company appears as N unrelated rows across N workspaces, and domainless or alt-domain variants (`stripe.com` vs `stripe.dev` vs an acquired brand) are distinct rows even inside one workspace. The target `master_companies` has `primary_domain` + `alt_domains[]` + `name_normalized` + `parent_company_id` (`03-database-design.md:390-407`).

The strongest link key the target wants — email-domain → company `primary_domain` via the Public Suffix List
— **is already computed in code** (`registrableDomain` via `tldts`, `matchKeys.ts:74-81`; `normalizeDomain`
in the import path), but today it is only used as the per-workspace account dedup key, not as a join into a
shared company identity.

---

## 4. Identity resolution as implemented vs the planned global ER

### 4.1 What is BUILT (three independent, within-workspace mechanisms)

**(a) Deterministic match-key hierarchy** (`packages/core/src/enrichment/matchKeys.ts`). `buildMatchKeys`
(`:132-156`) reduces a sparse row to canonical keys mapping 1:1 onto the `match_method` ladder
(strongest→weakest, `:22-28`): `deterministic_email` (HMAC blind index of the plus-stripped lowercased email,
`:135-138`) → `deterministic_linkedin` (public-id slug) → `deterministic_phone` (E.164 via libphonenumber,
`:87-95`) → `deterministic_domain` (registrable domain/eTLD+1 via PSL, `:74-81`) → `fuzzy_name_company`
(accent-stripped, casefolded canonical name + company, `:101-120`). Normalization is **centralized and pure**
(reuses the import normalizers) — the explicit anti-drift discipline ADR-0037 mandates (`ADR-0037:75-81`,
113-116).

**(b) Import-time exact-key matching** (`runImport.ts:224-248`). The importer always calls
`contactRepository.findByDedupKeys` (email-BI → linkedin → sales-nav order) and resolves the conflict in app
code under the chosen `conflict_policy` (`skip` / `keep_both` / `overwrite`). It explicitly notes that a truly
**separate record cannot exist** in the overlay (one-per-identity-key) and that **separate-record survivorship
is ER's domain — "until that lands, keep_both holds the match back as a duplicate"** (`runImport.ts:230-241`).
That comment is the code admitting the global-ER gap.

**(c) Per-workspace soft-pointer dedup** (`packages/core/src/prospect/dedup.ts`). An off-thread pass that
flags likely duplicates *within one workspace* by writing `contacts.duplicate_of_contact_id`. Key insight
(`dedup.ts:6-9`): because the exact keys are already unique per workspace, cross-source dupes show up as the
**same person at the same company under different keys**, so the dedup key is `canonicalName +
registrableDomain(emailDomain)` (`:37-42`). It is a **soft pass — only sets a pointer, never merges or
deletes** (`:1-3`), runs inside `withTenantTx` so RLS keeps pointers in-workspace (`:97-110`), and picks a
canonical deterministically (revealed > most-complete > earliest > lowest id, `:60-69`).

**(d) Provider waterfall** (`packages/core/src/enrichment/waterfall.ts`): order capable providers by
`trust ÷ cost` (`:50-60`), call until one hits, per-provider in-process circuit breaker (3 errors → open,
60 s cooldown, `:8-43`), plus a parallel-cheap bulk variant (`:117-174`). Breakers are **per-process** — a
Redis-shared breaker is a named follow-up (`:4`).

**(e) The bulk match-first seam** (ADR-0037; `packages/core/src/enrichment/bulk/`). `MatchPort.matchRow`
(`matchPort.ts:69-71`) resolves a row in strict cost order: overlay deterministic → master-graph candidate →
provider residual. `overlayMatcher.ts` is **real**; `masterGraphMatcher.ts` is an explicit **stub that always
returns `{ method: "none", outcome: "unmatched" }`** (`masterGraphMatcher.ts:26-34`) because the
billions-scale candidate index (Citus/OpenSearch/Spark) is infra-gated on M12/M13. The port keeps `@leadwolf/db`
out via an injected `CandidateFinder` (`matchPort.ts:40-45`) — the same swappable-seam discipline as
`ProviderPort`/`SearchPort`. `Candidate.masterPersonId` is already in the contract (`matchPort.ts:32`),
nullable until that infra lands.

### 4.2 What is PLANNED (global cross-source ER) — and not built

ADR-0015 (amended by ADR-0021) names **Splink** (MIT, Fellegi-Sunter) as the engine, run as a **batch** over
`source_records` to produce `match_links` clusters + survivorship golden records, with **blocking + MinHash/LSH**
to avoid O(n²) at billions and **calibrated two-threshold routing** (auto-accept ≥ high cutoff, clerical-review
between, auto-reject below; ≥0.95 precision, ≤0.5% false-merge targets owned by 22 §5–§6)
(`ADR-0015:38-45,77-82`; `ADR-0021:67-70`). **None of this exists in code** — there is no Splink integration,
no `source_records`/`match_links` table, no blocking-key materialization, no survivorship engine, no review
queue. The 4-signal hierarchy is *implemented as deterministic keys + a name+domain fuzzy fallback for the
soft pass*, but the probabilistic engine and the global cross-source application of it are docs only.

**Net:** matching today is *within-workspace, exact-key-first, with a soft fuzzy duplicate pointer*. The
ADR-0021 invariant that **every overlay row resolves to a master entity** (`ADR-0021:53-65`) is **not enforced
anywhere** — no import path sets a `master_person_id`/`master_company_id` because the columns and the graph
do not exist. The nullability the ADR reserves "only to tolerate in-flight staging" is, today, the steady and
only state.

---

## 5. Provenance as implemented — and the explicit absence of per-field provenance

**What exists (batch/job-level only):**
- `source_imports` (`contacts.ts:212-245`): one row per *(contact, import)* with the verbatim `raw_data`
  payload + `content_hash`. Answers "*which import produced this contact row*," not "*where did this contact's
  job_title come from*."
- `provider_calls` (`intel.ts:88-114`): a cache/cost ledger keyed by `request_hash`, holding the verbatim
  `response_payload`. Answers "*what did provider X return for this request*," not which field of the contact
  that value survived into.
- `enrichment_job_rows.enriched_fields jsonb` + `provider_source` (`enrichmentJobs.ts:131-132`): per **bulk
  row**, the set of fields filled and the provider used — but this is the bulk ledger, not a structure on the
  `contacts` row, and it is one provider per row, not one source per field.
- `list_members.added_via` + `source_import_id` (`lists.ts:97-103`): membership provenance, not field provenance.

**What is absent (the central undesigned gap):** there is **no per-field source / confidence / timestamp** on
`contacts` or `accounts`. A contact's `job_title`, `email`, `phone`, `seniority_level` are bare columns; the
row carries one `last_verified_at` (`contacts.ts:135`) and one `email_status` (`:109`) — there is **no
`job_title_source`, `email_confidence`, `phone_updated_at`** structure, and nothing records that a
**user-entered value outranks a provider guess** (a survivorship rule ADR-0015 mandates,
`ADR-0015:70-75`). ADR-0006 stated this plainly as a consciously-accepted consequence: *"No field-level
provenance / golden merge / cross-source dedup / replay-unmerge — provenance is only the raw
`source_imports.raw_data` per import"* (`ADR-0006:51`). ADR-0021 reintroduces lineage **at the master layer**
(`source_records` + `master_emails.source_count`/`last_verified_at`/`verification_source`,
`03-database-design.md:438-449`) but **the per-field overlay provenance structure is specified nowhere** —
not in 03, not in any ADR. This is the invent-from-scratch surface the initiative flags (and the shared
ground-truth calls *"UNDESIGNED anywhere"*).

The import path today is honest about its merge policy: on `overwrite` it is **last-writer-wins** at the row
level (`runImport.ts:242`, `contactRepository.update`), and the 03 §15.3 bulk upsert is `fill_empty_only`
by default with a shallow `custom_fields` merge (`03-database-design.md:979-1013`). There is no field-level
survivorship anywhere in code.

---

## 6. Tenancy, RLS & ownership as implemented

**RLS mechanism (`packages/db/src/client.ts:48-68`).** `withTenantTx` is the only sanctioned scoped path:
inside a transaction it `SET LOCAL ROLE leadwolf_app` (the non-`BYPASSRLS` app role) then sets
`app.current_tenant_id` + `app.current_workspace_id` as **transaction-local bound params** via `set_config(…,
true)` — RDS-Proxy/PgBouncer transaction-pool safe, `prepare:false` (`client.ts:13`). The privileged escape
hatches are explicit and audited: `withPrivilegedTx` (`:30-35`, BYPASSRLS DSAR fan-out) and `withPlatformTx`
(`:95-111`, writes a `platform_audit_log` row in the same tx).

**Policy (`packages/db/src/rls/contacts.sql`).** `accounts`, `contacts`, `source_imports` are each
`ENABLE` **and** `FORCE ROW LEVEL SECURITY` (`:17-18,28-29,39-40`) with a single `*_workspace_isolation`
policy whose `USING` and `WITH CHECK` both key off
`workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid` (`:20-22,31-33,42-44`).
`NULLIF(…, '')` makes an unset/`''`-reset GUC read as `NULL` → **fail-closed** (zero rows). `FORCE` removes
the table-owner exemption so the policy binds every role the app runs as. This is verified in two-tenant
isolation itests that gate merge (the model in `list-plan/02-data-model.md:231-260`).

**Ownership/visibility (app-layer, partially built).** `contacts.owner_user_id` exists (`contacts.ts:103`)
as the assignable soft-owner / "My prospects" filter dimension — distinct from the immutable
`revealed_by_user_id` (`:129`). But the rest of the ADR-0022 intra-workspace segmentation —
`assigned_team_id`, `visibility ('workspace'|'team'|'owner')`, the `teams`/`team_members` tables — is
**absent from `contacts.ts`/`accounts.ts`** (target at `03-database-design.md:503-543`). So today
visibility is effectively *workspace-wide via RLS, with `owner_user_id` as a pure filter* — the team/owner
visibility wall ADR-0022 describes is unbuilt at the data layer. RLS is the workspace wall and the only wall.

**The Layer-0 tension (not yet a problem because Layer 0 doesn't exist).** ADR-0021/03 §9 mandate the master
graph be **system-owned, not workspace-RLS-scoped**, reachable only by access path (masked search + paid
reveal) (`03-database-design.md:698`). Since no `master_*` table exists, there is no RLS-vs-system-owned
tension in code yet — but it is the central constraint a later phase must resolve when Layer 0 lands: shared
canonical infra under a model whose default isolation is RLS.

---

## 7. Gap-to-target: the exact inventory later phases own

### 7.1 PLANNED but UNBUILT (a doc/ADR specifies it; no code)

| # | Item | Spec | Why it matters |
|---|---|---|---|
| P1 | Layer-0 tables `master_persons`, `master_companies`, `master_employment`, `master_emails`, `master_phones`, `source_records`, `match_links` | `03-database-design.md:390-486`; ADR-0021 Decision | the entire shared universe; the home of the prospect↔company edge |
| P2 | Overlay master back-refs `contacts.master_person_id`, `accounts.master_company_id` (+ partial `idx_*_master`) | `03-database-design.md:495,511,518,556` | the link that makes the overlay an overlay; the import-path matching invariant target |
| P3 | `master_employment` edge (current+past, title/dates/`is_current`, `UNIQUE(person,company,started_on)`, partial `WHERE is_current`) | `03-database-design.md:428-436` | replaces the degenerate `contacts.account_id`; fixes history + multi-affiliation |
| P4 | `master_companies.primary_domain`/`alt_domains[]`/`name_normalized`/`parent_company_id` | `03-database-design.md:390-407` | shared company identity + acquired-brand/redirect handling |
| P5 | Global cross-source ER: Splink batch, blocking + MinHash/LSH, survivorship, `match_links` clusters, calibrated thresholds, review queue | ADR-0015 (amended), ADR-0021:67-70, 22 §5-§6 | dedup the universe once; the engine behind P1-P4 |
| P6 | The match-first **master-graph** matcher (promote `masterGraphMatcher` stub → real) | ADR-0037 Decision stage 2; `masterGraphMatcher.ts:26-34` | makes bulk match-first actually hit Layer 0 (today falls through to providers) |
| P7 | Overlay segmentation `assigned_team_id`/`visibility`, `teams`/`team_members`, `data_quality_score`/`freshness_status` on overlay | `03-database-design.md:503-546`; ADR-0022; ADR-0025 | the owner/team visibility wall + the quality/freshness surface |
| P8 | Scale topology: Citus shard of the golden store, OpenSearch global masked index, ClickHouse facet counts, S3+Iceberg lake, CDC search-sync | `03-database-design.md:722-753`; ADR-0021 | billions-scale; "what breaks first at 10x" answer |
| P9 | `source_imports.import_job_id` + the `import_jobs`/`export_jobs` bulk ledger + COPY staging | `03-database-design.md:562,896-953` | revert-by-batch + million-row transport (the "bulk-io" effort) |

### 7.2 UNDESIGNED anywhere (the true invention surface — no code AND no doc)

| # | Gap | Status |
|---|---|---|
| U1 | **Field-level provenance** — per-field `source` + `confidence` + `updated_at` on overlay (and, by extension, on the golden record's surviving values) | no schema, no doc. ADR-0006:51 names its absence; ADR-0021 adds *master-layer* lineage but not the per-field overlay structure. **The core Phase-3 invention.** |
| U2 | **Edge-level provenance** — source/confidence/as-of on the `master_employment` edge itself (title from which source, when) | `master_employment` (03 §5.1) carries title/dates but **no source/confidence**; nothing specifies per-edge lineage |
| U3 | **Overlay↔master reconciliation semantics** — how a reveal copies a master value into the overlay, what wins when the overlay was hand-edited, how user corrections flow (or not) back, how a master re-resolution updates already-materialized overlays | ADR-0021 says reveal "unlocks the master channel into the overlay" (`:48-51`) but the per-field merge/precedence between a revealed master value and a user-edited overlay value is **unspecified** — overlaps U1 |
| U4 | **Survivorship rule application at the overlay** — ADR-0015's source-priority→recency→completeness order (`:70-75`) is specified for *merges*, but there is no design for applying it to the overlay's own fields (user-entered outranks provider) | undesigned at the overlay layer |

---

## 8. Pre-build thinking pass — the load-bearing answers for Phase 0

Per the mandatory pass (`truepoint-architecture`), the items that bind this baseline:

1. **Source of truth.** Today: the overlay `contacts`/`accounts` rows *are* the truth (no Layer 0 behind them). Target: Postgres golden (master) is truth, the overlay is a curated copy, the search index is a derived query surface (`03-database-design.md:698`). The initiative inverts where truth lives — a load-bearing assumption every later phase carries.
2. **Duplicate prevention.** Today: three per-workspace partial-unique blind-index constraints (`contacts.ts:156-164`) + the `(workspace_id, domain)` account unique (`:72-74`) + the soft `duplicate_of_contact_id` pointer. There is **no global** uniqueness — the same human is N rows across N workspaces (ADR-0006:50, consciously accepted). Global dedup is P5.
3. **Audit & change history.** Reveal/import/list mutations audit through `audit_log` in the same tx; `source_imports` is the import receipt. **No per-field change history** exists (U1) — you cannot answer "when did this title change and from what."
4. **Security / isolation.** FORCE RLS on every overlay table, fail-closed GUC, two-tenant itest gate (§6). The Layer-0 system-owned-by-access-path model is the unbuilt constraint (P1/P8) and the sharpest future tension.
5. **Scalability / 10x.** Today single Aurora + Typesense; the overlay's hot reads are composite-indexed under the workspace predicate (`contacts.ts:188-205`). At billions the master graph needs Citus/OpenSearch/ClickHouse (P8). N+1 risk: the degenerate `account_id` link means "person at company with company traits" is a join today, denormalized in the target (`current_company_id`, flattened search docs).
6. **Edge cases captured today.** Domainless company → `account_id NULL` (no account row); contact with no email → no email-BI dedup key (LinkedIn/sales-nav fall back); job change → silent overwrite (no history, limit #1); soft-deleted/tombstoned contact still matchable by dedup but guarded at list-link (`runImport.ts:156-164`).

---

## 9. Recommendation

**Adopt this document as the frozen Phase-0 baseline, and frame the whole initiative as closing three
distinct distances — not one.** Treat "build Layer 0" as necessary but **not** sufficient; the audit shows
two of the highest-value gaps (U1 field-level provenance, U3 overlay↔master reconciliation) are *undesigned
even on paper*, so they need a BRAINSTORM/PLAN of their own, not a schema port of an existing ADR.

Concretely, I recommend later phases sequence as:

1. **Phase 1 — the edge first, schema-led.** The prospect↔company edge (`master_employment`) + the overlay
   master back-refs (P2/P3/P4) are the "central design object" and unblock everything else. Land them as the
   first migration, with the overlay FKs **nullable** exactly per ADR-0021's in-flight-staging clause — but
   write the import path to populate them so nullable does not silently become steady-state (the gap
   `runImport.ts:230-241` admits).
2. **Phase 2 — match-first wiring.** Promote `masterGraphMatcher` from stub (P6) behind the existing
   `MatchPort` seam (`matchPort.ts`), reusing the already-shipped canonical normalizers (`matchKeys.ts`) so
   there is zero bulk-vs-batch drift (ADR-0037's hard requirement). This is low-risk because the seam exists.
3. **Phase 3 — invent field-level + edge provenance (U1/U2/U4).** This is the genuine design work: a
   per-field `{source, confidence, updated_at}` structure on overlay and the surviving golden values, plus
   the survivorship precedence (user-entered > verified provider > inferred) ADR-0015 mandates but never
   sited at the overlay. Design U3 (reveal-copy + hand-edit precedence) in the same pass — it is inseparable.
4. **Phase 4 — the RLS-vs-system-owned reconciliation** (P1/P8): how shared canonical infra lives under a
   default-RLS model. Defer the billions-scale topology (Citus/OpenSearch/ClickHouse) behind it as the scale
   track, not an MVP gate (ADR-0021 mitigation; staged M12/M13).

**What I explicitly reject:**

- **Rejecting "just port 03 §5.1 DDL and call Phase 0 done."** The DDL is the *target* for P1, but it does
  **not** cover U1–U4 (per-field/edge provenance, reconciliation), which are the parts with no spec. Treating
  the port as the finish line would ship Layer 0 with the same provenance blindness ADR-0006 accepted.
- **Rejecting a parallel bulk-only matcher or a second normalizer.** ADR-0037 forbids it (drift); the shipped
  `matchKeys.ts` is the single source — reuse it (`ADR-0037:75-81,133`).
- **Rejecting any plan that makes `master_person_id`/`master_company_id` non-nullable at the overlay on day
  one.** ADR-0021 reserves nullability for in-flight ER staging (`ADR-0021:63-65`); a NOT NULL would break
  the staging window. The right control is an import-path invariant + a backfill, not a column constraint.
- **Rejecting front-loading the billions-scale topology (Citus/OpenSearch/ClickHouse/Iceberg).** It is the
  scale path, explicitly *not* required at MVP (`03-database-design.md:744-753`; ADR-0021 mitigation). The
  edge model and provenance design (Phases 1–3) deliver value on the existing single-Aurora stack first.
- **Rejecting any erosion of the FORCE-RLS overlay posture or the two-tenant isolation itest gate** to make
  Layer-0 integration easier — security has final say (CLAUDE.md precedence); the isolation test is a
  correctness rule, never traded for structural convenience.
