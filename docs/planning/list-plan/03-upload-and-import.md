# List Tab — Upload Your Own Data → List (03)

> **Status:** Plan (not yet built). **Owner:** Platform + Data. **Last updated:** 2026-06-24.
> Cites the **Locked Decisions (D1–D5)** and **Shared Vocabulary** in `00-overview.md` verbatim — this doc
> must not contradict them. Cross-references `01-research-summary.md` (enterprise patterns), `02-data-model.md`
> (schema/RLS/DSAR), `04-list-workspace-ui.md` (the Lists surface that hosts the wizard and receipt), and
> `06-enrichment-verification.md` (the match-first → provider waterfall and credit-back math). Execution
> sequencing is the contract in `09-rollout-phases.md` — this is **Phase 2** (work-units `db/test`, `api`,
> `import`), with the match-first option reaching into **Phase 3**.

This is the **"bring your own data → list"** job (job #1 in `00-overview.md §2`): a seller uploads a
spreadsheet of prospects, maps columns, dedups against what the workspace already has, optionally
**match-and-enriches** against our data, and lands the rows in a target list. The good news per `00 §5`:
**the import pipeline already exists** (CSV, async, deduped, PII-encrypted). This plan is **wiring + two
gaps + a wizard**, not a greenfield ingestion engine.

---

## 1. What exists today (ground truth — be precise)

The import subsystem is real and load-bearing. One core implementation, two transports (`16 §3.2`): the API
parses + enqueues; the worker drains + runs the **same** `packages/core` pipeline.

### 1.1 The CSV preview / upload / poll flow
- **Routes** (`apps/api/src/features/import/routes.ts`), all behind `authn` + `tenancy` + `rateLimit`. The
  workspace comes from the **verified token** via the tenancy middleware — **never** the request body (`16 §7`,
  reinforces **D4**):
  - `POST /api/v1/imports/preview` — multipart (`file` + `sourceName` + JSON `mapping`). Parses with
    `parseImportFile(file.text(), file.name)` and returns `buildImportPreview(...)` **without enqueuing or
    writing anything** (G-IMP-1). No DB writes, no job.
  - `POST /api/v1/imports` — same multipart plus an optional `conflictPolicy` (default `skip`, **no silent
    overwrite**). Parses, then `enqueueImport(...)` and returns **202 + `{ jobId, status:"queued" }`**. The
    heavy per-row work runs in the worker, not on the request thread.
  - `GET /api/v1/imports/:jobId` — poll status/progress/summary. **Tenant-isolated**: a job whose
    `data.scope.workspaceId` ≠ the caller's workspace returns **404** (never leak existence).
- **Producer** (`apps/api/src/features/import/queue.ts`): the BullMQ `imports` queue with
  `attempts: 3`, exponential backoff (`delay: 2000`), `removeOnComplete` retained ~24h/1000 so the poll
  endpoint can read a settled job, `removeOnFail: false`. The job payload **is** a `RunImportInput` (rows are
  parsed API-side before enqueue).
- **Web UI** (`apps/web/src/features/import/`): `ImportWizard.tsx` (source + CSV picker, client-side header
  read to populate the mapper, column mapper grouped Identity/Person/Company/Location, conflict-policy select,
  Validate → preview → Confirm & import), `useImport.ts` (enqueue then **poll every ~1.5s, ceiling ~80
  attempts/~2min**, tolerating 3 consecutive transient poll errors), `api.ts` (typed `fetchWithAuth` calls).
  Rejected rows on a completed import download client-side as a CSV error file (raw row + per-field reason).

### 1.2 The per-row pipeline (`packages/core/src/import/runImport.ts`)
For each parsed row, in its **own tight `withTenantTx`** (one bad row never rolls back the import):
1. **Validate** (`validateRow`) — same verdict the preview uses, so a row rejected in preview is rejected here
   with identical per-field reasons. Rejected rows **never touch the DB**.
2. **Map → normalize** (`mapRow`, `normalize.ts`) — trim, lower-case email-for-index, derive email domain,
   coerce seniority to the closed set, extract `linkedinPublicId` / `salesNavLeadId`. A row with **no identity
   key** (email **or** LinkedIn **or** Sales Nav id) is rejected.
3. **Content hash** (`contentHash({ mapped, sourceName })`) → **idempotency**: if
   `sourceImportRepository.findByContentHash(tx, workspaceId, hash)` hits, the row is a `skipped` no-op (an
   identical payload re-imported into this workspace).
4. **Encrypt PII at the app layer** (`encryptPii`) — `email` → `emailEnc`, `phone` → `phoneEnc`. Plus a
   **blind index** of the normalized email (`blindIndex(normalizeEmailForIndex(email))`) for equality dedup
   without storing the plaintext.
5. **Upsert account by domain** (`accountRepository.upsertByDomain`) when an account domain is present.
6. **Dedup-match the contact** (`contactRepository.findByDedupKeys`) in priority order:
   **email blind-index → `linkedin_public_id` → `sales_nav_lead_id`**. The overlay enforces **one contact per
   identity key per workspace** via partial unique indexes (`02-data-model.md §5`), so a blind insert on an
   existing identity would throw — the conflict is resolved in app code, not by the DB.
7. **Conflict policy (G-IMP-5)** on a match:
   - `skip` → keep existing, count as **duplicate** (no provenance row appended);
   - `keep_both` → today **also held back as a duplicate** (a truly separate record can't exist in the
     one-per-identity overlay; separate-record survivorship is Entity-Resolution's domain, ADR-0021 — until ER
     lands, `keep_both` does **not** silently overwrite);
   - `overwrite` → `contactRepository.update(...)` the existing contact (counts as **matched**).
   No match → `insert` (counts as **created**).
8. **Provenance**: append exactly **one `source_imports` row** (`tenantId`, `workspaceId`, `contactId`,
   `importedByUserId`, `sourceName`, `sourceFile`, `rawData`, `contentHash`).

The summary is a three-way+ accounting: `{ total, created, matched, skipped, rejected, duplicates, errors,
rejectedRows }`.

### 1.3 The async worker + DLQ (`apps/workers/src/queues/imports.ts`)
`processImport` reports coarse progress (`updateProgress`), runs `runImport`, and reports a final progress
frame. **Job-level failure semantics:** a wholly-failed import (`total>0` and `created+matched+skipped+
duplicates === 0`) **throws `ImportFailedError`** so BullMQ retries and, once `attempts` are exhausted, the
job is dead-lettered. Partial success returns normally; per-row rejects ride in `summary.rejectedRows`.
`deadLetterFailedImport` writes a **PII-free** DLQ record (scope + provenance + reason only — **never the raw
rows**, which hold un-encrypted PII) once retries are exhausted.

### 1.4 Column-map templates (`packages/db/src/schema/importMappingTemplates.ts`)
Workspace-scoped, named, replayable `ColumnMapping` (G-IMP-3). `mapping` jsonb is the canonical-field →
source-header map (validated at the API edge against `columnMappingSchema`, stored verbatim). A
`(workspace_id, lower(name))` unique index makes a re-save **upsert in place** (case-insensitive). The wizard
applies a template (keeping only fields it renders a control for, so an API-created template can't inject
hidden mapping state) and saves the current map by name.

> **Implementation status (today's limits).** CSV-only (`parseImportFile` throws a clear
> `ImportValidationError` for `.xlsx`). Rows are parsed **API-side** and travel **in the job payload** (fine
> at MVP volume; §6 addresses scale). The import targets the **workspace contact overlay** — there is **no
> `listId`**, so landed rows are **not** added to any list. No credit estimate and no match-first enrichment on
> import. Those three are the gaps in §2.

---

## 2. The gaps to close

### 2.1 XLSX support (work-unit `import`, Phase 2)
CSV-only today: `parseImportFile` reads `file.text()` and **throws** for `.xlsx` (a deliberately declared seam
— "XLSX import is not supported yet — export the sheet as CSV"). Spreadsheets are the dominant real-world
upload format (`01-research-summary.md`), so this is the one true blocker for "bring your own data".

**Proposal — an xlsx adapter alongside CSV in the import core, same `{ headers, rows }` contract:**
- Add `parseXlsx(bytes: Uint8Array): ParsedCsv` in `packages/core/src/import/parseFile.ts` (or a sibling
  `parseXlsx.ts`) using a vetted, pure parser (e.g. SheetJS / `exceljs`) — read **first sheet**, header row =
  row 1, coerce every cell to a trimmed string so it lands on the **identical** downstream path (validate →
  map → normalize → encrypt → dedup). XLSX changes **only parsing**; nothing after `ParsedCsv` differs.
- **Binary, not text.** CSV flows as `file.text()`; XLSX must flow as **bytes** (`file.arrayBuffer()`). Change
  `parseImportFile` to dispatch on extension/MIME and accept bytes (keep a text fast-path for CSV). Update the
  preview and upload routes to pass bytes for `.xlsx`.
- **Security hardening (truepoint-security):** treat the workbook as fully untrusted. Cap rows and bytes
  (reject oversized/over-wide sheets before parsing), **ignore formulas/macros** (parse values only, never
  evaluate), guard against zip-bomb decompression, strip a leading `= + - @` from any cell rendered later
  (CSV-injection class), and keep the same `rateLimit`. Wrong/corrupt binary → a clean `ImportValidationError`,
  never a crash.
- **Web:** widen the file `accept` to `.csv,.xlsx,text/csv,...spreadsheetml...`; client header-read uses the
  same adapter (or skips client preview for xlsx and relies on the server preview). Templates, dedup, conflict
  policy, receipt — all unchanged.
- **Tests:** a fixture-driven `parseXlsx` unit test (parity with `parseFile.test.ts`), plus the **"upload XLSX
  into a list"** flow in the e2e recipe (`09 §5.2`).

### 2.2 Import targets a list (work-units `db/test` + `api` + `core` + `import`, Phase 2)
Today an import lands in the **workspace contact overlay** with no list linkage. The job is "bring your own
data **→ list**", so the wizard must accept a **target list** (an existing list, or **"create a new list"**)
and every **landed** row must become a `list_members` row.

- **Schema (Phase 0 prerequisite, defined in `02-data-model.md`; `09 §2 Phase 0`):** extend `list_members`
  with `added_via ∈ {search,import,manual,api}` and a nullable `source_import_id`. (Today `list_members` has
  only `addedByUserId`/`addedAt` and the `(list_id, contact_id)` uniqueness — see
  `packages/db/src/schema/lists.ts`.)
- **API contract:** the upload route accepts an optional **`listId`** (and, for "create new", a `listName` →
  create-then-use, all server-side; the client never trusts or invents the id). Thread it into
  `RunImportInput.target = { listId }`. **Validate ownership/scope** of `listId` against the **token's
  workspace** before enqueue (the list id from the client is **never trusted** — `00 §`, **D4**).
- **Core (`runImport`):** after a row **lands** (`created` or, for `overwrite`, `matched`), in the **same
  `withTenantTx`**, upsert membership: `list_members (list_id, contact_id, added_via='import',
  source_import_id=<the appended source_imports id>, added_by_user_id=<importer>)` with **`ON CONFLICT (list_id,
  contact_id) DO NOTHING`** (re-adding is a no-op — idempotency holds at both the contact and the membership
  layer). A `duplicate`/`skipped` row that **matched an existing contact already in the workspace** is still
  **added to the target list** (membership is the point of the import) but does not append a second provenance
  row — define this precisely in `02-data-model.md`'s membership rules and the receipt's "matched" lane.
- **Audit:** member-added events are written to the **customer-visible `audit_log`** via `withTenantTx`
  (`09 §2 Phase 0`).
- **Receipt on the list:** the import receipt (§3.6) is surfaced on the **list detail** surface
  (`04-list-workspace-ui.md`), keyed by `source_import_id`, so a seller sees what an import put into *this*
  list.

### 2.3 Match-first enrichment on import (option) (work-unit `enrichment`, ADR-0037 — Phase 3 reaching into the wizard)
An **opt-in** at the wizard: before any **paid provider** call, **match the customer's uploaded rows against
the master graph / overlay** and only pay to enrich the rows that need it. This is **ADR-0037**
(bulk match-first resolution) feeding the **ADR-0021** overlay, and it is exactly **D1**: we **match-against**
the master graph for *this customer's own* dedup/enrichment — **contribute-to is OFF** (uploaded rows never
feed the shared graph; see §5).

