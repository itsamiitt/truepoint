# 08 — Import Management Architecture

> **Status of this doc:** complete (design doc — target state 🔲 not built; nothing ships from
> this series). Evidence cites [`01-Current-State-Audit.md`](01-Current-State-Audit.md); gaps cite
> [`02-Root-Cause-and-Gap-Analysis.md`](02-Root-Cause-and-Gap-Analysis.md); every external-platform
> claim cites the register in [`03-Enterprise-Research.md`](03-Enterprise-Research.md).
> **Owns:** **G03** (Redis-only sync job state — P0), **G04** (no tenant list endpoint — P0, API
> half; doc `11` owns the page), **G05** (no cancel/retry — P1), **G10** (dead-end toggle /
> server-side routing — P1, routing half; doc `11` kills the toggle), **G13** (merge-strategy
> triad — P2), plus the error-artifact *contract* half of **G14** (PII posture is doc `13`'s).
> **Siblings written in parallel:** doc [`09`](09-Queue-and-Background-Processing.md) owns queue
> topology, tenant fairness, durable progress mechanics, and outbox notifications (G06); doc
> [`10`](10-Visibility-and-Permissions.md) owns the owner predicate and every permission matrix
> (G01/G02). This doc forward-references them and specs neither.
> **Step IDs:** `S-I1`…`S-I10` (sequenced in doc `15`; never fixed migration numbers).

---

## Objective

One import system instead of two. Every import — 50 rows or 2 million — becomes a durable
`import_jobs` row driven through one server-owned state machine, with a listable history, a
cancel verb, per-row outcomes, downloadable error artifacts, saved mapping templates, and a
market-standard merge-strategy surface. The server decides how a file is processed; the client
never picks a pipeline again. The Redis-only job state that makes today's live imports evaporate
(01 §4.3) is retired as a *system of record* and demoted to what queue vendors themselves say it
is: transport (03 §6.1 [138][142]).

---

## Reconciliation (what this design extends and must never contradict)

Pinned before any design claim, per the series convention.

**The design-of-record: [`../data-management/15-bulk-import-design.md`](../data-management/15-bulk-import-design.md)
(ADR-0036).** This doc *extends* it and re-litigates nothing. Its three locked facts shape
everything below (15 §1):

1. **COPY fast-loads staging only; the live `contacts` write stays Node-side**, batched per ~10k
   chunk in one `withTenantTx` — because the identity ladder spans three partial uniques no single
   `ON CONFLICT` can express;
2. **the pin-aware overwrite rule lives in canonical TS (`planFieldWrite`)** and is never
   re-expressed as SQL over `field_provenance` — the merge-strategy surface in §5 is a *caller* of
   `planFieldWrite`, not a second implementation;
3. **the co-op-safe mint boundary is `withErTx`** (`masterGraphRepository.resolveForImport`) —
   untouched here.

Also from 15: the per-job **UNLOGGED non-RLS staging table is the ONE sanctioned RLS bypass**
(07 §5 quotes it; no second bypass exists or is proposed), staging carries **already-encrypted**
prepared rows, and **3-level idempotency**
(job `idempotency_key` · `(job_id, chunk_index)` + terminal-skip resume · row `content_hash`)
(15 §2). The **9-state machine** itself ships as the schema CHECK (`importJobs.ts:83–86`) and is
spec'd server-owned in db-mgmt-research/05 §5.1 — 15 predates the state vocabulary and doesn't
name it. 15 §2 already anticipated this doc's decisive call: "a row/byte threshold + an env
kill-switch route large uploads to bulk" — the threshold config shipped
(`BULK_IMPORT_THRESHOLD_ROWS`, `packages/config/src/env.ts:235–237`) and was never consumed
(01 §4.1, correction 4). §1 below is that sentence, finished.

**Shipped code this builds on (verified in 01, re-verified at head for this doc):**

- The durable trio `import_jobs`/`import_job_chunks`/`import_job_rows`
  (`packages/db/src/schema/importJobs.ts`): 9-state CHECK (`importJobs.ts:83–86`), AV status
  enum (`:87–90`), eight `rows_*` counters (`:59–66`), non-PII `reject_histogram` (`:67–70`),
  resume watermark, partial-unique `(workspace_id, idempotency_key)` (`:80–82`), per-row outcome
  ledger with audit-pointer uuids (`:129–159`).
- The bulk pipeline: `bulkRoutes.ts` (dual-gate, control-row-first, stream-to-store, 202),
  `runBulkImport.ts` (drive/resume/finalize, header-only inline finalize at `:161–169`),
  `bulkStage`/`bulkProcessChunk` (parity with `runImport` via the shared `prepareContact`).
- The sync pipeline: `routes.ts` (preview at `:115–125`, one-shot submit at `:127–165`, BullMQ
  poll at `:168–189`), `runImport.ts` (per-row `withTenantTx`, ladder email→linkedin→sales-nav,
  exactly one `source_imports` row, optional `list_members`).
- `import_mapping_templates` — shipped, workspace-scoped, case-insensitive upsert-by-name
  (`packages/db/src/schema/importMappingTemplates.ts:24–44`).
- `importJobRepository.listJobsByWorkspace` — exists, unrouted, no owner filter (01 §5.2, G04).
- The dual-gate flag pattern (env kill-switch + per-tenant `feature_flags`, 01 §7.3).

**Sibling designs consumed as contracts (never re-spec'd):** doc 04 §2 (contact identity ladder +
match-vs-act split; merge contract), doc 05 §2.2/§6 (email any-value identity rung via
`contact_emails`; phone E.164 = signal only; append-with-dedup channel policy; unparseable-phone
warning band; COPY-safe channel staging), doc 06 §5 (company ladder C1–C3; ambiguity fails loudly
to review), doc 07 §4.3 (the missing `import_jobs` keyset index rides *this* doc's step set).

**Surface-1 counterpart:** the **operator transitions (pause / resume / retry-chunk / operator
cancel), the reaper sweep, the chunk lease columns, `file_content_hash`, and the staff
drill-down** are owned by
[`../database-management-research/05-Upload-Pipeline-Design.md`](../database-management-research/05-Upload-Pipeline-Design.md)
§5.1/§5.4/§8.2/§9.2. This doc composes the same state machine from the customer side and does not
duplicate those specs; where a table below shows `paused`, its driver is that doc.

**Locked decisions binding this doc:** DM1 (one canonical primitive set — the merge strategies
call `planFieldWrite`, the mappers extend `prepareContact`), DM4 (tenancy unchanged; no user GUC —
the list endpoint's owner scope is app-layer, doc 10), DM6 (provenance winner-map + `pin` governs
every overwrite), ADR-0028 (custom fields stay in the typed registry + jsonb), ADR-0006
(`source_imports` is the only lineage — unchanged). The shipped
`packages/types/src/staffCapability.ts` governs Surface 1 only; nothing here gates `apps/web`
with a staff capability (two-surface rule).

**Contradiction scan.** One naming trap inherited and designed around, not "fixed":
`import_jobs.source_name` holds the `SourceName` **provider enum**, not the filename, despite its
inline comment (01 §2.2; `bulkRoutes.ts:190–197`) — §7's history UI needs a display filename, so
S-I1 adds an additive `source_filename` column rather than repurposing the existing one. The
legacy public status enum (`queued|active|completed|failed|unknown`, `routes.ts:46–62`) is kept
alive through a compatibility mapping (§2.4), never mutated.

---

## Current Challenges (headline only — the as-is is doc 01)

- Two import systems sharing parse/validate/prepare and nothing else: live-but-ephemeral vs
  durable-but-dark (01 §2). The live path cannot implement history, cancel, retry, or
  notifications *as-is* — there is no row to list, no state to transition (02 §RC-2).
- Jobs evaporate from Redis at 24 h / 1 000 jobs; post-eviction `GET` 404s as if the job never
  existed (01 §4.3, G03). No list endpoint exists; the repo method is dead code (01 §5.2, G04).
- The client picks the pipeline via a toggle that 403s while *recommending itself*;
  `BULK_IMPORT_THRESHOLD_ROWS` is dead config (01 §4.1, G10).
- `conflictPolicy` (skip/overwrite/keep_both, default skip) is below the market's
  triad-plus-switch surface (02 §G13). No cancel verb anywhere (G05). One rejected-rows artifact,
  no repair CSV, no typed error vocabulary (G14).

## Enterprise Best Practices (cited via 03's register only)

- **One wizard, server decides.** HubSpot runs a single flow to 512 MB / 1,048,576 rows with
  limits expressed as quotas, not as a tool choice (03 §1.1 [1][3]); Salesforce's wizard-vs-Data-
  Loader fork is the legacy pattern our toggle imitates (03 §1.3 [30]). Server-side routing on a
  unified job model is the enterprise direction (03 §1.3).
- **The durable job contract is the market floor.** Salesforce Bulk API 2.0: linear states with
  three terminals, durable counters, three result resources, indefinite polling (03 §6.1
  [57][58][60], §7); HubSpot: `STARTED/DEFERRED/PROCESSING → DONE|FAILED|CANCELED` with the
  concurrency cap *visible as a state* (03 §6.1 [18]). Queue-native state is documented ephemeral
  by the queue vendors themselves (03 §6.1 [138][142]).
- **"Done" is job-level; partial success lives in results resources** (03 §6.1 [57][18]) —
  TruePoint's shipped `partial` terminal is *stronger* than both and is kept (03 §6.2 matrix).
- **Cancel = stop-remainder, never rollback** — committed changes stay; the remainder is reported
  as unprocessed, distinct from failed (03 §6.1 [61][60]); undo is a separate provenance-driven
  verb (03 §6.3 [6][28]).
- **Both error artifacts.** Only HubSpot and Salesforce ship a repair CSV (original columns
  echoed + appended error column) *and* an error report with typed codes and impact counts;
  HubSpot redacts sensitive values with `_REDACTED_` (03 §1.1 [5][52-row], §6.1 [58][5]).
- **Mapping:** auto-map is header↔field name matching, case/punctuation-insensitive; unmatched is
  a binary "Unmapped" with a per-column override and an explicit skip — **no vendor shows
  confidence percentages** (03 §1.1 [1][2][68][31], §1.3). Saved mappings exist per-user
  (Data Loader `.sdl`) or as repeat-a-past-import (HubSpot, 6-month window); **named shareable
  templates are shipped by nobody** — documented whitespace (03 §1.1 [4][32][33][21]).
- **In-flow typed custom-field creation is table stakes** (HubSpot property panel, Attio
  "+ Create new attribute"; 03 §1.1 [1][85]).
- **Merge strategy at import:** the create-and-update / create-only / update-only triad plus the
  orthogonal per-property "don't overwrite populated" switch (03 §2.2 matrix [1][38][79][95]);
  admin-default-with-user-choice (03 §2.3 [95]); bulk paths never row-block on duplicates —
  detection routes to a persistent review queue (03 §2.3 [34][8]).
- **Delta = upsert on a declared key with an explicit per-import mode; no platform exposes
  content hashing** (03 §6.1 [18][65]); cursors beat modified-since timestamps; deletes are
  invisible to delta (03 §6.1 [135][131]).
- **XLSX cannot be stream-read** (zip central directory at EOF); CSV streams row-by-row
  (03 §6.1 [143][144]).

## Gaps (register pointers — evidence in 01, linkage in 02)

| Gap | Sev | This doc's answer |
|---|---|---|
| **G03** | P0 | §1–§2: every import gets an `import_jobs` row; the durable row is the poll/list read; Redis demoted to transport |
| **G04** | P0 | §7: `GET /imports` keyset list + detail endpoint (page = doc 11; predicate = doc 10) |
| **G05** | P1 | §2/§6: tenant cancel verb (stop-remainder) + per-row retry as a child job |
| **G10** | P1 | §1: server-side routing consumes `BULK_IMPORT_THRESHOLD_ROWS`; the toggle dies (doc 11) |
| **G13** | P2 | §5: the triad + don't-overwrite switch, expressed through `planFieldWrite` |
| G14 | P1 | §6: the two-artifact contract + typed codes (redaction/encryption/retention = doc 13) |
| G06 | P1 | forward-ref: terminal transitions publish via the outbox — see 09 §notifications |
| G01/G02 | P0/P1 | forward-ref: owner predicate + import grant — see 10 §matrix; §7's repository signature carries the hook |
| G12, G25 | P2 | forward-ref: published limits, partitioning, 2M-row envelope — see 12 |

---

## Recommended Solution

### §1 The decisive call — one durable job model, server-routed 🔲

**Every import creates an `import_jobs` row and runs the §2 state machine.** The trio becomes the
single system of record for import state; BullMQ carries *work*, never *truth* (03 §6.1
[138][142] — the vendors' own framing). Two **processing modes** exist behind one contract,
chosen by the **server** at commit time:

| | `fast` mode | `copy` mode |
|---|---|---|
| When | measured rows ≤ `BULK_IMPORT_THRESHOLD_ROWS` **and** bytes ≤ the byte ceiling (doc 12 publishes both) | above either threshold |
| Chunks | exactly **one** chunk row (uniform accounting; the completer logic is unchanged) | ~10k-row bands per 15 §2 |
| Lane | priority lane on the import queue (mechanics: 09 §topology) | bulk lane |
| Merge engine | `runImport` per-row tx, unchanged (Phase A; §1.2), wrapped with trio writes | `bulkStage` + `bulkProcessChunk` per 15 §2, unchanged |
| Staging | none — no COPY, no staging table | the UNLOGGED staging path (the one RLS bypass, 07 §5) |
| Gate dependency | **none** (Phase A ships before G07/G08/G09 clear) | G07 + G09 (+ G08 per 13) — §8 |

**The threshold decision is the server's, made once, at commit, from measured facts** (parsed row
count + byte size), never from a client hint — G10's fix. `BULK_IMPORT_THRESHOLD_ROWS`
(`env.ts:235–237`, default 5000) is resurrected as exactly what its comment promised: the
consumed promotion knob. Evidence for the shape: HubSpot's one-wizard/server-decided model vs
Salesforce's legacy two-tool split (03 §1.3 [1][3][30]); Salesforce Bulk 2.0's durable job model
as the reference contract (03 §7 [57]).

**XLSX exception (03 §6.1 [144]):** XLSX cannot be stream-parsed, so it is admitted only under
the fast-path thresholds; an over-threshold XLSX is refused at upload with an honest RFC 9457
problem (`xlsx_too_large`) telling the user to export CSV — never a dead-end toggle, never a
silent buffer-the-world.

**Before the copy gates clear**, an over-threshold file gets the same honest refusal
(`file_too_large`, carrying the current limits) — a truthful product limit instead of a
recommended failure (01 §4.1). When G07/G09 clear, the same commit call silently starts routing
those files to `copy` mode. The user-visible contract never changes; only the ceiling lifts.

#### §1.1 What "unify" concretely means

1. **One job identity.** `import_jobs.id` is the public `jobId` for both modes. The fast-path
   worker's BullMQ job is *named by* it (stable jobId = consumer-side dedupe, the house
   at-least-once discipline); the poll endpoint reads the **DB row**, never `Job.getState()`.
2. **One state vocabulary** (§2) with mode-specific paths through it (`staged` is copy-only).
3. **One accounting identity** — `created + matched + duplicate + skipped + rejected + deduped +
   unprocessed = rows_total` (15 §2) — enforced for fast mode too (the wrapper translates
   `runImport`'s summary into counter deltas + `import_job_rows` outcomes).
4. **One idempotency model** — the 3-level scheme restated from 15 §2: job-level
   `(workspace_id, idempotency_key)` partial unique; chunk-level `(job_id, chunk_index)` unique +
   terminal-skip resume; row-level `source_imports.content_hash`. Fast mode inherits all three
   (its single chunk is a real `import_job_chunks` row).
5. **One artifact contract** (§6) and **one history surface** (§7) regardless of mode.

#### §1.2 The compatibility window (cross-ref doc 15 §migration for sequencing)

- **Phase A (pre-gates, dual-gated dark):** the existing one-shot `POST /imports` flow gains
  trio dual-write — the route creates the job row (status `queued`, mode `fast`) before enqueue;
  rows continue to travel in the BullMQ payload exactly as today
  (`apps/api/src/features/import/queue.ts:46–51`) because the
  disk FileStore cannot be load-bearing multi-instance until G07 (01 §3.1). The worker wraps the
  unchanged `runImport`, writing state transitions, counter deltas, and the per-row ledger.
  History, list, cancel, and retry-failed all work from Phase A. Flag-off = byte-identical
  current behavior.
- **Phase B (post-G07):** the upload-once draft flow (§2.1/§3) activates — files land in the
  production FileStore at upload; the fast-path payload slims to `{jobId, scope}`; preview stops
  re-uploading the file.
- **Phase C (post-G07+G09, per 13 for G08):** `copy` mode engages above threshold. The legacy
  `POST /imports/bulk` routes are kept as thin delegates into the same engine for one release
  window, then retired; `GET /imports/:jobId` keeps its legacy response shape via the §2.4
  status mapping until clients migrate. The "Large file" toggle is deleted in doc 11's first
  slice (it can die in Phase A — the server routes regardless).

Retirement targets (end of window): the Redis-only poll read (`routes.ts:168–189` reading
BullMQ), the rows-in-payload transport, and the separate `/imports/bulk` public surface. The
BullMQ `imports` queue itself survives — as transport, with its shipped retry/backoff/DLQ
(01 §2.1 hops 5, 9); queue topology evolution is 09's.

### §2 The state machine 🔲

The shipped 9-state CHECK (`importJobs.ts:83–86`) is extended additively with three states that
reconcile the upload/mapping/preview wizard phases and visible backpressure:

- **`draft`** — file uploaded and stored, parse verdict + AV verdict recorded, mapping/preview
  iterating; nothing enqueued, nothing processed. The wizard lives here between upload and
  commit (the db-mgmt-research/05 §7.2 steps ①–④ happen against a draft). Drafts are excluded
  from history lists by default and reaped after 48 h (§Edge cases).
- **`uploading`** — reserved for the post-G07 presigned-multipart flow (job created, bytes in
  flight); direct multipart uploads skip it. Dead until Phase B.
- **`deferred`** — accepted but not queued because the per-workspace concurrency cap is reached;
  HubSpot's pattern of making the cap *visible as a state* (03 §6.1 [18]). Promotion
  deferred→queued is the scheduler's (09 §fairness); the cap value is doc 12's published limit.

#### §2.1 State table

Terminal = `completed | partial | failed | cancelled` (unchanged). `partial` is kept — stronger
than both Salesforce and HubSpot (03 §6.2 matrix).

| State | Terminal | Entered by | Legal exits | Notes |
|---|---|---|---|---|
| `uploading` | no | client `POST /imports` (multipart-presigned variant, Phase B) | `draft` (upload complete) · `failed` (upload failed/abandoned past TTL) | new (S-I1) |
| `draft` | no | client upload complete (server) | `queued` / `deferred` (client **commit**) · reaped (sweep; row deleted, audited) | new (S-I1); never listed in history by default |
| `queued` | no | client commit; legacy one-shot submit; scheduler promoting `deferred`; parent job spawning a retry child (§6.3) | `validating` (worker claim) · `cancelled` (client cancel) · `deferred` (re-shed, rare) | shipped |
| `deferred` | no | server at commit (workspace concurrency cap hit) | `queued` (scheduler, 09) · `cancelled` (client) | new (S-I1) |
| `validating` | no | worker (drive start: parse + validate; copy mode: stage begins) | `staged` (copy) · `running` (fast) · `failed` (parse error / AV `infected`) · `cancelled` (client request honored at boundary) | shipped; fast mode passes through |
| `staged` | no | worker (copy mode: COPY + within-file dedup done) | `running` (first chunk claimed) · `failed` · `cancelled` | shipped; copy-only |
| `running` | no | worker (chunk claim) | `completed` / `partial` (completer) · `failed` (systemic) · `paused` (**operator** — see db-mgmt-research/05 §5.1) · `cancelled` (client or operator; cooperative, §2.2) | shipped |
| `paused` | no | **operator only** (Surface 1; db-mgmt-research/05 §5.1) | `running` (operator resume) · `cancelled` | shipped; tenant surface renders it read-only ("paused by TruePoint support") |
| `completed` | yes | worker completer (0 rejected/unprocessed) | — | shipped |
| `partial` | yes | worker completer (≥1 rejected/unprocessed) | — | shipped; success-with-rejects, artifacts available (§6) |
| `failed` | yes | worker (systemic: parse, AV, storage, exhausted retries) | — | shipped; `failed_reason` set, PII-free |
| `cancelled` | yes | client cancel (owner ∪ elevated, matrix in 10) or operator cancel (db-mgmt-research/05 §9.2) | — | shipped state, first route that drives it (G05) |

Transition legality is enforced **server-side against the current row under `withTenantTx`**
(`FOR UPDATE` on the job row; the client's belief about state is never trusted) — an illegal
transition is a 409 problem (§2.3). The *legality matrix* is the shared contract with
db-mgmt-research/05 AC5, so the two surfaces can never disagree about which transitions exist;
on the status code the series diverge (AC5 wrote **422**) and this series standardizes on
**409 Conflict** (`illegal_state`) for state-legality violations — Surface 1 harmonizes to 409
when its operator routes ship (doc 16 records the alignment).

#### §2.2 Cancel semantics (G05) — stop-remainder, never rollback

Verbatim market contract (03 §6.1 [61][60], §6.3): committed rows stay committed; cancel stops
the remainder. Mechanically:

- From `draft`/`queued`/`deferred`: immediate transition; nothing ever ran.
- From `validating`/`staged`: the worker checks job status at stage boundaries and aborts;
  staging is dropped; no overlay write happened yet.
- From `running`: **cooperative** — BullMQ has no first-class cancel of an active job (03 §6.1
  [140][141]), so chunk runners re-read job status at chunk claim *and* per merge batch inside
  the chunk; on `cancelled` they stop, mark their remaining band rows `unprocessed`, and exit.
  The in-flight batch completes (per-chunk tx atomicity). Rows already promoted are kept — the
  UI copy says so explicitly ("Contacts already imported are kept"), and the unprocessed count
  is reported distinctly from failed (03 §6.1 [60]).
- Undo is **not** cancel: "delete what this import created" is a separate, provenance-driven
  verb over `source_imports` (03 §6.3 [6][28]) — recorded as a future extension in doc 14, not
  designed here.

Who may cancel: creator ∪ org-elevated — the exact matrix is doc 10's (anchored on Salesforce's
creator-or-permission abort rule, 03 §5.1 [56]). Operator cancel stays on the Surface-1 path
(`withPlatformTx`-audited, db-mgmt-research/05 §9.2) — two entry surfaces, one transition.

#### §2.3 Verb table — idempotency, rate limits, RFC 9457 taxonomy

All routes `/api/v1`, `authn` → `tenancy` → `rateLimit`, shared Zod shapes in `@leadwolf/types`.
**Every mutating verb requires `Idempotency-Key`** (house contract; today only bulk submit
honors it — this extends it to the whole surface). Problem `type` slugs are stable and
machine-readable (HubSpot's typed-vocabulary lesson, 03 §6.1 [5][18]).

| Verb | Route | Idempotency | Rate/quota | Problems (RFC 9457 `type`) |
|---|---|---|---|---|
| Upload (create draft) | `POST /imports` (multipart) | key collapses onto the existing draft via the shipped partial unique | per-route rateLimit + byte ceiling → 413 | `no_workspace` 403 · `import_validation_failed` 422 (bad form) · `file_too_large` / `xlsx_too_large` 413 · `unsupported_media_type` 415 · `import_quota_exceeded` 429 |
| Save mapping/options | `PUT /imports/:id/mapping` | naturally idempotent (full replace) | rateLimit | `not_found` 404 · `illegal_state` 409 (not `draft`) · `import_validation_failed` 422 (bad mapping / unknown field) |
| Preview | `POST /imports/:id/preview` | read-shaped (no state change) | rateLimit (CPU-bound — stricter bucket) | 404 · 409 (not `draft`) |
| Commit | `POST /imports/:id/commit` | key required; replay returns the first response (job already queued/running) | **per-workspace commit quota** (default 20/h, config knob; published in 12) → 429 `import_quota_exceeded`; concurrency cap → `deferred` state, not an error | 404 · `illegal_state` 409 · 422 (no mapping saved) · `bulk_import_disabled` 403 (copy mode gated off — Phase A/B only) |
| Cancel | `POST /imports/:id/cancel` | idempotent (cancel-on-cancelled = 200 no-op) | rateLimit | 404 · `illegal_state` 409 (terminal, non-cancellable) · `forbidden` 403 (not creator/elevated — 10) |
| Retry failed rows | `POST /imports/:id/retry-failed` | key required; replay returns the same child jobId | counts against the commit quota | 404 · `illegal_state` 409 (not terminal / nothing to retry) · 403 (10) |
| List | `GET /imports` | — | rateLimit | cursor problems 400 |
| Detail | `GET /imports/:id` | — | rateLimit | 404 (foreign/absent — never leak existence, the shipped posture `bulkRoutes.ts:242`) |
| Artifacts | `GET /imports/:id/artifacts/:kind` | — | rateLimit; download **audited** (§7) | 404 · 403 (tightest gate — 10) |
| Templates | `GET/PUT/DELETE /imports/mapping-templates…` | PUT upserts by name (shipped unique) | rateLimit | 404 · 422 |
| Legacy one-shot | `POST /imports` with `mapping` form field present | key honored (new) | as upload+commit combined | the union of upload+commit problems |

The legacy one-shot call is distinguished by the presence of the `mapping` form field — a
backward-compatible dispatch inside one route (today's clients keep working unchanged through
the window; the server simply also creates the durable row).

#### §2.4 Legacy status mapping (compatibility window only)

Old clients polling the legacy shape get: `draft/uploading` — never visible (legacy flow skips
them); `queued/deferred → queued`; `validating/staged/running/paused → active`;
`completed/partial → completed` (summary carries the reject counts, as today);
`failed → failed`; `cancelled → failed` with `failedReason: "cancelled"` (the legacy enum
predates the verb). New clients read the real vocabulary.

### §3 The mapping subsystem 🔲

#### §3.1 Saved templates — reuse the shipped table, add sharing (the leapfrog)

`import_mapping_templates` (shipped) is the substrate. S-I2 adds one additive column:
`visibility varchar CHECK ('private','workspace')`, default `'workspace'` (preserving current
semantics — existing rows stay workspace-visible). Private templates are the Data Loader
`.sdl`-per-user analog (03 §1.1 [32][33]); workspace templates are the **named shared template
no vendor ships** (03 §1.1 [21] — documented whitespace, deliberately leapfrogged). A template
stores the mapping **plus the §5 strategy block** (merge mode, preserve-populated, options) —
HubSpot's "Use as template" copies per-column don't-overwrite too (03 §1.1 [4]); ours does the
equivalent as a first-class named object with no 6-month expiry. "Save these settings as a
template" is offered at commit and from a past import's detail view (repeat-a-past-import,
03 §1.1 [4]). The job row records `mapping_template_id` (FK SET NULL) for provenance.

#### §3.2 Auto-mapping — binary, overridable, no fake confidence

On upload, the server proposes a mapping: header text normalized (case, punctuation, whitespace —
the Salesforce matching posture, 03 §1.1 [68][31]) and matched against (a) canonical field names
and their alias table (e.g. "e-mail", "email address" → `email`), (b) the workspace's custom-field
registry keys/labels (ADR-0028), (c) the multi-value channel slots (`mobile_phone` → phone type
`mobile`; `hq_phone` → `hq`; `secondary_email` → email type `personal` — the 05 §6 slot
vocabulary), (d) the account multi-domain column (06 §1). Sampled values feed light **type
inference** as a tiebreaker only (a column of `@`-strings prefers `email`). The result per column
is strictly **mapped / unmapped** with a per-column override dropdown and an explicit
"Don't import column" (03 §1.1 [1][85]) — **no confidence percentages** (03 §1.3: no vendor
shows them; binary + override is parity). Unmapped required fields block commit with a clear 422
(fail-fast header verdict, db-mgmt-research/05 §7.2 ③).

**Mapping addressing:** the stored mapping addresses columns by **ordinal index with the header
as label**, not by header string alone — this is what makes duplicate headers representable
(§Edge cases) and re-runs stable. The shipped `columnMappingSchema` (header-keyed) is accepted on
the legacy path and normalized to indexed form server-side.

#### §3.3 In-flow custom-field creation (table stakes)

The mapping step offers "+ Create field" for an unmapped column: a typed creation call against
the ADR-0028 registry (`custom_field_definitions` — the shipped per-workspace typed registry,
01 §6.7), then the column maps to `cf:<key>`. Type is chosen explicitly (the registry's 6 types),
prefilled by the same inference. This is HubSpot's in-flow property panel / Attio's "+ Create new
attribute" (03 §1.1 [1][85]). Role gate for field creation = the registry's existing gate (doc 10
notes it); Salesforce's admin-locked schema is the anti-pattern for this product tier (03 §1.1
[30]).

### §4 Validation & preview 🔲

- **Shared Zod row schemas.** Validation is `validateRow` against `canonicalContactRowSchema` in
  `@leadwolf/types` — the single source (platform contract). The multi-value extension is 04 §6's
  additive `additionalEmails`/`additionalPhones` arrays, populated by the mapper when multiple
  source columns map to channel slots; absent arrays = byte-identical behavior.
- **Preview = first-N validated sample + full-file projection.** `POST /imports/:id/preview`
  streams the stored draft file once (constant memory): the first N (50) rows return fully
  validated with per-field verdicts (the editable-grid input for doc 11); the full pass produces
  the **error-count projection** — total / valid / rejected / would-create vs would-update
  (Attio's effect preview, 03 §1.1 [85]) / duplicate-in-file — and a **per-column feedback
  block** (per column: parse-failure count, dominant reject code, sample line numbers). HubSpot
  validates the full file on the mapping screen (03 §1.1 [1][5]); we match it. The non-PII
  projection (counts + histogram only, never row values) is cached on the draft row
  (`preview_summary` jsonb, S-I1) so re-renders don't re-scan; sample rows are recomputed per
  request and never persisted on the control row.
- **Reject taxonomy.** One stable, machine-readable code vocabulary shared by preview, the
  ledger's `reject_reason`, the histogram labels (the shipped `rejectLabel` seam,
  `importJobs.ts:67–70`), and both artifacts (§6) — the HubSpot pattern (50+ typed codes with
  impact counts, 03 §6.1 [5][18]). The taxonomy is **aligned with
  [`../database-management-research/06-Data-Validation-Framework.md`](../database-management-research/06-Data-Validation-Framework.md)**
  (the Surface-1 validation spec) — one vocabulary, two surfaces; codes this series adds:
  `no_match_update_only`, `ambiguous_company_match` (06 §5), `phone_unparseable` (a **warning**,
  not a reject — 05 §4), `channel_cap_exceeded` (warning, 05 §pre-build), `duplicate_header`,
  `encoding_suspect`.
- **Warnings ≠ rejects.** The histogram gains a warning band (05 §4 already requires it for
  unparseable phones): the row lands, the anomaly is counted and reported.

### §5 Import-time dedup & merge strategies (G13) 🔲

#### §5.1 The strategy surface

Replace the `conflictPolicy` triple with the market surface (03 §2.2 matrix [1][38][79][95]):

- **`merge_mode`** ∈ `create_and_update` (default) · `create_only` · `update_only`;
- **`preserve_populated`** boolean (orthogonal): when true, an update never overwrites a
  populated value — only fills blanks (HubSpot's per-property "prevent overwrite" ethos applied
  as one honest switch first; per-property granularity is a doc 14 enhancement);
- an **org-admin workspace default** for both (ZoomInfo's admin-default-with-user-choice,
  03 §2.3 [95]) — the setting's permission ride is doc 10's.

Legacy mapping (compatibility window): `skip` → `create_only`; `overwrite` →
`create_and_update`; `keep_both` → **retired** (no market analog, 03 §2.2 — it manufactured the
duplicates the review queue exists to prevent; legacy submissions carrying it get
`create_only` + a deprecation warning in the response).

#### §5.2 Expression through `planFieldWrite` — never SQL (restating 15 §1, rationale 2)

The strategy layer is a *policy input* to the canonical planner, not a new write engine. For a
matched row in an updating mode, the executor computes the incoming field set, drops populated
targets when `preserve_populated` is on, and hands the remainder to
`planFieldWrite(existingProvenance, fields, { src: "import:<source>", obs, conf })` — so a
**pinned field survives every import strategy unconditionally** (DM6; the pin is the user's
override of all automation). This is byte-identical machinery for fast and copy modes (both
already call `planFieldWrite` — `runImport.ts:314`, 15 §2 chunk step). Re-expressing any of this
as SQL `CASE` over `field_provenance` is forbidden by the design-of-record (15 §1 fact 2) and by
CLAUDE.md's correctness-over-structure rule — restated here because the strategy triad is
exactly where a "simple SQL upsert" would be tempting and wrong (the ladder spans three partial
uniques; 15 §1 fact 1).

Channel values are **not** governed by `merge_mode`: they follow 05 §6's append-with-dedup
policy (append as secondary, never flip a primary, `replace` not offered) — losing data by
import is structurally impossible regardless of strategy.

#### §5.3 The ladders (consumed, not re-spec'd)

- **Contacts (04 §2):** primary identity = the three shipped partial uniques, precedence
  email → linkedin → sales-nav, unchanged. Post-05-cutover the email rung resolves against
  **every live `contact_emails` value** (deterministic — 05 §2.2's per-workspace value unique);
  **phone E.164 is a match signal only, never an upsert key** (shared HQ lines are legal; phone
  is a dedup key nowhere in the market — 05 §2.2).
- **Companies (06 §5):** C1 primary-domain cache hit ≡ C2 any-live-`account_domains` hit →
  proceed under the row's strategy; C3 name+country is **review-only**; a row whose domains
  resolve to ≥2 distinct accounts **fails loudly to review** (`ambiguous_company_match`), never
  a silent pick (03 §4.1 [8][82]).
- **Match-vs-act split (04 §2, 03 §2.1 [34]):** signals that are not identity (phone hit,
  cross-key conflict, C3) never block or silently update a row. The row lands per its strategy
  and a `duplicate_of_contact_id` marker is written toward the signalled record, feeding the
  persistent review queue (G21 — queue object semantics in 04 §3.5; surface in doc 11). The job
  detail reports a **"N potential duplicates flagged"** rollup (03 §2.3). Bulk paths never
  row-block on duplicates (03 §2.3 [34]).
- **`update_only` misses** land as outcome `skipped` with code `no_match_update_only` — visible
  in the histogram and the error report (HubSpot's `CREATE_ONLY_IMPORT`-class mode-violation
  codes, 03 §6.1 [18]).

### §6 Partial success & error reporting 🔲

#### §6.1 The ledger is the truth

`import_job_rows` (shipped) carries one row per input line with outcome ∈
`created | matched | duplicate | skipped | rejected | unprocessed` (`importJobs.ts:151–157`) —
`failed vs unprocessed` reported distinctly per the Salesforce three-resource split (03 §6.1
[58][60]). Fast mode writes it too (§1.1). `partial` remains a job-level terminal while row
truth lives in the ledger — "done is job-level; partial success is a property of the results"
(03 §6.1 [57][18]), which the shipped design already got right.

#### §6.2 Two downloadable artifacts (the market-topping pair — 03 §1.1 [5], §6.1 [58])

| Artifact | Content | Purpose |
|---|---|---|
| **Repair CSV** (`rejected` + `unprocessed` rows) | the user's **original columns echoed byte-faithfully**, plus appended `tp__error_code` and `tp__error_detail` columns (the `sf__Error` convention, 03 §6.1 [58]) | fix-and-reimport — feeds §6.3 retry directly |
| **Error report CSV** | aggregated: error code · column · impact count · sample line numbers (the errors-by-type impact table, 03 §6.1 [5]) | triage without opening 50k rows |

Both are **PII-bearing** (the repair CSV *is* the user's data; the error detail may quote a
value) and take the full protection envelope: encrypted at rest, signed **expiring** download
URLs, importer-or-elevated access (the tightest gate — HubSpot restricts the original-file
download to "the user who completed the import or Super Admin", 03 §5.1 [6]; matrix in doc 10),
download **audited** (03 §5.1 [7]), retention class per doc 13, and the `_REDACTED_` pass on
sensitive columns in the **error report** (03 §6.1 [5][18] — mandatory under the never-log-PII
posture; full spec in 13, which also audits the existing rejected-rows artifact against it —
G14). The shipped single `rejected-rows.csv` (`runBulkImport.ts:132–141`) becomes the repair
CSV's predecessor; S-I7 supersedes it with the pair, and adds the missing
`rejected_artifact_key` write-back the current code defers (`runBulkImport.ts:131` comment).

#### §6.3 Per-row retry as a child job (parent linkage)

`POST /imports/:id/retry-failed` on a terminal `partial`/`failed` job creates a **child**
`import_jobs` row with `parent_job_id = :id` (S-I1): source = the failed+unprocessed rows
re-extracted by `row_index` from the stored source object (Phase B; in Phase A, from the repair
artifact), mapping/strategy **inherited** from the parent (overridable), routed through §1 like
any commit. The child appears in history linked under its parent; counters are its own. Replay
of the same Idempotency-Key returns the same child. Retrying a retry chains normally
(parent pointers form a bounded list, each generation strictly smaller). This is
fix-and-reimport without the download-edit-upload loop when the failure was transient or
mapping-fixable — and with it when not (the repair CSV exists for hand-editing).

### §7 History & audit 🔲

- **`GET /api/v1/imports`** — the durable list (G04). Keyset pagination only (house contract) on
  the **new composite `(workspace_id, created_at DESC, id DESC)` index** — flagged missing by
  07 §4.3 (`listJobsByWorkspace` orders by it with no backing composite today); the index ships
  in S-I1, in this doc's step set as 07 assigned. Filters: status, source, creator (subject
  to visibility), date window. **Drafts excluded** by default (`state=draft` opt-in for wizard
  resume).
- **Visibility (forward-ref, load-bearing):** the list repository's signature takes a **required
  viewer context** parameter — doc 10's enforcement pattern (omission is a type error, not a
  leak). Default: members see own jobs; org admins see all with creator attribution — the
  HubSpot export-log rule + Salesforce creator-or-permission anchors (03 §5.1 [7][56]); the full
  matrix incl. the "import at all" grant (G02) is 10's. This endpoint must not ship before 10's
  predicate lands on it (a workspace-wide list would be a *fourth* leaking surface — 01 §5.7).
