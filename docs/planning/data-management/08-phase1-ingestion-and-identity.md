# 08 — Phase 1: Ingestion & Identity Resolution (execution spec)

> **Gate:** PLAN / execution spec. **Posture:** reconcile-and-cite — confirm what is shipped, correct
> the incoming brief's premises against the code, map its proposed schema onto the real model, and
> scope the one genuine net-new (bulk COPY-staging) by **citing its existing design**, not re-designing
> it. **Converts** the incoming brief *"02 — Phase 1: Ingestion & Identity Resolution."* Builds on
> data-management `02-identity-and-dedup.md` + `04-provenance.md`. **Numbering:** the series already
> uses `02` for the identity *dimension*; this is the cross-dimension *execution* spec, so it takes the
> next free number (`08`). **No source code is modified by this gate.**

## 1. Objective (and how much already exists)

The brief asks for *"a single, validated, deduplicated ingestion spine: every record — CSV, Chrome
extension, API, or provider feed — passes through one validation + identity-resolution path before it
lands, with provenance attached at insert."*

**That spine already exists and ships today** in `packages/core/src/import/runImport.ts` (§3). This
spec therefore does **not** build it; it confirms it, corrects the brief's premises (§2), maps the
brief's proposed schema onto the real model (§4), and scopes the **only** genuine gap — the
**million-row bulk COPY-staging execution model** — which is already designed in ADR-0036 +
`30-bulk-import-export-pipeline.md` (§5).

## 2. Premise corrections (reported refuted, with `file:line`)

Per the data-management gate's faithful-reporting rule (`01-research-brief.md §6`, DM3), the brief's
load-bearing premises are corrected against the actual code:

| Brief premise | Verdict | Evidence |
|---|---|---|
| "triplicated normalizers (`A3`)" — "deletes the triplicated copies" | **Refuted** | one canonical module; `matchKeys.ts:6-7` states *"reuse the existing import normalizers (do NOT reimplement)"*; ADR-0037 C5 forbids a 2nd. There is nothing to delete. |
| "country-code domain bug (`A6`)" | **Refuted / mischaracterised** | domains use eTLD+1 via PSL (`enrichment/matchKeys.ts:74`); the only hardcoded list is the **freemail guard** that *prevents* false company nodes (`enrichment/freemailDomains.ts`), already applied on import via `companyDomainKey` (`runImport.ts:205`). |
| "a capable COPY engine hidden behind a feature flag" | **Refuted** | there is **no COPY code** and **no `import_jobs`/staging table** in the schema. The COPY bulk-staging is `P9` — *planned, unbuilt* (`prospect-company-data/RESEARCH_00:290` → `03-database-design.md:896-953`; ADR-0036). It is unbuilt, not flag-hidden. |
| "import pipelines reportedly overlapping … converge on ONE" | **Already one** | `runImport.ts` is the single implementation; `apps/api` and the `imports` worker are *"one implementation, two transports"* (`apps/workers/src/queues/imports.ts:1-7`). |

Net: three of the four premises describe work that is already done or describes an unbuilt design as if
it were hidden. The plan proceeds on the **actual** state below.

## 3. Current state — the shipped ingestion spine (`runImport.ts`)

The per-workspace pipeline, per parsed row, all inside one `withTenantTx` (`runImport.ts:1-7,224-350`):

1. **Validate** — `validateRow` (same verdict the preview uses; rejected rows never touch the DB,
   collected into the rejected-rows artifact). `runImport.ts:384-389`.
2. **Map + normalize** — `mapRow` then the **canonical normalizers** (`normalize.ts` /
   `matchKeys.ts`): `normalizeEmailForStorage/Index`, `linkedinPublicIdOf`, `normalizeDomain`,
   `companyDomainKey` (eTLD+1 + freemail veto). `runImport.ts:89-128,202-216`.
3. **Idempotency** — `contentHash` over the mapped row + source; `sourceImportRepository.findByContentHash`
   → identical re-import is a no-op (still added to the target list, no second provenance row).
   `runImport.ts:238-249`. Plus the per-workspace partial-unique blind-index constraints
   (`(workspace_id, email_blind_index)` / `linkedin_public_id` / `sales_nav_lead_id`,
   `schema/contacts.ts:156-164`).