- **Order (ADR-0037):** for each row, attempt a **deterministic master/overlay match** (email → LinkedIn →
  phone → domain) *before* the provider waterfall. A master/overlay hit is **free or near-free**; only the
  **residual unmatched** rows go to a paid provider (the full waterfall + credit-back math is
  `06-enrichment-verification.md`, not re-specified here).
- **Ledger pattern:** this is the **`enrichment_jobs` / `enrichment_job_chunks` / `enrichment_job_rows`**
  ledger (`packages/db/src/schema/enrichmentJobs.ts`) — chunked control + per-row `match_method` /
  `match_outcome` (`matched_internal | matched_provider | unmatched | suppressed | error`) / `cost_micros` /
  `charged`. The import either **drives** that ledger directly for the match-first pass, or hands the landed
  rows to it as a follow-on bulk-enrich keyed by `source_import_id`.
- **Money (D5):** the **credit estimate** (§3.5) is computed from the **match-first count** (free) vs the
  **projected paid-residual** — the user sees, and confirms, the cost **before** any provider spend. We
  **charge only for matched/valid** enrichment and **credit-back on hard bounce** (D5, ADR-0007/0013).
- **Default OFF.** Match-first enrichment is an explicit toggle in the wizard; a plain import (no enrichment)
  must remain a one-confirm, zero-spend path.

