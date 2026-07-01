# 11 — I3: Bulk Enrichment Pipeline (Build Record + Enable Gates)

**Status:** Built, DARK behind `BULK_ENRICHMENT_ENABLED` (default off). No schema added. Not yet enabled
in any environment. **Enabling is a separate, gated step — see "Enable gates" below.**

This closes build stage **I3** from [10-Implementation-Roadmap](./10-Implementation-Roadmap.md): fixing the
broken/orphaned bulk-enrichment path (audit gaps **A3 / P08**) with a **confirm-before-spend** money path that
can never run away.

---

## Model correction (important)

`enrichment_jobs` conflates **two** source models. The build targeted the **live** one:

| Model | Source | Status in repo |
|---|---|---|
| **Existing-contact re-enrich** (LIVE) | `POST /contacts/bulk/enrich` → `bulkEnrich` writes a job whose `options.contactIds` **is** the work-list (`sourceFile` = the literal `"bulk-reenrich"` placeholder) | Was **orphaned** at status `queued` (nothing consumed it). **This is what I3 built.** |
| **CSV-upload enrichment** (aspirational) | a real object-store key + `columnMapping`; `estimate.ts` samples it | **Not built** — no submit path, and it is **object-store cred-gated** like bulk import. `worstCaseBulkEnrichMicros` (slice 1a) belongs to this model. Deferred. |

The live model needs **no CSV staging and no object store**, which is why it was safe to build now.

---

## What shipped (all additive, all behind the flag)

| Slice | Commit | What |
|---|---|---|
| 1a | `8717e71` | `worstCaseBulkEnrichMicros` — worst-case ceiling primitive (for the CSV model). |
| 1b | `2858988`, `010322f` | **Confirm gate**: guarded `estimating → awaiting_confirmation → running` transitions (`setEstimateAwaitingConfirmation`, `confirmAwaitingJob`); `confirmBulkEnrichmentJob`; `POST /api/v1/enrichment/jobs/:jobId/confirm` (owner/admin); `BULK_ENRICHMENT_ENABLED` kill-switch. |
| 2 | `d86ebbf` | **Transport**: `bulkEnrichmentJobDataSchema` (drive\|chunk) + DLQ; `enqueueBulkEnrichmentDrive` (self-gated producer); flag-gated queue/DLQ/worker registration. |
| 3a | `ceda010` | **Drive**: `createChunks` (atomic batch); `runBulkEnrich` (guards on `running`, bands over the row count, resume-safe, zero spend). |
| 3b | `f2d2b3b` | **Chunk spend**: `bulkProcessEnrichChunk` — re-enrich the band via **unchanged `enrichContact`**, braked twice (below); `getChunk`, `addRunSpendReturningTotal`; guarded finalize; per-row ledger + progress. |
| 4 | `2c6024d` | **Capstone**: `bulkEnrich` routes a confirmed job into the pipeline when the flag is on (byte-identical `queued` orphan when off); confirm → `enqueueBulkEnrichmentDrive`; `ENRICH_COST_MICROS_PER_MATCH`. |

## The end-to-end path (only when the flag is ON)

```
POST /contacts/bulk/enrich
  → bulkEnrich: create job `estimating`, persist worst-case ceiling
    (contactIds.length × ENRICH_COST_MICROS_PER_MATCH), arm gate → awaiting_confirmation   [NO SPEND]
  → [human sees the ceiling] POST /enrichment/jobs/:jobId/confirm (owner/admin)
    → confirmAwaitingJob: awaiting_confirmation → running  → enqueueBulkEnrichmentDrive     [NO SPEND]
  → drive (runBulkEnrich): guards on `running`, chunk the work-list, fan out `chunk` jobs   [NO SPEND — free]
  → chunk (bulkProcessEnrichChunk): re-enrich each contact via enrichContact                [THE ONLY SPEND]
```

## The three brakes (a run can never run away)

1. **Confirm gate** — no job reaches `running` (or the drive) without an explicit human confirm of the shown
   worst-case ceiling. Guarded status transitions; there is no path from `queued`/`estimating` straight to
   `running`.
2. **Per-run cap** — the confirmed ceiling (`credit_estimate_micros`). Checked live before every paid contact
   against the atomic run total (`addRunSpendReturningTotal`, sees sibling chunks). A job with **no** ceiling
   caps at **0** → it spends nothing. Cache hits (cost 0) don't advance the tally, so the cap gates *spend*, not
   *processing*.
3. **Daily breaker** — inherited free by reusing `enrichContact` unchanged: it checks `spendSince(day)` against
   `ENRICH_DAILY_BUDGET_MICROS` before any paid call and throws `ProviderBudgetExceededError`, which the worker
   catches to stop the run.

## Flag-off safety

While `BULK_ENRICHMENT_ENABLED` is off: the confirm endpoint 403s, the producer enqueues nothing, the worker
is not registered, and `bulkEnrich` creates the same inert `queued` orphan as before. The shipped
single-contact `enrichContact` and `POST /contacts/bulk/enrich` (response shape + off-path behavior) are
**byte-identical**.

---

## Enable gates (owner: the user — do NOT flip autonomously)

1. **CI parity itest** — prove `POST /contacts/bulk/enrich` is byte-identical with the flag off, and that the
   on-path never spends before confirm. (Flipping the flag is a behavior change to a shipped endpoint.)
2. **Provider credentials** — real enrichment needs the provider keys (`APOLLO_API_KEY` / `ZOOMINFO_API_KEY` /
   `CLEARBIT_API_KEY`) and, for verification, Reacher (`REACHER_*`). Without them the waterfall reports `miss`.
3. **Calibrate `ENRICH_COST_MICROS_PER_MATCH`** — the default ($0.10/match) is a placeholder (07 §1); set it to
   the real per-match cost so the confirmed ceiling is honest.
4. **Flip `BULK_ENRICHMENT_ENABLED=true`** — only after 1–3.

## Known follow-ups (not blockers)

- Finalize uses a status re-read rather than an atomic completed-chunks counter (like `import_jobs`); a benign
  `completed`↔`paused` race converges to `paused` whenever any chunk braked (the correct outcome). A counter
  would make it fully race-free.
- The CSV-upload model + its object-store staging remain deferred (cred-gated).
- A customer UI for the confirm step (show the ceiling, a Confirm button) is not built — the endpoints exist.

---

Next stage: **I4 — Database-Operations module** (see [08-Database-Operations-Module](./08-Database-Operations-Module.md)
and [10-Implementation-Roadmap](./10-Implementation-Roadmap.md)).