4. **Dedup-match** — `contactRepository.findByDedupKeys` (email → linkedin → sales-nav).
   `runImport.ts:257`. Conflict policy `skip`/`overwrite`/`keep_both` (G-IMP-5) decides land vs
   hold-back-as-duplicate. `runImport.ts:266-269`.
5. **Master-graph MATCH-AGAINST** — `resolveMasterForLanding` runs in its **own** `withErTx`
   (`leadwolf_er`, no overlay grant) and calls `masterGraphRepository.resolveForImport`, returning the
   `master_person_id`/`master_company_id` bridges; company key is **freemail-gated** so gmail.com never
   mints a company (F4). Non-fatal: a resolution error lands the row with null bridges (in-flight
   staging, ADR-0021). `runImport.ts:202-222,275`.
6. **Land + provenance at insert** — `accountRepository.upsertByDomain` → `contactRepository.insert/update`
   (overwrite respects the field-provenance **pin** via `planFieldWrite`) → **exactly one
   `source_imports` provenance row** appended in the same tx. `runImport.ts:277-343`.
7. **Per-row isolation** — each row in its own tight tx so one bad row never rolls back the import.
   `runImport.ts:391-409`. The `imports` worker wraps this with progress + DLQ on a wholly-failed job
   (`imports.ts:33-95`).

So the brief's objective — one path, validated, deduplicated, master-resolved, provenance-at-insert —
is **met for CSV + API + worker** today. (Chrome-extension capture and provider feeds land through the
same API/import surface or the reveal path; confirming every capture surface routes through
`runImport`/the bulk job is Open Question §10.)

## 4. Brief → real-model mapping (do not fork the schema)

The brief proposes `core.person`/`core.company`/`staging.import_rows`/`core.identity_link`/
`core.merge_audit`. The shipped + designed model already covers each — the spec maps onto it (DM1):

| Brief artifact | Real model | Where |
|---|---|---|
| `core.person` / `core.company` | overlay `contacts`/`accounts` (Layer 1) + golden `master_persons`/`master_companies` (Layer 0) | `schema/contacts.ts`; ADR-0021; `02 §1` |
| ONE normalizer module (`normEmail`…`linkedInUrlToUrn`) | **already exists** — `normalize.ts` + `matchKeys.ts` | `01 §3.1`; `02 §2.1` |
| `staging.import_rows` (raw, source, license, idempotency_key, status) | ADR-0036 **UNLOGGED non-RLS staging** + `import_jobs` ledger (designed, unbuilt) | ADR-0036 §1/§4; `30 §3` |
| `core.identity_link` (signal → canonical id + confidence + method) | `match_links` (cluster_id, match_method, match_probability, `is_duplicate_of`) + the overlay `master_*_id` bridges + soft `contacts.duplicate_of_contact_id` | ADR-0021; `02 §3`; `schema/contacts.ts:48,110` |
| `core.merge_audit` (reversible, who/what/when) | `match_links.is_duplicate_of` + per-field survivorship audit + `audit_log` | ADR-0015 survivorship; `04 §1` |
| Idempotency key unique per (tenant, source, external_id) | `source_imports.content_hash` (UNIQUE) + per-workspace blind-index uniques | `runImport.ts:238`; `schema/contacts.ts:156-164` |

**Do not introduce `core.*`/`staging.*` tables** — they fork the shipped `contacts`/`master_*`/
`match_links`/`source_imports` model and contradict ADR-0021/0036.

## 5. The one genuine net-new: bulk COPY-staging execution model

The current spine is **synchronous, row-by-row** — correct at thousands of rows, impossible at a
million (synchronous request lifetime; per-row `INSERT…ON CONFLICT` is round-trip-bound; no resume,
accounting, or revert). This is the `P9` gap, and it is **already fully designed** — this spec
**cites** it as the build, it does not redesign it:

- **ADR-0036** locks the execution architecture (it explicitly **supersedes the MVP per-row execution
  model**; the column-map UI, dedup keys, and `source_imports` stand): a first-class `import_jobs`/
  `export_jobs` **async job + Salesforce-Bulk-2.0 state machine**; presigned-S3 multipart upload +
  **AV-quarantine gate**; flat-memory streaming parse + server-owned ~10k-row chunking + backpressure;
  **`COPY` → UNLOGGED non-RLS staging → dedup-in-staging → chunked `INSERT…ON CONFLICT…SELECT` under
  `SET LOCAL app.current_workspace_id`** (because **`COPY FROM` is unsupported on RLS tables** — the
  load-bearing constraint); per-chunk **resume watermark** + batch idempotency key; **three-way
  accounting** (succeeded/failed/unprocessed) with `rows_in = succeeded + rejected + deduped +
  unprocessed`; rejected-rows artifact + pre-commit preview (G-IMP-1); **revert-by-batch** (G-IMP-2);
  per-batch **credit lease** (ADR-0029).