---

## 3. The wizard UX (mirrors enterprise patterns — `01-research-summary.md`)

A linear, resumable wizard on the **Lists** surface (`04-list-workspace-ui.md`), reusing the existing
`ImportWizard` shell and `@leadwolf/ui` (truepoint-design owns what renders; every step has the four states —
idle/loading/empty/error — and is WCAG 2.2 AA). The canonical enterprise shape (Apollo/ZoomInfo/Clay-style)
per `01-research-summary.md`:

| Step | What the user does | Backed by |
|------|--------------------|-----------|
| **1. Upload** | Drop a **CSV or XLSX**, pick the source, pick the **target list** (existing or "create new") | §2.1 parser, §2.2 `listId` |
| **2. Preview** | See **valid / duplicate / rejected** counts + a **sample of rejected rows with reasons** | `POST /imports/preview` (no writes) |
| **3. Column-map** | Map headers → canonical fields; **apply or save a template** | `importMappingTemplates`, G-IMP-3 |
| **4. Dedup / conflict** | Choose `skip` / `overwrite` / `keep_both`; opt into **match-first enrichment** | G-IMP-5, §2.3 |
| **5. Estimate** | **Credit estimate BEFORE run** — match-first count (free) + projected paid residual + cost | §2.3, **D5** |
| **6. Run async** | Confirm → 202 + job ref → **poll/progress** (created/matched/skipped/failed lanes) | `POST /imports`, `useImport` polling |
| **7. Receipt** | **Import receipt** on the list — created / matched / skipped / duplicates / rejected + **match rate**; download rejected-rows CSV | §3.6, surfaced per `04` |

