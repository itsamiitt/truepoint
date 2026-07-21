# 12 — Performance & Scalability

> **Status of this doc:** complete (design doc — target state 🔲 not built; nothing ships from
> this series). Evidence cites [`01-Current-State-Audit.md`](01-Current-State-Audit.md); gaps cite
> [`02-Root-Cause-and-Gap-Analysis.md`](02-Root-Cause-and-Gap-Analysis.md); every external-platform
> claim cites the register in [`03-Enterprise-Research.md`](03-Enterprise-Research.md).
> **Owns:** **G09** (COPY-FROM-STDIN spike — P0 ❌gate: this doc defines what "cleared" means and
> the fallback if it fails), **G12** (no published import limits — P2), **G25** (partitioning
> intent unbuilt — P2), and the **disposition of G24 ◇** (no production search adapter —
> adjacent scope). It also quantifies what docs `05`/`06`/`08`/`09` designed: the child-table
> write amplification, the fast-path threshold, the progress-counter contention bound, and the
> index budget at 10x.
> **Does not own:** the state machine or verbs (08), queue mechanics/fairness (09), the
> visibility predicate (10), artifact PII posture (13), gate phase placement (14), migration
> sequencing (15). Numbers here that those docs forward-referenced ("doc 12 publishes…") are
> published here and nowhere else.
> **Step IDs:** `S-P1`…`S-P5` (sequenced in doc `15`; never fixed migration numbers).

---

## Objective

Give the unified import platform (08/09) and the child-table data model (05/06) a **numeric
contract**: a target load envelope, a per-stage throughput budget for the 2M-row reference file,
the COPY-staging math extended with the new child-table writes, precise pass/fail criteria for
the one unproven load-bearing primitive (the COPY spike, G09) *and* its fallback, the published
product limits users and the API actually see (G12), the index/storage budget at 10x, the
partition-compatibility rules every DDL step in doc 15 must obey (G25), and the
keyset-pagination index for every new list endpoint. Every number below is either **measured
from shipped code**, **anchored to the 03 register**, or **explicitly marked an assumption** to
be replaced by S-P1/S-P4 measurements — never silently invented.

---

## Reconciliation (what this design extends and must never contradict)

Pinned before any design claim, per the series convention.

**The throughput source of record:
[`../data-management/15-bulk-import-design.md`](../data-management/15-bulk-import-design.md) §1–§2.**
Its math is restated and *extended* here, never contradicted: COPY fast-loads an UNLOGGED,
non-RLS per-job staging table only (the ONE sanctioned RLS bypass, 07 §5); the live `contacts`
write stays Node-side, and the chunk merge "collapses today's *1 tx + 3 SELECTs per row* into
*1 tx + a handful of batched statements per ~10k chunk*" (15 §1). Staging carries the
already-prepared row (ciphertext + blind index) so PII is encrypted even in staging. The COPY
spike is an **enable-gate, not a build-gate** (15 §6 phase 4): the pipeline was built ahead of
it as dead code, and the spike must clear before `BULK_IMPORT_ENABLED` flips.

**The spike's CI vehicle already exists:**
[`../data-management/14-implementation-log.md`](../data-management/14-implementation-log.md) §6.4 —
"**`bulkImport.pipeline.itest.ts`** — **this IS the COPY-FROM-STDIN spike, executed in CI**: a
byte-for-byte `copyRows`→`readChunkBand` round-trip (bytea/NULL/jsonb/special-char), the full
drive→chunk→finalize, and the bulk-vs-sync merge parity." §3 below extends that itest with the
three *quantitative* assertions (throughput floor, memory ceiling, cancellation) the functional
round-trip does not yet make. The UNVERIFIED banner this clears is
`packages/db/src/repositories/importStagingRepository.ts:10–17` (01 §3.2).

**Shipped code facts this doc quantifies against (re-verified at head):**