- **`30-bulk-import-export-pipeline.md`** is the end-to-end spec (upload §1, parse §2, land §3, accounting
  §4, **two-pass dedup §5**, side-effect safety §9), with deep details delegated to `03`/`09`/`22`.
- **ADR-0015** owns the **import-path two-pass dedup**: within-file `DISTINCT ON` natural key →
  against-existing exact key → fuzzy tail (Splink) with per-attribute **survivorship** and calibrated
  thresholds (**owned by `22 §5-6`**).

**Crucially, this is additive, not a "converge/delete."** Small/manual imports keep the synchronous
`runImport` path; a plan-tier row threshold (`30 §1`) promotes a large upload to the bulk job. There is
no duplicate pipeline to remove — the bulk model is the always-intended successor to the MVP per-row
*execution*, sharing the one set of dedup keys, the one normalizer, and the one `source_imports`
provenance.

## 6. Identity resolution algorithm (reconciled)

The brief's algorithm maps onto the shipped + designed resolution:

1. Normalize via the canonical module (§3, `01 §3.1`).
2. **Deterministic ladder** (strongest→weakest): email blind index → LinkedIn public id → E.164 →
   registrable domain (`overlayMatcher.ts:20-25`; `02 §3.2`). The brief's "URN" reconciles to the
   shipped **public-id slug**, with the URN as an *additive, stronger* key when present (`02 §2.2`).
   Person identity ≠ company identity; the **freemail guard** (`companyDomainKey`) is the concrete
   defense the brief's "guard the A6 bug" asks for.
3. Deterministic hit → link (confidence 1.0).
4. **Fuzzy** name+company+geo → calibrated **two-threshold** routing: ≥ auto-accept → survivorship
   merge; mid-band → review queue; below → new (ADR-0015; `02 §3.3`). At MVP this is **deterministic-
   only** (`review_status='auto'`); the global Splink/fuzzy tail and the `masterGraphMatcher` promotion
   (stub→real) are the **deferred scale track** (ADR-0021/0037; `02 §5`).
5. Mint-then-merge: an unmatched row mints a master; the `match_links.is_duplicate_of` **re-point
   cascade** (C4) repairs duplicates when the deferred ER merges them. Entity locking / merge
   reversibility live in the survivorship design (ADR-0015), not re-specified here.

## 7. Migration & rollout (reconciled)

The brief's expand → shadow → backfill → cutover → rollback maps to reality:

- **Expand** — additive only: the `import_jobs`/`export_jobs` ledger + UNLOGGED non-RLS staging tables
  (ADR-0036; owned by `03`). The overlay `master_*_id` bridges + the normalizer module **already
  exist** — no expand needed there.
- **Shadow** — run the bulk job alongside the synchronous path on a sample; reconcile the three-way
  accounting (`rows_in = succeeded + rejected + deduped + unprocessed`) before promoting any traffic.
- **Backfill** — re-resolve existing overlay rows to master bridges via the **already-shipped**
  `masterBackfill` / `masterBackfillSweep` workers (`apps/workers/src/queues/`), batched/off-peak.
- **Cutover** — flip uploads above the plan-tier threshold (`30 §1`) to the bulk job; small imports stay
  synchronous (not a deletion).
- **Rollback** — the bulk job rides the existing `imports` queue + DLQ; gate promotion behind the
  feature-flag system (ADR-0011) so a bad bulk path reverts to synchronous without data loss (staging is
  non-destructive; live writes are watermark-resumable + revert-by-batch).

## 8. Gate-compliance checklist (mapped to real mechanisms)

- [x] **Tenant isolation** — overlay writes are FORCE-RLS on the workspace GUC; the bulk path `COPY`s
  into **non-RLS** staging then `INSERT…SELECT` **under `SET LOCAL` GUC** into the RLS overlay (ADR-0036
  §5); master resolution runs under `leadwolf_er` (no overlay grant); Layer-0 is access-path isolated
  (`01 §3.5`, DM4). Resolver predicate never crosses tenants.