Notes that keep this honest:
- **3.1 Upload.** Step order can co-mingle (preview needs a mapping to validate identity), but the *gate* is:
  no run without a confirmed preview (the existing `canSubmit = file && identityMapped && preview !== null`).
- **3.2 Preview.** Reuses `buildImportPreview` — `total = valid + rejected + duplicate`, within-file duplicate
  estimate + bounded rejected sample (default 50). Cheap, DB-free; against-existing dedup is the worker's job.
- **3.3 Column-map.** The template picker only injects fields the mapper renders (no hidden mapping state).
  Require ≥1 **identity** field (email/LinkedIn/Sales Nav) to proceed — matches `prepareContact`'s reject rule.
- **3.4 Dedup/conflict.** The three policies exactly as the core resolves them (§1.2.7) — surface `keep_both`'s
  current "held back, not overwritten" behavior in copy so the user isn't surprised.
- **3.5 Estimate.** **Mandatory when match-first enrichment is on** (D5). A plain import shows the deterministic
  counts only (free); an enrichment-on import shows match-first-free vs projected-paid + a hard cost number and
  requires a second confirm. No estimate path may lead to spend without an explicit confirm.
- **3.6 Receipt.** Built from `ImportSummary` (created/matched/skipped/duplicates/rejected) + the **match rate**
  (matched-internal / total) when enrichment ran. Persisted/keyed by `source_import_id` so it's re-openable on
  the **list detail** later — not just a transient toast. Rejected rows remain downloadable as a fix-and-retry
  CSV.

---

## 4. Cost & money rules (D5)

Inherited, not reinvented (**D5**; the engine is `06-enrichment-verification.md`):
- **Charge only for matched/valid enrichment.** Match-first hits against the master/overlay are free/near-free;
  we pay (and charge) only for the **paid residual** that a provider actually resolves. Hard-bounce →
  **credit-back** (ADR-0007/0013). The detailed waterfall + credit math is **`06`**, not duplicated here.
- **Estimate before run.** When match-first enrichment is enabled, the wizard **must** show the credit estimate
  (match-first count + projected provider cost) and require an explicit confirm **before** any spend (D5,
  `09 §2 Phase 3`). The `enrichment_jobs` ledger carries `credit_estimate_micros` / `credit_spent_micros` for
  this exact pattern.
- **Post-run summary.** The receipt shows **charged rows** and **credits spent** alongside created/matched/
  skipped — the "post-spend balance" verification in `09 §5.4`.
- **A plain import is free.** Importing without the enrichment option spends nothing — landing rows + dedup +
  membership cost no credits. Cost only enters with the opt-in match-first/provider pass.

---

## 5. Isolation (D1)