- **`GET /api/v1/imports/:id`** — detail: status, mode, counts, progress
  (`completed_chunks/total_chunks` + row counters — the durable-counter contract polled
  indefinitely, 03 §6.1 [56][129]; transport garnish like SSE is 09's), reject histogram
  (+ warning band), duplicate-flag rollup, artifact descriptors (URLs minted only for callers
  passing 10's artifact gate), parent/child links, creator attribution.
- **Provenance unchanged:** `source_imports` stays the only lineage (ADR-0006); one row per
  landed line; the Recent-Imports card keeps reading it (its visibility fix is 10's, program
  decision 3).
- **Audit (in-tx, never fire-and-forget):** lifecycle verbs write `audit_log` rows in the same
  transaction as the transition — `import.committed`, `import.cancelled`,
  `import.retry_created`, `import.draft_reaped`, `import.artifact_downloaded` (download
  auditing per 03 §5.1 [7]), `import.template_saved` — closed-enum extensions ride S-I9 (same
  CHECK-extension mechanics as 04's S-C2). Worker-driven transitions (validating/staged/
  terminal) are already evidenced by the job row's own columns + counters; audit rows cover
  **actor-initiated** verbs, where "who did this" is the compliance question.

### §8 The three enable-gates — what "cleared" means ❌ (criteria only; phase placement in 14)

These are **enable-gates, not build-gates** (15 §6) — everything in §1–§7 except copy-mode
engagement and the Phase-B draft flow ships dark ahead of them. Acceptance criteria align with
db-mgmt-research/05 §5.3/§13 so the two series cannot diverge on "done":

| Gate | Gap | Cleared means (all of) |
|---|---|---|
| **Object store** | G07 | An S3-class adapter implements the `FileStore` port verbatim (`fileStore.ts` port, db-mgmt-research/05 §5.3 Gate B) at the api/workers composition roots (core stays SDK-free); presigned multipart upload; SSE-KMS at rest; signed **expiring** download URLs; AV-scan-before-promote seam honored; `diskFileStore` never selected when `NODE_ENV=production` (AC2); api+worker read/write the same bucket from different instances (the 01 §3.1 failure mode demonstrably closed) |
| **AV scan** | G08 | A real scanner injected at the `scanUpload()` seam (`bulkRoutes.ts:126–128`); `infected` refused before any job exists and re-checked before staging promote; no prod upload ever records `av_scan_status='skipped'`; the infected path integration-tested. Scanner choice + the wider upload-security envelope (content sniffing, archive bombs, CSV formula injection) = doc 13 |
| **COPY spike** | G09 | The three assertions in the shipped banner proven on real Postgres under Bun (`importStagingRepository.ts:10–17`): (1) `unsafe(<COPY … FROM STDIN>).writable()` returns a backpressure-aware Writable; (2) the CSV encoding (bytea `\x` hex, unquoted-empty NULL, quoted text/json) round-trips byte-for-byte; (3) bytea reads back as Buffer — result recorded in an ADR addendum (db-mgmt-research/05 AC1); target throughput anchored to the 10k-row internal-batch precedent (03 §6.3 [63][77], envelope in doc 12) |

Until G07+G09: fast path only, honest `file_too_large` ceiling (§1). G08's relationship to
launch (blocker vs fast-follow for the *fast* path, which today runs unscanned in prod anyway)
is doc 13's call, sequenced in 14.

### §9 Phased extensions (design sketches only — phasing in 14)

- **Scheduled imports.** A per-workspace schedule definition (cron + a connected source or a
  re-uploaded template file) whose tick **creates an ordinary `import_jobs` row** — same trio,
  same machine, `created_by_user_id` null-with-schedule-pointer (the "system/automation"
  semantics the column already documents, `importJobs.ts:45`). No new execution machinery;
  the scheduler is a leader-locked sweep (09's idiom).
- **Incremental / delta.** Three layers, per the market (03 §6.1 [18][65][135][131]): (1) the
  row-grain `content_hash` skip **already shipped** on `source_imports` stays an internal
  merge-core optimization (no platform exposes hashing as UX — 03 §6.1); (2) **upsert-on-
  declared-key with the explicit per-import mode** is §5 riding the shipped uniques — delivered,
  not future; (3) *new*: an `external_id` upsert option (map a column as the caller's stable
  key; needs a per-workspace `(workspace_id, external_id)` unique — schema sketch only, owned by
  a future step in 14) and a `modified_since` filter for connected sources — with the honest
  caveats: cursors beat timestamps and deletes are invisible to deltas (periodic full re-sync,
  03 §6.1 [135][131]); conflict strategy defers to the `field_provenance` winner-map + `pin`.
- **API-push imports.** `POST /imports` graduates to a public contract: JSON/NDJSON body
  variant (no multipart), same draft→commit or one-shot semantics, same limits/idempotency —
  the Salesforce Bulk-2.0-shaped surface (03 §7 [57]) TruePoint gets nearly free because the
  job model is already durable. Public-API packaging (keys, scopes, docs) = doc 14 future.
- **CRM-pull (Salesforce/HubSpot sync).** Out of scope — cross-link the crm-sync planning when
  it exists; the only contract this doc pins is that a pulled batch lands as an `import_jobs`
  row like everything else.

---

## Pre-build reasoning pass (explicit answers)

Per `truepoint-architecture/references/pre-build-thinking.md`; answers cite the owning skills.

- **Source of truth.** Job state: the `import_jobs` row, exclusively — BullMQ state is transport
  (a worker crash loses an attempt, never the record). Source bytes: the FileStore object
  (Phase B+; Phase A fast path: the enqueued payload, with the job row still owning *state*).
  Row outcomes: `import_job_rows`. Lineage: `source_imports` (ADR-0006). Mapping: the draft
  row's stored config; templates are named copies, never live references. On any
  Redis-vs-Postgres disagreement, Postgres wins and the worker reconciles (idempotent replay).
  No datum has two owners.
- **Failure modes.** *Crash mid-chunk:* chunk retry re-runs idempotently (row `content_hash` +
  dedup-key upserts make re-promotion a no-op; 15 §2); lease-expired chunks are the reaper's
  (db-mgmt-research/05 §5.4 — cross-ref, not duplicated). *Crash mid-drive:* watermark resume
  never re-stages (`runBulkImport.ts:94–110`). *FileStore object lost:* copy mode — job
  `failed` with a clear reason (staging is UNLOGGED and expendable *because* the object is
  truth; losing the object is the one unrecoverable input loss, hence G07's durability bar);
  fast mode Phase A is immune (payload transport). *Storage write fails at upload:* job marked
  `failed` best-effort, error surfaced (shipped posture, `bulkRoutes.ts:209–220`). *Double
  submit:* the 3-level idempotency (§1.1) — the same key returns the same job; an identical
  file without a key is flagged via `file_content_hash` (owned by db-mgmt-research/05 §8.2 Gate
  C; consumed here as the "looks identical to job X" pre-flight). *Worker dead:* jobs sit
  `queued`, visibly — the history page makes stuck-ness observable instead of a give-up toast
  (G11's substrate). *Preview slow on huge files:* preview is copy-mode-Phase-B territory;
  rate-limited, streaming, and bounded — worst case the projection lands async on the draft.
- **Duplicate prevention.** DB level: the three contact partial uniques + child-table uniques
  (05 §2.2) + `(workspace_id, idempotency_key)` + `(job_id, chunk_index)` +
  `source_imports.content_hash`. API level: Idempotency-Key on every mutating verb (§2.3).
  Within-file: `DISTINCT ON (identity_key)` in staging (copy) / first-wins in the fast wrapper.
  Cross-record: the §5.3 ladders; ambiguity → review, never silent (06 §5).
- **Audit.** §7: in-tx `audit_log` for every actor verb incl. artifact downloads; the job row +
  counters + ledger evidence worker transitions; support reconstructs any import from
  row + ledger + audit alone.
- **Security** (truepoint-security checklist). *Access/IDOR:* every verb runs `withTenantTx`
  with the explicit workspace re-check (shipped posture); foreign/absent ids 404 without
  leaking existence; the list endpoint takes 10's required viewer context — it does not ship
  without it. *Upload validation* (content sniffing, size caps pre-buffer, formula injection,
  archive handling): **deferred to doc 13 in full**; this doc pins only the seams (AV gate,
  extension sanitization already shipped at `bulkRoutes.ts:114–119`, byte ceilings). *PII:*
  prepared rows are encrypted before staging (15 §2); artifacts take §6.2's envelope; problem
  details, histograms, and audit metadata never carry row values (the shipped `rejectLabel`
  discipline). *Privilege:* strategy defaults are org-admin-set server-side; the client never
  submits a capability. *Abuse:* commit quota + preview rate bucket + byte ceilings (§2.3);
  channel caps per 05. Staging remains the one sanctioned bypass, unchanged (07 §5).
- **Scalability (10x).** The 2M-row envelope — COPY math, chunk sizing, `import_job_rows`
  growth/partitioning (G25), published limit numbers (G12) — is **doc 12's**; this design's
  scale posture: no unbounded reads (list is keyset on a backing index; detail reads counters,
  not rows; row drill-down is paginated), fast/copy routing keeps the request thread out of the
  heavy path above threshold, one chunk row per fast job adds ~1 row/import of overhead, and
  the trio already mirrors the proven enrichment-trio shape at scale (01 §7.4).
- **Monitoring.** Forward-ref 09 §observability for the metrics surface; this doc's named
  signals: jobs by state (stuck-`queued` age alarm), counter-reconciliation identity violations
  (must be 0), reject/warning rates per source, deferred depth, cancel latency, draft-reap
  count, artifact-download audit volume.
- **Rollback.** Every phase is dual-gated (env kill-switch + per-tenant flag, 01 §7.3):
  `IMPORT_V2_ENABLED` + `import_v2_enabled` for the unified surface; copy-mode engagement
  additionally behind the existing `BULK_IMPORT_ENABLED` pair. Flag-off = byte-identical legacy
  behavior (Phase A dual-writes are additive; S-I1 columns/states are additive and unread when
  off). The compatibility window (§1.2) means no client breaks at any flip; migrations are
  expand-only with written down-migrations.
- **Edge cases.** *Empty file (0 bytes):* 422 `import_validation_failed` at upload, no job.
  *Header-only:* commit finalizes inline to `completed` with `rows_total=0` (shipped E1
  behavior, `runBulkImport.ts:161–169`; fast mode mirrors it). *Single row:* fast mode, one
  chunk, full ledger — no special case. *Duplicate headers:* representable via ordinal-indexed
  mapping (§3.2); preview warns `duplicate_header`; auto-map refuses to guess between them
  (both unmapped until the user picks). *Wrong encoding:* BOM/UTF-16 detected and decoded;
  undecodable bytes → per-row `encoding_suspect` warnings when sparse, whole-file 422 with a
  clear problem when systemic — never silent mojibake. *Cancelled mid-parse:* honored at the
  next stage boundary; nothing promoted; staging dropped (§2.2). *Commit with no mapping:* 422.
  *Draft abandoned:* reaped at 48 h — the draft row is deleted outright with its file object
  and an `import.draft_reaped` audit event (drafts never entered execution and appear in no
  history; keeping tombstoned drafts would pollute retention for zero forensic value).
  *Unknown enum from a future client:* closed CHECKs + Zod reject at the edge.
- **Assumptions (written down).** (1) Single-region deployment (the platform skill's current
  reality); multi-region changes the FileStore/queue story, not the state machine. (2) The
  fast-path threshold assumes ~5k prepared rows fit comfortably in a job payload/worker memory —
  revisit the default if the canonical row grows channel arrays materially (05 §6).
  (3) Drafts-in-store are small in aggregate (48 h TTL bounds them). (4) The legacy window is
  months, not years — 14 sets the retirement date.
- **Worst case + detection.** *A wrong-strategy import silently overwriting a workspace's
  hand-curated data:* bounded by `preserve_populated`, structurally bounded by pins
  (`planFieldWrite` — a pinned field is immune no matter what the wizard sent), made visible
  by the preview's would-update projection *before* commit and by counters + per-row ledger
  after; recoverable via `field_provenance` history in the audit trail and, in extremis, the
  provenance-driven undo (future verb, §2.2). *The systemic worst case — rows landing in the
  wrong workspace:* structurally blocked by `withTenantTx` RLS on every promote (the one bypass
  never touches overlay tables, 07 §5) and covered by the mandatory isolation itest (T2 below +
  db-mgmt-research/05 §11's staging-predicate test). Neither scenario is undetectable or
  unrecoverable; no approval-gate escalation is required beyond the flags.

---

## Implementation Steps (step IDs — doc 15 sequences; statuses per series legend)

| Step | What ships | DDL | Depends on |
|---|---|---|---|
| **S-I1** | `import_jobs` additive columns: `processing_mode` CHECK (`fast`,`copy`) · `merge_mode` CHECK (triad) + `preserve_populated` boolean · `parent_job_id` uuid self-FK (SET NULL) · `source_filename` varchar · `mapping_template_id` FK → `import_mapping_templates` (SET NULL) · `options` jsonb (countryHint, primary-from-column, delimiter…) · `preview_summary` jsonb (non-PII) · status-CHECK extension (`draft`,`uploading`,`deferred`) · the keyset index `(workspace_id, created_at DESC, id DESC)` (07 §4.3) | Yes | — |
| **S-I2** | `import_mapping_templates.visibility` (`private`\|`workspace`, default workspace) + template strategy block | Yes | — |
| **S-I3** | Phase-A fast-path dual-write: worker wrapper around unchanged `runImport` writing transitions + counter deltas + `import_job_rows`; jobId = `import_jobs.id`; poll reads the row | No | S-I1; dual-gate `IMPORT_V2_ENABLED` + tenant flag |
| **S-I4** | Tenant surface: `GET /imports` (keyset, viewer-context signature) + `GET /imports/:id` + `POST /imports/:id/cancel` (§2.2) — **list ships only with 10's predicate** | No | S-I1, S-I3; doc 10 §matrix |
| **S-I5** | Server-side routing: consume `BULK_IMPORT_THRESHOLD_ROWS` (+ byte/XLSX ceilings) at commit/one-shot; honest `file_too_large` pre-gates; toggle removal rides doc 11 | No | S-I3 |
| **S-I6** | Strategy triad: `merge_mode`/`preserve_populated` through `planFieldWrite` in both engines; legacy `conflictPolicy` mapping; org-admin default setting | No | S-I1 |
| **S-I7** | Artifact pair: repair CSV + error report, typed-code vocabulary shared with preview/ledger, `rejected_artifact_key` write-back, signed expiring URLs, download audit; redaction/encryption per doc 13 | No | S-I3; 13 §artifacts |
| **S-I8** | Draft flow: upload-once (`draft` state), `PUT mapping`, `POST preview` (sample + projection + per-column feedback), auto-map + alias table + in-flow custom-field creation, commit verb, draft reaper | No | **G07**; S-I1, S-I5 |
| **S-I9** | Copy-mode engagement above threshold; `/imports/bulk` delegation then retirement; legacy status mapping window; audit-action CHECK extensions (one migration with 04's S-C2 family at PR time) | Yes (audit CHECK) | **G07 + G09** (G08 per 13/14); S-I4–S-I8 |
| **S-I10** | Retry-failed child jobs (`parent_job_id` flow) + per-workspace commit quota + deferred-state shed (promotion mechanics land with 09's scheduler) | No | S-I4; 09 §fairness |

Extensions in §9 carry no S-I steps — they enter the roadmap as doc 14 future items.

## UI/UX (pointer — doc 11 owns every surface)

Doc 11 consumes these contracts: the dedicated Imports section over §7's endpoints (kill the
toggle, G10; durable progress that survives navigation, G11), the wizard over the draft flow
(§2.1/§3/§4 — upload → map (templates/auto-map/create-field) → preview (sample grid + effect
projection) → strategy → commit), cancel with stop-remainder copy, the artifact downloads, the
duplicate-review entry point (G21), `StateSwitch` four-states / `@leadwolf/ui` / aria-live
progress throughout. Nothing renders here.

## DB & Backend (summary)

S-I1/S-I2/S-I9 DDL above — all additive; no column renamed, dropped, or repurposed; the trio's
shape, RLS, and the staging bypass are untouched (07 §3/§5). New/changed code lands in the
existing homes: `packages/core/src/import/` (fast wrapper, strategy layer, preview projection,
artifact writers), `apps/api/src/features/import/` (unified routes; bulkRoutes delegates then
retires), `apps/workers` (consumer wiring; queue mechanics per 09), `packages/db`
(`importJobRepository` verbs: legal-transition guard, list-with-viewer-context, retry-child
create). One merge-planning implementation (`planFieldWrite`) serves both modes (DM1).

## API (summary)

§2.3 is the verb table; shapes ship as shared Zod in `@leadwolf/types`
(`importJobSchema`, `importJobListItemSchema`, `importPreviewSchema` v2, `importStrategySchema`,
`mappingTemplateSchema` v2, `importArtifactDescriptorSchema`) — masked/non-PII by construction
(counts, codes, statuses; sample rows only in the preview response, never persisted). All
`/api/v1`, keyset cursors, Idempotency-Key, RFC 9457 problems with the §2.3 stable `type` slugs.

## Edge Cases

Consolidated in the pre-build pass (empty/header-only/1-row files, duplicate headers, encoding,
cancel mid-parse, draft abandonment, unknown enums, no-mapping commit) plus §2.2 (cancel
semantics), §5.3 (ambiguity/update-only misses), §6.3 (retry chains), db-mgmt-research/05 §10
(E1–E15 — the copy-mode engine's cases, shared, not duplicated).

## Testing (hooks — CI-run; this sandbox cannot execute gates)

- **T1 Parity:** flags off ⇒ `POST /imports` byte-identical to shipped behavior (response, queue
  payload, DB effects) — the 15 §8 discipline extended to Phase A.
- **T2 Isolation:** foreign-workspace `GET/cancel/retry/artifact` → 404/403, nothing written;
  the list endpoint under 10's viewer contexts (member sees own; admin sees all) — plus the
  staging-predicate test stays mandatory (db-mgmt-research/05 §11).
- **T3 State machine:** every legal transition reachable; every illegal one → 409
  `illegal_state`; cancel-on-cancelled = 200 no-op; fast path never enters `staged`.
- **T4 Accounting identity:** for both modes, seeded files reconcile
  `created+matched+duplicate+skipped+rejected+deduped+unprocessed = rows_total` exactly.
- **T5 Idempotency:** same-key upload/commit/retry replay = same job/child, no second effect;
  chunk re-run promotes nothing twice; content-hash re-import lands `skipped`.
- **T6 Strategy:** triad × preserve_populated matrix over matched rows; pinned field survives
  every combination (assert descriptor unchanged); legacy `conflictPolicy` mapping;
  `no_match_update_only` outcome.
- **T7 Routing:** rows/bytes just under/over threshold pick fast/copy; over-threshold pre-gate
  ⇒ `file_too_large`; XLSX ceiling enforced.
- **T8 Artifacts:** repair CSV echoes original columns byte-faithfully + appended code columns;
  error report aggregates with `_REDACTED_` values; URLs expire; downloads audited.
- **T9 Cancel:** mid-run cancel stops the remainder, keeps committed rows, marks the rest
  `unprocessed`, drops staging.
- **T10 Retry-child:** child inherits mapping/strategy, processes only failed+unprocessed rows,
  links via `parent_job_id`; replay returns the same child.
- **T11 Preview/mapping:** projection counts match the eventual run on the same file; duplicate
  headers force explicit mapping; auto-map is deterministic; per-column feedback counts correct.
- **T12 Draft reap:** expired drafts + objects deleted, audit event written, committed jobs
  never reaped.

## Rollout

Phase A dark behind the `IMPORT_V2_ENABLED` dual-gate (internal workspaces first — history/
cancel/strategy on the fast path); Phase B after G07 (draft flow canary); Phase C after G07+G09
(+G08 per 13) — copy-mode per-tenant canary on the existing `bulk_import_enabled` flag, then the
legacy-surface retirement window. Full phase/gate placement, risks, and the retirement date:
doc 14; migration order and rehearsal: doc 15. Rollback at every stage = flag off (byte-identical
legacy behavior; executed imports keep their durable rows — data is never rolled back by a flag).

## Success Metrics

- **Zero vanished imports:** 0 occurrences of "job 404s after previously returning 200"
  (today's guaranteed failure mode, 01 §4.3); 100% of committed imports listable ≥90 days.
- **G10 dead:** 0 client-chosen pipeline decisions; 0 `bulk_import_disabled` 403s served to the
  wizard (the toggle no longer exists to trigger them).
- **Perceived breakage collapses:** "import broken/stuck" support tickets ↓ (baseline: current
  rate); the give-up copy ("taking longer than expected") retired from the codebase.
- **Accounting integrity:** counter-reconciliation violations = 0 in prod (alertable).
- **Cancel works:** p95 cancel-to-stopped < 2 chunk durations; 0 rollback incidents (semantics
  hold).
- **Strategy adoption:** >0 and growing use of `update_only`/`preserve_populated`;
  `keep_both`-era duplicate creation rate → 0.
- **Artifact utility:** repair-CSV download → successful re-import conversion measurable;
  retry-child success rate > direct-reimport baseline.
- **No isolation regressions:** T2 + the staging isolation test green forever; 0 cross-workspace
  reads/writes in prod alerts.