- [x] **Bounded queries** — dedup uses blocking keys (blind index / registrable domain), indexed;
  fuzzy candidates are blocking-key-bounded (ADR-0021). Bulk parent-key pre-sort avoids lock thrash
  (`30 §3`).
- [x] **Pool safety** — work runs in BullMQ workers; short per-row / per-chunk tx; `withTenantTx`/
  `withErTx` set GUCs per tx (RDS-Proxy-safe, H9); backpressure + per-tenant bulk concurrency cap
  (`30 §2/§10`, `18 §4/§9`).
- [x] **Online-safe migrations** — `import_jobs`/staging are **additive** new tables; no lock on the hot
  `contacts`/`accounts` tables; UNLOGGED staging is replay-from-watermark.
- [x] **Cache correctness** — identity/reveal caches are workspace-namespaced and invalidate-on-write
  via the event backbone (`18 §5`); a merge invalidates the affected entities.
- [x] **Ingest-time suppression** — bulk import screens rows against the tri-scoped suppression list in a
  **single set-based pass before any enrich/charge** (`08-compliance.md §3.1`).

## 9. Acceptance criteria (reconciled — already-met vs net-new)

- [x] **One ingestion pipeline** — already true (`runImport.ts`, two transports). No duplicates to
  delete.
- [x] **One normalizer module** — already true; `A3` refuted, `A6` mischaracterised and already guarded.
- [x] **Zero cross-tenant resolution** — RLS overlay + `leadwolf_er` Layer-0 access path; assert via the
  two-tenant isolation itest (`list-plan/02-data-model.md`).
- [ ] **Bulk COPY-staging job** built per ADR-0036/`30` (state machine, staging, two-pass dedup,
  three-way accounting, resume, revert) — the net-new.
- [ ] **Duplicate rate measured before/after** + the fuzzy review queue functioning — depends on the
  deferred Splink tail (scale track) and the calibration in `22 §5-6`.

## 10. Scale-gate · Failure modes · Open questions

**Scale-gate (what breaks first):** the **synchronous per-row path at million-row scale** — fixed by
the deferred bulk COPY-staging model (ADR-0036), not by raising timeouts. Next: bulk MATCH-AGAINST
candidate generation at billions → deferred blocking/LSH/Splink-on-Spark (`02 §5`).

**Failure modes:** (F1) mint-then-merge duplicate tail → C4 re-point cascade (ADR-0021). (F2) a row
lands with null master bridges on resolver error → in-flight staging, backfilled by `masterBackfill`
(non-fatal by design, `runImport.ts:217-221`). (F3) `COPY FROM` into an RLS table → impossible;
non-RLS staging + `INSERT…SELECT`-under-GUC is mandatory (ADR-0036 §5). (F4) a new capture surface
that bypasses `runImport`/the bulk job → the IDOR/validation standing rule (`02 §2.3`) — route every
surface through the one path.

**Open questions:** (1) Do all capture surfaces (Chrome extension, provider feed) route through
`runImport`/the bulk job, or is there a surface to converge? (2) Transient-duplicate visibility window
(land-then-resolve) acceptable to users? — owner: product + `truepoint-operations`. (3) Fuzzy-threshold
tuning needs labeled data — owner: `22 §5-6`. (4) Merge reversibility under concurrent writes — owner:
the ER/survivorship design (ADR-0015). (5) Bulk-vs-synchronous promotion threshold — owner: `30 §1` /
`12` plan tiers.

## Sources

Code (verified `file:line`): `packages/core/src/import/runImport.ts`, `import/normalize.ts`,
`enrichment/matchKeys.ts`, `enrichment/freemailDomains.ts`, `apps/workers/src/queues/{imports,masterBackfill,masterBackfillSweep}.ts`,
`packages/db/src/schema/contacts.ts`, `packages/db/src/client.ts`. Design: `decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md`,
`30-bulk-import-export-pipeline.md`, `decisions/ADR-0015/0021/0037/0029`, `08-compliance.md §3.1`,
`prospect-company-data/RESEARCH_00_current_state.md`, and data-management `01`/`02`/`04`.