Uploaded list data is the customer's alone — **never feeds the shared/global master graph** (**D1**, ADR-0021
"match-against ≠ contribute-to"; co-op OFF by default).
- **Workspace-scoped overlay copies.** Every imported contact and `list_members` row is written under
  `withTenantTx` with the **token's** `tenantId`/`workspaceId`; the hard boundary is **Postgres RLS** (`02
  §`/`08`, **D4**) — list membership is a **filter**, not a new access wall.
- **Match-against only.** The master-graph/overlay match (§2.3) resolves *this customer's* row to a master
  entity **for that customer's own** dedup/enrichment. **Contribute-to is OFF**: an uploaded row's content
  never updates, augments, or seeds the shared graph; nothing the customer uploads becomes visible to any other
  tenant. The candidate-index match (ADR-0037) is read-only against the shared graph.
- **PII at rest** stays app-layer encrypted (`emailEnc`/`phoneEnc`) with blind-index equality only (§1.2.4);
  the DLQ stays **PII-free** (§1.3). DSAR/erasure cascade for uploaded list data (delete cascades
  `list_members`; person-level erasure tombstones across copies + a suppression row blocks re-import) is owned
  by `02-data-model.md` / `08-security-compliance.md` (`09 §2 Phase 5`).
- **Staff cannot browse it.** Per **D2**, internal/platform staff see **list metadata + aggregate usage**
  only; record-level access to imported contents requires an audited, time-boxed **break-glass** session
  (`07-admin-staff-governance.md`).

---

## 6. Limits & scale

- **Async + chunked.** Imports already run async via BullMQ (§1.1/1.3). At MVP, parsed rows travel **in the job
  payload** — fine for small/medium files but it does not scale to 10k–100k rows. The scale path (mirroring the
  **`enrichment_job_chunks`** pattern, `09 §6`): upload the file to object storage, enqueue a **control job**
  that **chunks** by row band, and have runners claim chunks — so memory, retries, and progress are per-chunk,
  not per-file. Relax **nothing** about RLS or per-row `withTenantTx` when chunking.
- **Target SLO.** **p95 import job < a documented SLO for 10k well-formed rows** (`00 §6`, `09 §6`). Propose a
  starting target of **p95 ≤ 5 min for 10k rows** end-to-end (enqueue → all members landed), excluding any
  opt-in provider-enrichment latency (which is metered/estimated separately). Tune the chunk size and worker
  concurrency to hold it; surface live progress so a long job never *looks* hung (the poll loop already tolerates
  transient blips and times the **UI** out at ~2min — the **job** keeps running and the receipt is read on
  return).
- **Rejected-row handling.** Validation rejects never touch the DB; they're collected with per-field reasons
  and downloadable as a **fix-and-retry CSV** (raw row + reason). A wholly-failed import retries then
  dead-letters **PII-free** (§1.3). Per-row constraint failures after validation are surfaced as rejects, not a
  job failure.
- **Idempotency via `content_hash`.** A re-imported identical payload is a `skipped` no-op
  (`findByContentHash`), and `list_members` membership is `ON CONFLICT DO NOTHING` — so **re-running the same
  import adds nothing new** (the `09 §5.2` dedup assertion). For chunked/object-storage uploads, add an
  **upload-level idempotency key** (the `enrichment_jobs.idempotency_key` pattern) so a re-submit of the *same
  file* collapses onto the existing job rather than double-processing.
- **Footprint caps.** Enforce a max file size / max rows / max columns at the API edge (truepoint-platform /
  truepoint-security) so a single upload can't exhaust a worker; reject over-cap files in the preview step with
  a clear message.

---

## 7. Cross-references

- **`00-overview.md`** — Locked Decisions **D1–D5**, vocabulary (List / Member / Import into list /
  Match-against vs Contribute-to), success metrics (upload match-rate, <2% rejected, p95 SLO).
- **`01-research-summary.md`** — the enterprise wizard shape (upload → preview → map → dedup → estimate → run →
  receipt) and XLSX-as-table-stakes that this section mirrors.
- **`02-data-model.md`** — `list_members.added_via` + `source_import_id`, the one-per-identity overlay indexes,
  `source_imports` provenance, RLS, and the DSAR/erasure cascade for uploaded data.
- **`04-list-workspace-ui.md`** — the Lists surface that hosts the import wizard entry ("Import into list") and
  renders the **import receipt/history** on list detail.
- **`06-enrichment-verification.md`** — the match-first → provider waterfall, credit estimate, and credit-back
  math the §2.3 / §4 opt-in defers to.
- **`09-rollout-phases.md`** — Phase 0 schema prerequisite, **Phase 2** (this doc: XLSX + import-into-list +
  receipt), Phase 3 (match-first on import), and the e2e verification recipe (`§5.2`/`§5.4`).