- `imports` worker concurrency **1** with a written rationale ("whole-CSV payloads in memory;
  the scalable path is the chunked bulk-imports pipeline" — `apps/workers/src/tuning.ts:31,39`);
  bulk drive/chunk raise is gated behind the `tuning.ts` tripwire test (`tuning.ts:6–10`;
  09 Reconciliation #4). Processor deadline for imports: 15 min (`tuning.ts:62`).
- Backpressure sheds: 10 000 waiting on the legacy queue (`queue.ts:41`), 1 000 waiting drives
  on `bulk-imports` (`bulkQueue.ts:45`), fail-open typed 503 with `retryAfterSeconds: 60`
  (`apps/api/src/features/import/queueBackpressure.ts:12,34,38–45`).
- `BULK_IMPORT_THRESHOLD_ROWS` default **5 000** (`packages/config/src/env.ts:235–237`) — dead
  config today (01 §4.1 correction 4); 08 §1 resurrects it as the server-side routing knob;
  §2.4 below justifies the number.
- The trio's indexes today: `idx_import_jobs_ws_status` + the idempotency partial unique
  (`schema/importJobs.ts:78–82`); `import_job_rows` carries exactly PK + `idx_import_job_rows_job`
  + `idx_import_job_rows_ws_outcome` and **no uniques** (`importJobs.ts:150–158`); partitioning
  is a documented intent, not built (`importJobs.ts:6–9,125–128`; `contacts.ts:240–242`; 01 §6.12, L19).
- `contacts` carries ~11 indexes incl. PK (`contacts.ts:175–237`) — the write-amplification
  baseline §2.3 counts against.

**Sibling designs consumed as contracts:** 05 §pre-build (10x ≈ **30–50M rows per child
table**; 6-index budget per table; per-contact caps 25/25), 05 §6 (channel rows ride the same
staging table as one COPY-safe jsonb column; child inserts batched in the chunk tx), 06
(small-N account children; caps 50 domains / 200 locations), 07 §4 (the consolidated NEW-index
inventory; §4.3 flags the missing `import_jobs` keyset index — it ships in 08 S-I1), 08 §1
(fast/copy routing, XLSX admitted only under fast thresholds), 09 §2.2/§4.2 (chunk window
K = 2 default; ≤ 20 counter-delta UPDATEs per 10k chunk; ≤ K writers on the job row), 10 S-V1
(member-path keyset indexes).

**The locked scale contract:**
[`../data-management/06-storage-and-scale.md`](../data-management/06-storage-and-scale.md) —
"the scale contract is locked" (its §1 reuse map: ADR-0024 targets of 100M+ overlay rows,
SLO/latency budgets, RDS Proxy transaction pooling with the GUC-per-tx discipline H9,
fail-fast-503-never-hang pool behavior F3). This doc *applies* that contract to the import
envelope; it re-derives none of it. The keyset-only pagination mandate and the
no-unbounded-list rule are `truepoint-platform` skill law (SKILL.md §Scale Discipline).

**Contradiction scan.** No conflict with DM1–DM9, ADR-0028, data-management/15, or the shipped
capability model found. Two refinements are flagged where they appear: (a) §7 records that the
05/06 decision to give channel/domain child rows a **real FK** to `source_imports` makes
`source_imports` effectively non-partitionable while those FKs stand — resolved by
deprioritizing that table's partitioning in favor of retention reaping (not a contradiction;
07 §7's FK principle wins and the schedule adjusts); (b) §5 publishes a launch rows-per-file
ceiling *below* the 2M engineering envelope, raised after the soak passes — conservative
sequencing of a number no prior doc fixed.

---

## Current Challenges (headline only — the as-is is doc 01)

- The one load-bearing primitive of the copy path has never executed: zero `COPY`/`.writable()`
  usage repo-wide; the staging repository carries an UNVERIFIED banner (01 §3.2, G09).
- No import limit is published anywhere: the 10k/1k sheds are internal 503s, invisible until
  hit (01 §2.1 hop 5, G12); the only "limit" a user ever met was the dead-end toggle's 403.
- `import_job_rows` grows one row per input line with no partitioning and no reap — a 2M-row
  import writes 2M ledger rows into a plain table whose partitioning is a comment
  (`importJobs.ts:6–9`, G25).
- The child tables (05/06) add ~2.7 new heap rows and ~16 index entries per landed import row
  (§2.3) — cost nobody has yet budgeted against the chunk-merge envelope.
- Search: the `SearchPort` has only the in-memory dev adapter (01 §6.11, G24 ◇); doc 05's
  any-value facets need a stated disposition, not silence.

## Enterprise Best Practices (cited via 03's register only)

- **Limits are published in three layers** — per-file (rows AND bytes, whichever first),
  per-day rolling quota, concurrency — and enforced with early rejection: HubSpot 512 MB /
  1 048 576 rows per file, 3 concurrent (excess → visible `DEFERRED`), daily quota;
  Salesforce 150 MB per file, 25 concurrent, daily quotas in the tens of millions of rows
  (03 §1.1 [3], §6.1 [18][63][64]).
- **10 000-row internal chunking with bounded per-chunk retry then a job-level verdict** is the
  Salesforce envelope the shipped pipeline already mirrors (03 §6.1 [63][77]) — and the
  anchor for the spike's chunk-cost targets.
- **CSV streams row-by-row; XLSX cannot be stream-read** (zip central directory at EOF;
  SheetJS buffers whole files — streaming exists only for write) (03 §6.1 [143][144][145]).
- **Progress = durable counters polled indefinitely**; push transports are garnish
  (03 §6.1 [56][129][130]).
- **`addBulk` degrades above ~1k jobs/call; no first-class cancel of an active job**
  (03 §6.1 [139][140][141]) — already absorbed by 09's rolling window and cooperative cancel;
  restated because both are load-behavior facts.

## Gaps (register pointers — evidence in 01, linkage in 02)

| Gap | Sev | This doc's answer |
|---|---|---|
| **G09** | P0 ❌gate | §3: precise spike definition + quantitative pass criteria + the CI deliverable (S-P1) + the batched-INSERT fallback and what limits shrink to |
| **G12** | P2 | §5: the published limits table, each number anchored (03 §1.1/§6.1) or derived from the envelope; surfacing in API problem details (08 §2.3 slugs) and UX (doc 11) |
| **G25** | P2 | §7: planned-not-shipped confirmed; this program does not block on it; the partition-compatibility rules R1–R5 doc 15's DDL must obey |
| **G24 ◇** | P2 ◇ | §9: disposition — dev adapter stays the only engine this series requires; production engine remains the deferred ADR-0021/0035 track; the contract this series imposes on it |
| G16 ⚑ | P1 | §9 restates the guard as a projection requirement (05 owns the design) |
| G03/G05/G06/G11 | — | consumed: the envelope assumes 08's durable model and 09's window/counter mechanics |

---

## Recommended Solution

### §1 The load model — target envelope and per-stage budget 🔲

#### §1.1 Envelope parameters (assumptions written down)

| Parameter | Value | Basis |
|---|---|---|
| **Reference file** | 2 000 000 rows CSV ≈ 300 MB | assumption **A1**: mean source row 100–200 B (contact CSVs with 10–20 columns); the soak (S-P4) fixes the real distribution |
| Chunk size | ~10 000 rows → 2M = **200 chunks** | 15 §2 (a target, not locked — 15 §7's own caveat; S-P4 may retune); market precedent 03 §6.1 [63] |
| Chunk window | K = 2 in-flight chunks per job | 09 §2.2 (locked default) |
| Chunk concurrency | C = 1 at launch (dark-era tuning); C = 4 target after the gated raise | `tuning.ts:31,39` + 09 Reconciliation #4 |
| Per-workspace running-job cap | N = 3 (→ `deferred`) | §5 publishes it; HubSpot parity (03 §6.1 [18]) |
| Concurrent importing tenants (steady / burst) | 10 / 50 active jobs platform-wide | assumption **A2**: sized from the drive shed (1 000, `bulkQueue.ts:45`) staying ≥ 20× above steady intake |
| Steady-state volume at 10x | 10–20M contacts; **30–50M rows per channel table**; 100M+ overlay rows as the long-run ADR-0024 target | 05 §pre-build (locked); data-management/06 §1 |
| Channel density | ~1.2 emails / ~1.5 phones per contact | 05 §pre-build assumption, inherited |
| `import_job_rows` growth | +1 row per input line; 2M import ⇒ 2M ledger rows | schema fact (`importJobs.ts:129–148`) |

#### §1.2 Per-stage throughput budget — the 2M-row reference file

Budgets are p95 targets per stage; floors marked **(spike)** are S-P1 pass criteria, floors
marked **(assumed)** are engineering estimates the S-P4 soak re-baselines. Total wall target:
**§Success Metrics**.

| # | Stage | Mechanism | Throughput floor | p95 budget (2M rows) |
|---|---|---|---|---|
| 1 | Upload stream → FileStore | `putObject(file.stream())`, constant memory (01 §2.2 hop 5) | ≥ 30 MB/s effective (assumed; network-bound) | ≤ 2 min |
| 2 | AV scan | G08 seam; engine choice is doc 13's | (13's) | ≤ 2 min, pipelined where the engine streams |
| 3 | Drive: stream-parse + `validateRow` + `prepareContact` | PapaParse-class row streaming (03 §6.1 [143]); AES-GCM + HMAC per PII field make this **crypto-bound, not parse-bound** | ≥ 6 000 rows/s single drive worker (assumed) | ≤ 6 min |
| 4 | COPY into UNLOGGED staging | `copyRows` — the G09 primitive | **≥ 20 000 rows/s (spike floor, §3)** | ≤ 2 min |
| 5 | Within-file dedup | one set-based `DISTINCT ON` pass in staging (15 §2) | set-based | ≤ 1 min |
| 6 | Chunk merge × 200 (incl. NEW child writes) | batched merge per §2 | ≤ 18 s p95 per 10k chunk (assumed; §2.3) | ≤ 60 min at C=1 · ≤ 18 min at C=4 |
| 7 | Finalize: rollup intents, artifacts, DROP staging | atomic completer (09 §3) | — | ≤ 2 min |

Stages 3–4 pipeline (the drive COPYs while it parses), so the stage budget is max-of, not
sum-of, for that pair. The dominant term is unambiguously **stage 6** — which is why §2 spends
its effort there and why the chunk-concurrency raise is the single highest-leverage tuning
action after launch.

**Fast mode** (≤ threshold): no stages 4–5; one chunk; the whole file budget is
**≤ 60 s p95 at 5 000 rows** (§2.4) inside the 2-min fast-drive deadline (09 §3).

### §2 COPY-staging math, extended with the child tables 🔲

#### §2.1 The 15 §1 math, restated

Today's sync path: **1 transaction + 3 dedup SELECT probes per row**, plus its writes
(`runImport` per-row `withTenantTx`, 01 §2.1 hop 8). At 2M rows that is ~2M transactions and
~6M probes — never viable, which is why the sync path is capped by payload size today.

The copy path (15 §2): per ~10k chunk, **one `withTenantTx`** running batched statements over
merge sub-batches of ~500–1 000 rows. Per sub-batch, the shipped statement set is ~10 batched
statements: ≤ 3 dedup IN-list SELECTs (`findByDedupKeysBatch`), 1 provenance batch fetch, 1
master resolve batch (its own `withErTx`, outside the tenant tx), 1 account upsert batch,
1 insert + 1 update batch on `contacts`, 1 `source_imports` append, 1 `list_members` batch,
1 ledger insert, 1 counter delta. ⇒ **~100–200 statements per 10k chunk; ~20 000–40 000
statements for the whole 2M-row job** — three orders of magnitude fewer round-trips than
per-row, which is the entire point of the staging design.

#### §2.2 What 05/06 add per chunk

The child tables ride the **same chunk tx** (05 §6: channel payloads staged as one COPY-safe
jsonb column of pre-encrypted bytes; child rows inserted batched). Per merge sub-batch the
additions are:

| Addition | Statements per sub-batch | Rows per 10k chunk (A1 densities) |
|---|---|---|
| `contact_emails` batch-check + `ON CONFLICT DO NOTHING` insert | +2 | ~12 000 |
| `contact_phones` batch-check + insert (raw + E.164 keys) | +2 | ~15 000 |
| `account_domains` upsert (multi-domain columns; small-N) | +1–2 | ~500–1 000 (bounded by new/changed accounts) |
| duplicate-signal marker writes (05 §2.2 collision policy) | +1 amortized | ~0–100 |

Statement count grows **+40–50%** (from ~10 to ~14–16 per sub-batch) — fully absorbed by
batching; round-trips stay O(chunks × sub-batches), never O(rows). The irreducible cost is
**row and index write amplification**, counted next.

#### §2.3 Write amplification per landed import row (target state)

| Table | Heap rows / input row | Secondary-index entries / row written | Entries / input row |
|---|---|---|---|
| `contacts` (insert or update) | 1 | ~10 (`contacts.ts:175–237`) | ~10 |
| `contact_emails` | ~1.2 | 6 (05 §2.3 budget) | ~7.2 |
| `contact_phones` | ~1.5 | 6 | ~9 |
| `account_domains` (+ rare locations) | ~0.1 | 3 | ~0.3 |
| `source_imports` | 1 | ~4 (incl. 10 S-V1's member index) | ~4 |
| `import_job_rows` | 1 | 2 (`importJobs.ts:150–153`) | ~2 |
| **Total** | **~5.8** (was ~3 pre-05/06) | | **~33** (was ~17) |

So the child tables roughly **double heap-row writes and index maintenance per input row**.
Consequence for the stage-6 budget: the pre-child chunk estimate (~8–12 s per 10k band,
assumed) grows to **~12–18 s p95** — the §1.2 number. This is the honest price of G15/G17 and
it is paid in the only place that scales (batched, set-shaped, WAL-efficient writes inside one
tx), not in round-trips. `uuid_generate_v7` PKs keep all six new-table inserts append-ordered
(05 §pre-build), so index churn is right-leaf-page churn, not random-page churn.

**Budget rule (normative for 15's steps):** the child tables ship with **exactly** the 05
§2.2–2.3 / 06 §1 index sets (6 per channel table; 3 on `account_domains`). Any index beyond
those inventories requires a measured read regression first — an index added "just in case"
costs ~1 write per import row forever (this section's table is the ledger of that cost).

#### §2.4 Break-even and the fast-path threshold (08 §1 consumes this)

- **Fast-path cost:** per-row tx at ~5–10 ms/row (assumed; 3 probes + writes on pooled
  connections) ⇒ 5 000 rows ≈ **25–50 s** — inside the 2-min fast-drive deadline (09 §3) with
  ≥ 2× headroom. At 10 000 rows the p95 brushes the deadline; beyond it the fast path is wrong.
- **Copy-path fixed overhead:** staging DDL create/drop + COPY setup + drive→chunk queue hops +
  finalize ≈ **10–20 s regardless of size** (assumed; S-P1 measures the COPY share). Below
  ~2–3k rows, copy mode is *slower* than fast mode.
- **Phase-A transport bound:** rows travel in the BullMQ payload until G07 (08 §1.2); 5 000
  prepared rows ≈ 3–6 MB payload — comfortably inside Redis sanity, and the reason the
  threshold must not be raised while Phase A transport stands (08 pre-build assumption 2).

The crossover band is ~2k–10k rows; **`BULK_IMPORT_THRESHOLD_ROWS = 5 000` sits inside it and
stands** — resurrected exactly as shipped (`env.ts:235–237`), now consumed (08 S-I5). A
companion **fast-path byte ceiling of 10 MB** is published (§5) because rows alone don't bound
payload width. Both are env-tunable; S-P1/S-P4 measurements may move them without design
change. Verdict: **justify, keep, re-measure** — no adjustment proposed ahead of data.

### §3 The COPY spike (G09) — definition, criteria, fallback ❌→🔲

#### §3.1 What the spike is

Prove, on real Postgres under Bun, the primitive the entire copy path stands on
(`importStagingRepository.ts:10–17` banner; 08 §8 gate table): `postgres.js`
`unsafe(<COPY … FROM STDIN>).writable()` driven by a **backpressure-aware Writable** — the
producer honors `write()` returning false and waits for `'drain'`, so memory stays constant
regardless of file size — over the **owner connection** against the per-job UNLOGGED non-RLS
staging table (the one sanctioned bypass, 07 §5).

#### §3.2 Pass criteria (all must hold; each is a CI assertion)

| # | Criterion | Pass bar |
|---|---|---|
| 1 | **Functional round-trip** (already specified) | the three banner assertions: backpressure-aware Writable; CSV encoding round-trips byte-for-byte (bytea as unquoted `\x` hex, unquoted empty = NULL, quoted text/json); bytea reads back as Buffer (01 §3.2; 14 §6.4's existing assertions) |
| 2 | **Throughput floor** | ≥ **20 000 prepared rows/s sustained** (~500 B/row ⇒ ~10 MB/s) on the CI Postgres class, measured over ≥ 100k rows — sized so stage 4 of §1.2 holds with 2× headroom; anchored to the 10k-row internal-batch precedent (03 §6.1 [63][77]) |
| 3 | **Memory ceiling** | producer RSS delta ≤ **128 MB** while staging ≥ 1M rows (constant-memory property: the delta must not correlate with row count — assert plateau, not just peak) |
| 4 | **Cancellation mid-stream** | destroying the Writable mid-COPY aborts the server-side COPY, returns/closes the connection without leaking it (pool count restored), leaves the staging table droppable, and a subsequent re-drive resumes from the byte watermark without re-staging staged rows twice (15 §2 idempotency) |

**Deliverable = S-P1:** extend `bulkImport.pipeline.itest.ts` — which data-management/14 §6.4
already designates as "the COPY-FROM-STDIN spike, executed in CI" — with assertions 2–4
(throughput measured against a CI-calibrated floor constant; memory via `process.memoryUsage()`
sampling; cancellation via mid-stream destroy + pool introspection). The result is recorded in
an ADR addendum per 08 §8 (db-mgmt-research/05 AC1). The spike is **the** G09 gate artifact:
green ⇒ the gate clears; doc 16 flips the L6 row.

#### §3.3 The fallback if the spike fails

If `postgres.js` COPY streaming cannot meet criteria 1–4, the loader — one function behind the
`importStagingRepository` seam — swaps to **batched multi-row INSERT** into the same staging
table (1 000-row `VALUES` batches, same prepared-ciphertext rows, same within-file dedup SQL).
Everything downstream (chunk bands, merge, finalize, accounting) is untouched.

- **Measured-ceiling assumption:** 5 000–10 000 rows/s (multi-row INSERT on UNLOGGED, assumed;
  the same itest measures it as the fallback's own floor). Stage 4 for 2M rows grows from
  ≤ 2 min to **~3.5–7 min** — the total envelope survives, stage 6 still dominates.
- **What shrinks:** the published rows-per-file ceiling holds at the **launch** value
  (1M, §5) and the 2M raise is deferred until either COPY is proven on a later driver/runtime
  or the fallback demonstrates the 2M soak inside budget. Memory criterion 3 and cancellation
  criterion 4 apply to the fallback identically (batch loop = trivially constant-memory and
  abortable between batches).
- **What does not change:** no architecture, no schema, no API, no state machine — the
  fallback is deliberately boring. This is why G09 is an enable-gate and not a design risk.

### §4 Streaming parse & upload 🔲

- **CSV — streams, settled.** `streamParse` (constant-memory, quoting-parity with `parseFile`)
  shipped with the pipeline (15 §3/§6 phase 3); row-streaming is the documented library
  behavior (03 §6.1 [143]). The drive parses and COPYs in one pipelined pass (§1.2).
- **XLSX — cannot stream, decided: cap it, don't convert.** SheetJS cannot stream-read (zip
  central directory at EOF; whole-file buffering; 03 §6.1 [144][145]). 08 §1 already rules
  XLSX **fast-path-only** with an honest `xlsx_too_large` refusal above threshold. This doc
  fixes the numbers: **XLSX ≤ 5 000 rows AND ≤ 10 MB** (the fast-path pair, §5) — a 10 MB
  zipped workbook can inflate ~10×, so the buffered worst case stays ~100 MB heap inside the
  fast worker, compatible with §3's 128 MB-class discipline. Server-side XLSX→CSV conversion
  was considered and **rejected for this program**: it buys a higher XLSX ceiling at the cost
  of a new conversion stage that itself buffers (same library limit), a second temp artifact
  under the G07/G08 envelope, and fidelity edge cases (dates/locales) — for a format the
  market itself caps or converts client-side. Recorded as a doc 14 future candidate if XLSX
  demand at scale materializes.
- **Upload → FileStore streams today** (`putObject(file.stream())`, 01 §2.2 hop 5) and moves
  to presigned multipart at G07 (08 §8) — the API request thread never buffers the file
  either way. The byte ceilings in §5 are enforced **pre-buffer** at the edge (08 pre-build,
  13's upload envelope).

### §5 Published product limits (G12) 🔲

The three-layer shape is the market contract (per-file rows AND bytes → early 413; daily
quota → 429; concurrency → visible `deferred`, 03 §1.1 [3], §6.1 [18][63][64]). Numbers are
launch values with their basis; all live as config constants (S-P2), published in docs and in
every rejecting problem response.

| Limit | Launch value | After 2M soak green (S-P4) | Basis / anchor |
|---|---|---|---|
| Max rows per file (CSV) | **1 000 000** | 2 000 000 | HubSpot 1 048 576 [3][18]; our §1 envelope; conservative until the soak proves stage 6 |
| Max file size (CSV) | **250 MB** | 500 MB | between Salesforce 150 MB [63] and HubSpot 512 MB [3]; A1 row-width × row ceiling |
| Max file size / rows (XLSX) | **10 MB / 5 000 rows** | unchanged | §4 — SheetJS no-stream [144]; fast-path-only per 08 §1 |
| Fast-path routing pair | ≤ 5 000 rows and ≤ 10 MB | re-measured | §2.4 break-even; `env.ts:237` |
| Concurrent running imports per workspace | **3** (then `deferred`) | re-measured | HubSpot 3 → DEFERRED [18]; keeps worst-case per-workspace chunk fan-out at K×N = 6 (09 §2.2) |
| Commits per workspace per hour | **20** | unchanged | 08 §2.3 (already spec'd there; restated as the published number) |
| Rows per workspace per day | **5 000 000** | re-measured | scaled from the HubSpot/Salesforce daily-quota band [3][63][64] to our tier; 2.5× the largest single file |
| Mapping templates per workspace | **50** | unchanged | ops hygiene; templates are a leapfrog surface (03 §1.1 [21]), not a storage risk |
| Channel / domain / location caps | 25 emails · 25 phones per contact; 50 domains · 200 locations per account | unchanged | 05 §pre-build, 06 §Misuse (owned there; listed for one-page completeness) |
| **Until G07+G09 clear** | rows per file = the fast pair (5 000 / 10 MB) | — | 08 §1's honest `file_too_large` refusal replaces the dead-end toggle |

**Where limits surface.** API: RFC 9457 problems with 08 §2.3's stable slugs
(`file_too_large` / `xlsx_too_large` 413, `import_quota_exceeded` 429 with the quota and reset
window as extension members, `queue_backpressure` 503 only as the never-in-normal-operation
fuse — 09 §1.3's rule that a user must meet the product limit before the raw shed). UX: doc 11
renders the ceilings **on the upload step before selection** (not as a rejection surprise), the
`deferred` state with the "N running" copy (09 §9), and quota-remaining on the imports page.
Plan-tier variation of these numbers is a billing/settings concern, explicitly out of scope
(data-management/15 §7's open question stands; doc 14 tracks it).

### §6 Index & storage strategy at 10x 🔲

#### §6.1 The new-index bill, sized (07 §4's inventory priced at §1.1's 10x)

| Index family (owner) | Table @ 10x rows | Sizing (order-of-magnitude) | Verdict |
|---|---|---|---|
| Channel uniques + fetch + facet, 6/table (05 S-CH1) | `contact_emails` ~30–40M · `contact_phones` ~40–50M | 32 B blind-index keys ⇒ ~1.5–3 GB per B-tree; ~10–18 GB total index + ~15–25 GB heap per table (05 §pre-build) | in budget; the §2.3 write-amplification table is the ongoing cost; **no additions without a measured read** |
| `account_domains` set (06 S-A1) | small-N (≤ 10/account) | negligible | in budget |
| `import_jobs` keyset `(workspace_id, created_at DESC, id DESC)` (08 S-I1; flagged by 07 §4.3) | one row per job — even 10k jobs/day ⇒ ~3.6M rows/yr | trivial | **ship with the list route, unconditionally** — the flagged gap closes in 08's step set |
| Member-path keyset composites on `import_jobs`/`reveal_jobs`/`enrichment_jobs` (10 S-V1) | job tables — small | trivial | in budget |
| 10 S-V1's `source_imports (workspace_id, imported_by_user_id, imported_at DESC)` | `source_imports` is **one row per landed import row** — 100M+ at the ADR-0024 horizon | ~4–8 GB at 100M rows | accept — it backs the live Recent-Imports read (visibility-fixed); the one S-V1 index with a real bill, priced here so 15 sequences it knowingly |
| GIN `custom_fields` (existing) | touched by every import row carrying custom fields | GIN insert cost is the pending-list flush; bursty under import load | keep; §6.2's autovacuum posture is the mitigation; no new GIN ships from this series |

#### §6.2 Bloat, vacuum, and the hot job row

- **`import_job_rows` / `source_imports` are append-only** — insert-only tables don't bloat
  from updates, but autovacuum must still run for the visibility map (index-only scans) and to
  freeze; their default `autovacuum_vacuum_scale_factor` is wrong for 100M-row tables.
  **S-P5** sets per-table autovacuum storage parameters (lower scale factors / absolute
  thresholds) on the four high-churn tables (`import_job_rows`, `source_imports`,
  `contact_emails`, `contact_phones`).
- **`import_jobs` is the hot row** during a run: ≤ K writers × ≤ 20 counter deltas per 10k
  chunk (09 §4.2). The counters are **non-indexed columns** (`importJobs.ts:57–66` — only
  `status` is indexed), so deltas qualify for **HOT updates** provided page headroom exists:
  **S-P5 sets `fillfactor = 90` on `import_jobs`** so a 2M-row job's ~400 delta updates churn
  within-page instead of writing ~400 index-visible row versions. Rule for 15: **never index a
  counter column** — it would forfeit HOT and put ~200 index-entry writes per job on the
  hottest row in the system.
- **Retention over the ledger:** `import_job_rows` gets a retention class (engine per
  data-management/16, inert until enforced) with deletion **by `created_at` range** — see rule
  R5 (§7) for why the shape matters.

### §7 Partitioning stance (G25) 🔲

**Status confirmed: planned, not shipped, on `import_job_rows` and `source_imports`**
(`importJobs.ts:6–9,125–128`; `contacts.ts:240–242`; 01 §6.12, L19). **This program does not
block on partitioning** — at the §1 envelope a plain `import_job_rows` remains viable to the
order of 100–200M rows (assumption **A3**; alert at 100M, §8-adjacent metric), and the
retention reap bounds steady state. But every DDL step this series ships must be
**partition-compatible**, so the eventual conversion is a maintenance window, not a redesign.
The rules doc 15's steps must obey:

- **R1 — partition keys, fixed now:** `import_job_rows` → `RANGE (created_at)` monthly (the
  schema comment's own intent); `source_imports` → `RANGE (imported_at)` monthly *if ever*
  (see R2). Child channel tables need **no** partitioning plan — they are bounded by contact
  count × small density (05 §pre-build: "no partitioning — contrast import_job_rows"), and
  none of their uniques could carry a time key without breaking dedup semantics.
- **R2 — the FK finding (flagged in Reconciliation):** Postgres requires every unique
  constraint on a partitioned table to include the partition key, and an inbound FK must
  reference such a unique key. 05/06 give `contact_emails`/`contact_phones`/`account_domains`
  a **real FK** `source_import_id → source_imports(id)` (05 §1.1, 06 §1 — deliberately, per
  07 §7's no-new-bare-uuid principle). While those FKs stand, `source_imports` cannot be
  range-partitioned without demoting them. **Disposition: accept and re-order** —
  `source_imports` partitioning is *deprioritized* in favor of its retention class (730 d
  posture already anticipated by 05 §1.1's SET NULL rationale); `import_job_rows` — which by
  Class-B design has **no inbound FKs and only bare-uuid audit pointers**
  (`importJobs.ts:144–147`; 07 §3) — is the partition-first candidate. If `source_imports`
  partitioning is ever forced, the conversion step includes demoting those three FKs to
  documented bare-uuid pointers — recorded here so docs 14/15 never discover it mid-migration.
- **R3 — no new uniques on the two intent tables.** `import_job_rows` has no unique today
  (its PK is the only one to reconcile at conversion, becoming `(id, created_at)`); doc 08/10
  add none; **no future step may** add a unique to either table unless it includes the R1 key.
  New secondary indexes must be plain B-tree/GIN (partitioned-index-friendly) — 10 S-V1's
  `source_imports` composite complies.
- **R4 — RLS is partition-safe as-is:** policies on the partitioned parent apply to
  partitions; the fail-closed `NULLIF` GUC idiom needs no change (the denormalized
  `workspace_id` on `import_job_rows` was designed for exactly this — direct scoping with no
  parent join, 07 §3).
- **R5 — reap in the partition's shape:** the retention deleter for `import_job_rows` (and
  `source_imports`) deletes by **`created_at`/`imported_at` range**, so the post-conversion
  implementation swaps `DELETE` for `DROP PARTITION` with identical semantics.

### §8 Progress counters, polling, and the SSE offload 🔲

Quantifying 09's design (mechanics live there; numbers live here):

- **Contention bound, priced.** Writers on one job row = **≤ K (=2)** chunk runners + the
  cancel/finalize verb. Delta cadence: one single-row `UPDATE … SET x = x + $n` per merge
  sub-batch ⇒ ≤ 20 per 10k chunk (09 §4.2) ⇒ a 2M-row job emits ~4 000 deltas over its ~1 h
  run ≈ **~1 update/s** against the job row. Each delta is sub-millisecond; worst-case row-lock
  wait is (K−1) × one delta ≈ **~1–2 ms per collision** — noise against a 12–18 s chunk.
  With §6.2's fillfactor these are HOT updates: no index churn, bounded page bloat. The bound
  survives the C=4 raise unchanged because K, not C, caps same-job writers.
- **Why atomic deltas, never recounts** (the design 15 §2 shipped, defended numerically): a
  recount is `SELECT count(*) … GROUP BY outcome` over up to 2M ledger rows — O(n) per tick
  (seconds of I/O at scale), and racy against in-flight chunk transactions (it would read
  half-committed bands' absence, then be corrected later — progress bars that move backwards).
  Deltas are O(1), commit **with** the merge tx, and are exactly-once per chunk completion by
  construction (a failed attempt's tx contributed nothing — 09 §3). The ledger remains the
  audit-grade recount for the **terminal** reconciliation check only (09 §8's
  accounting-identity alert), where one O(n) pass per job is correct and cheap.
- **Poll endpoint at scale.** `GET /imports/:id` = one PK read (09 §4.3). Worst case
  (A2 burst): 50 active jobs × a few watchers × 0.5 Hz ≈ **≤ ~10² reads/s** — trivial; the
  real guard is against pathological pollers: the standard per-route rate limiter (08 §2.3)
  plus **`Cache-Control: private, max-age=2`** and an **ETag over
  `(status, counters, completed_chunks)`** so a tight poller gets 304s between real changes.
  Never a shared/CDN cache (tenant data; `private` is load-bearing).
- **SSE offload (09 §4.4), sized:** event volume is O(duration) not O(rows) — one throttled
  progress event ≥ 2 s per job ⇒ a 2M-row job emits ~1 800 events over an hour; 50 concurrent
  jobs ≈ **≤ 25 events/s platform-wide** through the shipped relay (batch 25/tick — inside one
  tick). SSE converts O(pollers) request load into O(events) push load; polling remains the
  safety net and the numbers above show it holds even with SSE dark.

### §9 Search projection — the G24 ◇ disposition 🔲

- **What 05 requires (restated, not re-designed):** the projection exposes
  `has_email`/`has_phone` = ∃ live child row, `email_count`/`phone_count`, and the any-value
  domain facet; type/status/line_type facets aggregate across values; **secondary values and
  secondary domains are never indexed as values** — counts, types, statuses only (05 §5, the
  G16 guard). The **facet list is otherwise unchanged**.
- **Projection cost per import row: O(1)** — the chunk merge already touches the contact; the
  projection update is one more per-touched-row event, and the primary-value flat cache
  (CH-INV-1) means the *masked list payload* needs no child-table join at read time. Inside
  Postgres-native overlay search (the shipped `withTenantTx` search path,
  data-management/06 §3), the any-value domain facet is index-backed by
  `idx_contact_emails_ws_domain` (05 §2.3) and count facets are maintained at write time,
  never computed by scan at query time.
- **The caveat, restated honestly:** the only `SearchPort` adapter in the repo is the
  in-memory dev/test one (`packages/search/src/index.ts:1–6`; 01 §6.11, L17). This series
  extends its **contract** (the fields above) so behavior is engine-independent — it does not
  ship an engine.
- **Production engine = adjacent scope, unchanged disposition (G24 ◇):** the deferred
  ADR-0021/0035 track — OpenSearch (global, masked) + Typesense (overlay) + ClickHouse facets,
  CDC/outbox-fed, permissions re-checked at read, index-never-an-authorization-grant
  (data-management/06 §3/§6 F2; PLAN_05). Trigger remains "a workspace crosses the Typesense
  envelope" (06 §7 open question, owner: truepoint-operations). **What this series requires of
  that engine when it lands:** the 05 §5 projection contract verbatim — facet list unchanged,
  counts include secondaries, presence from child-row existence, no secondary values in any
  index. Roadmap placement: doc 14 §future.

### §10 Keyset-pagination mandate, applied 🔲

House law: cursor/keyset only, no OFFSET anywhere, every list index-backed under the RLS
workspace predicate (truepoint-platform SKILL §Scale Discipline; data-management/06 §2's
lead-with-`workspace_id` rule). The complete new-list inventory:

| Endpoint | Cursor | Backing index | Owner (no DDL duplicated here) |
|---|---|---|---|
| `GET /imports` — elevated path (admins, all jobs) | `(created_at, id)` opaque | `(workspace_id, created_at DESC, id DESC)` | 08 S-I1 (07 §4.3's flag, closed) |
| `GET /imports` — member path (own jobs) | same | `(workspace_id, created_by_user_id, created_at DESC, id DESC)` | 10 S-V1 |
| `GET /reveal-jobs`, `GET /jobs` (enrichment) — member paths | same | S-V1 member composites; elevated path keeps each table's existing workspace keyset index | 10 S-V1 |
| Recent-Imports feed (`recentBatches`) | bounded top-N | existing `idx_source_imports_ws_imported_at`; member path = S-V1's `(workspace_id, imported_by_user_id, imported_at DESC)` | existing / 10 S-V1 |
| Per-row drill-down (`GET /imports/:id/rows`) — **if** a tenant route ships (08 keeps it artifact-first; the staff drill-down exists) | `(row_index)` within a job | **conditional S-P3:** `(job_id, row_index)` — today's `idx_import_job_rows_job` alone would sort | this doc (conditional) |
| Duplicate-review queue (doc 11, G21) | `(updated_at, id)` | existing partial `idx_contacts_duplicate_of` suffices at launch volumes; **conditional S-P3** partial composite `(workspace_id, updated_at DESC, id DESC) WHERE duplicate_of_contact_id IS NOT NULL` if the queue's p95 breaches — answering 07 §4.3's "volume-based composite deferred to doc 12" | this doc (conditional) |
| Child sets (channels/domains/locations/family) | not paginated — bounded small-N by design | n/a | 05/06 (07 §4.3 row 5) |

Cursors remain stable under doc 10's visibility predicate (10 §keyset stability: the member
path adds a leading equality column, so `(created_at, id)` cursors are unaffected).
**Verification hook:** TP-5 (§Testing) asserts index-backed plans (no Sort, no SeqScan) for
every row of this table.

---

## Implementation Steps (step IDs — doc 15 sequences; no fixed migration numbers)

| Step | What ships | DDL | Depends on |
|---|---|---|---|
| **S-P1** | The COPY spike as CI assertions: extend `bulkImport.pipeline.itest.ts` (14 §6.4) with §3.2's throughput floor, memory ceiling, and cancellation criteria; record the verdict in an ADR addendum. Green ⇒ **G09 cleared** (doc 16 L6). If red ⇒ the §3.3 fallback loader lands behind the same repository seam, with its own measured floor asserted | No | CI with real Postgres + Bun |
| **S-P2** | Limits wiring (G12): the §5 table as named config constants; enforcement at the 08 §2.3 seams (413/429/`deferred`); quota/reset extension members on the problems; the user-facing limits doc page. Consumed by 08 S-I5's pre-gates | No | 08 S-I1/S-I5 |
| **S-P3** | **Conditional** indexes, each shipped only on a measured breach: `(job_id, row_index)` on `import_job_rows` (if the tenant row drill-down route ships); the duplicate-review partial composite (§10). Nothing else — all other new indexes ride 05/06/08/10 steps | Yes (conditional) | the owning route + a p95 measurement |
| **S-P4** | Perf harness: nightly (not per-PR) **2M-row soak** asserting the §1.2 stage budgets + §Success wall-time; the **concurrent-tenant fairness scenario** (reuses 09 T-Q4's seed, adds the envelope assertions); the poll/ETag load probe. Publishes the measured numbers that re-baseline §2.4/§5 | No | S-P1; 08 S-I3; 09 S-Q1/S-Q2 |
| **S-P5** | Storage posture: `fillfactor = 90` on `import_jobs`; per-table autovacuum parameters on `import_job_rows`, `source_imports`, `contact_emails`, `contact_phones`; the never-index-a-counter rule recorded in the schema comments | Yes (storage params only; reversible `ALTER … RESET`) | — |

## UI/UX (pointer — doc 11 owns every surface)

Doc 11 consumes exactly three things from here: the §5 limits rendered *before* upload (never
as a surprise rejection), quota-remaining + the `deferred` copy on the imports page (09 §9's
state table), and the client poll cadence riding §8's cache headers (interpolate progress
client-side; never poll faster than `max-age`). Nothing renders here.

## DB & Backend — pre-build reasoning pass (delta answers; 08/09 cover the shared surface)

- **Source of truth.** For every number in this doc: the config constant (S-P2) is the runtime
  truth; this doc is the design record; S-P1/S-P4 measurements supersede the assumptions
  (A1–A3) and the doc is amended, not silently diverged from. Counters: the job row (09 §4.1).
- **Failure modes.** Covered by 09 §7's table; this doc adds the *capacity* failure: sustained
  intake above the envelope. Order of defense: per-workspace caps (`deferred`) → daily quota
  (429) → the fail-open sheds (503, `queueBackpressure.ts:34` — never sheds on an unreadable
  depth) → RDS Proxy fail-fast (data-management/06 §6 F3). Each layer is visible before the
  next engages (09 §1.3's rule).
- **Duplicate prevention / audit.** Owned by 08/09; nothing here adds a write path.
- **Security.** No new access path, no new bypass (07 §5 stands). The spike runs against the
  owner connection **in CI only**; the ETag hashes non-PII counters; cache headers are
  `private`; limits never leak other tenants' usage (quota problems report the caller's
  workspace numbers only).
- **Scalability — the explicit worst case (whale + hot dashboard + verification sweep
  simultaneously).** A 2M-row copy import runs (≤ K = 2 chunk txs + short `withErTx` mints),
  the same tenant's dashboard is hot (PK/keyset reads), and the reverification sweep runs
  (leader-locked, concurrency 2 — `tuning.ts:47`). **What degrades first, in order:**
  (1) *fast-lane wait* — bounded by design at ≤ one in-flight chunk per busy slot
  (09 §2.3), so it degrades but is capped; (2) *OLTP read p95* — the real first casualty:
  chunk-merge write bursts churn shared buffers and WAL (staging is UNLOGGED and exempt, but
  the merge writes ~33 index entries/row, §2.3); detector = DB read-latency SLO + the
  fast-lane `queue.oldest_waiting_age` band metric (09 §8); (3) *pool pressure* — bounded by
  RDS Proxy queue-then-503, never a hang (F3). **Knobs, in order of use:** merge sub-batch
  size down; K down to 1; chunk concurrency stays at 1 (raise only widens this worst case —
  which is why the raise is CI-gated); per-workspace cap N down. The whale cannot take the
  platform down: its fan-out is structurally capped at K×N chunks (09 §2.2) and its queue
  footprint at K slots.
- **Monitoring.** Rides 09 §8 wholesale; this doc adds three gauges: `import_job_rows` total
  (alert at A3's 100M — the partitioning trigger), chunk-duration p95 vs the §1.2 budget
  (regression tripwire), and 503-shed count (must stay ~0; firing = §5 caps are mis-sized).
- **Rollback.** S-P1/S-P4 are tests; S-P2 constants revert by config; S-P3 indexes drop
  cleanly; S-P5 storage params `RESET`. Nothing here is load-bearing at flag-off.
- **Assumptions (A1–A3), written down** in §1.1/§7 and each paired with the measurement that
  replaces it. The one load-bearing external assumption: CI's Postgres class is representative
  enough that a 2× headroom on the spike floor survives production variance — if prod-class
  hardware differs materially, S-P4 re-runs there before the §5 raise.
- **Worst case.** *The spike passes in CI but COPY misbehaves in production* (driver edge under
  RDS Proxy: COPY runs on the **owner connection path, not the pooled app path** — 15 §4's
  dedicated copy connection — so proxy transaction-pooling quirks don't apply, but the
  connection-count budget does): detectable via stage-4 duration + stall detector; recoverable
  by flipping to the §3.3 fallback loader (config-selectable, same seam) without schema or
  flag surgery. Detectable, recoverable — no approval gate needed beyond the existing
  enable-gates.

## API (summary)

No new endpoints. Contract deltas riding existing surfaces: the §5 quota extension members on
413/429 problems (S-P2), `Cache-Control: private, max-age=2` + ETag/304 on `GET /imports/:id`
(§8), and the guarantee that every list in §10 is opaque-keyset only. All `/api/v1`, RFC 9457,
shared Zod (08 §API).

## Edge Cases

A file exactly at a ceiling (≤ passes, > rejects — boundary tested) · rows-vs-bytes disagree
(whichever trips first, the HubSpot rule [18]) · a workspace at its daily quota mid-multi-file
batch (commit 429s with the reset time; queued jobs unaffected) · K > total_chunks (clamped,
09 §Edge) · ETag collision across status flaps (hash includes status + counters — a flap
changes it) · autovacuum lagging a 2M burst (S-P5 thresholds sized for burst; the freeze
horizon is years away at these volumes) · spike floor met but memory plateau failed
(criterion 3 fails independently ⇒ gate stays shut — both must hold) · fallback loader hitting
the 15-min drive deadline on 2M rows (§3.3 math says ~7 min worst; deadline headroom 2×; if
breached, the deadline row in `tuning.ts` is raised for copy drives — a tuning change, not a
design change).

## Testing (hooks — CI-run; this sandbox cannot execute gates; aligned with 09's T-Q set, never duplicated)

- **TP-1 = S-P1**: the spike assertions (§3.2) inside `bulkImport.pipeline.itest.ts`.
- **TP-2 (nightly)**: the 2M soak — stage budgets (§1.2), wall-time target, accounting
  identity at the end (reuses 08 T4's assertion), `import_job_rows` count = rows_total.
- **TP-3**: fairness envelope — extends 09 T-Q4's seed with the numeric assertions: fast p95
  wait ≤ one chunk duration; whale in-flight ≤ K; two whales interleave.
- **TP-4**: poll behavior — ETag 304s between counter changes; `max-age` honored; rate limiter
  engages before measurable DB load.
- **TP-5**: plan guard — `EXPLAIN (FORMAT JSON)` for every §10 list under realistic row counts
  asserts index-backed ordering (no Sort node, no SeqScan on the paginated table).
- **TP-6**: constant-memory property on stage (parse+prepare+COPY of a 1M-row file: RSS
  plateau) — the §3.2 criterion 3 exercised through the full drive, not just the loader.
- **TP-7**: limits — every §5 ceiling boundary-tested through the API seams (413/429/`deferred`),
  including the pre-gate honest refusal while gates are unclear (08 T7 covers routing; this
  covers the published numbers being the enforced numbers — one constant, two consumers).

## Rollout

S-P5 → any time (observability/storage hygiene, no behavior). S-P2 rides 08 Phase A (limits
must exist before the first honest refusal ships). S-P1 gates Phase C (copy-mode engagement —
08 §1.2); its red path (fallback) is a launch-with-lower-ceiling, not a delay. S-P4 runs from
Phase A onward (fast-path soak first, copy soak once G07+G09 clear) and its green 2M run is
the trigger for the §5 raise column. S-P3 ships only on its named triggers. Phase placement:
doc 14; sequencing: doc 15.

## Success Metrics

- **p95 wall time, 2M-row copy import:** ≤ **90 min at C=1** (launch), ≤ **30 min at C=4**
  (post-raise) — measured by TP-2; stage 6 within its §1.2 budget.
- **Fast-lane p95 under whale load:** commit→terminal ≤ **3 min** for a ≤ 5 000-row import
  while a 2M-row job runs (TP-3); fast-lane wait ≤ one chunk duration.
- **Zero OOM, ever:** worker RSS independent of file size (TP-6 plateau; §3.2 criterion 3) —
  the constant-memory property is a release gate, not a hope.
- **G09 closed with numbers:** spike green in CI at ≥ 20k rows/s, ≤ 128 MB, clean mid-stream
  cancel — or the fallback's measured floor recorded and the §5 ceiling set accordingly.
- **G12 closed:** every §5 number enforced from one constant set, rendered pre-upload, carried
  in problem details; **503-shed count ~0** in production (product limits always engage first).
- **Counter/poll costs stay noise:** job-row lock waits < 1% of chunk time; poll p95 < 10 ms;
  0 accounting-identity violations (09 §8's S1 alert never fires).
- **G25 discipline holds:** zero new uniques or inbound FKs on the two partition-intent tables
  (R2/R3 verified at every 15-step review); `import_job_rows` gauge < 100M or the conversion
  is scheduled.
- **Keyset mandate:** TP-5 green for every §10 row; zero OFFSET pagination anywhere in the
  import surface.
