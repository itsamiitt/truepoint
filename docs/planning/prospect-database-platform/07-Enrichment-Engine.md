# 07 — Enrichment Engine (v2)

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 07 · **Status:** ✅ Drafted
> · **Prev:** [`06-Chrome-Extension-Capture`](./06-Chrome-Extension-Capture.md) · **Next:** `08-Database-Operations-Module`

---

## 1. Executive Summary

A centralized enrichment engine that **reuses before it calls, waterfalls across providers, caches every result
with confidence + freshness, and pre-computes worst-case spend before any bulk run.** It extends the shipped
single-contact `enrichContact` and fixes the broken bulk pipeline (audit A3/P08: `bulkEnrich` creates `queued`
jobs that nothing processes) by adding the missing producer + worker + spend gate, and the reuse/refresh logic
the knowledge DB (Phase 05) makes possible (P09).

## 2. Objectives

- Never enrich a field that is fresh + high-confidence (reuse); never re-enrich identical data unless a refresh
  rule fires.
- Configurable provider **waterfall** with only-if-missing gating + auto-selection from provider history.
- Bounded, confirmed spend; a working bulk worker; provider confidence + history tracked.

## 3. Research synthesis

Clay's waterfall (sequential providers, "run only if blank", pay-per-hit, +30–50% coverage) vs. ZoomInfo's
owned-DB-first (cheap, staler). **TruePoint synthesis:** owned-knowledge-DB-first (free reuse), then a configured
waterfall for the residual — the best of both (advantage: coverage + cost control; disadvantage: config
complexity — mitigated by sane defaults + provider-history auto-select).

## 4. Proposed Architecture

```
enrich(field, subject):
  1. REUSE   → knowledge DB has a fresh, high-confidence value? → return it (no call, no spend)   [Phase 05]
  2. WATERFALL → for each provider in configured order, gated "only if still missing":
                 call → on hit: cache as evidence {provider, confidence, validatedAt, TTL}, stop
  3. REFRESH → stale-but-in-use fields are re-enriched by the scheduler (not on read)               [Phase 05]
  4. CHARGE  → enrichment is a SYSTEM cost (not user credits, per the shipped model); a daily +
               per-run budget breaker caps provider $; reveal is where users pay.
```

### 4.1 Bulk enrichment (fix P08)

- **Producer:** `enqueueBulkEnrichment` → `BULK_ENRICHMENT_QUEUE` (today defined, no producer). **Worker:** a new
  `apps/workers` consumer that chunks the job, runs the waterfall per row (match-first/reuse-first), updates
  `enrichment_jobs` progress, and honors `maxProviderCostMicros`.
- **Spend gate:** a **worst-case pre-compute** persisted to `enrichment_jobs.creditEstimateMicros` (mirror the
  shipped `estimateBulkSpend` reveal pattern) + the `estimating → awaiting_confirmation` status gate (already in
  the enum, unimplemented) → a human/maker-checker confirms before spend; the runner enforces the cap.
- **Latent bug to fix:** `bulkEnrich` currently creates orphan `queued` rows — the worker resolves them.

### 4.2 Provider management

- Provider **waterfall config** (order + only-if-missing rules) per data class; **provider history** (hit-rate,
  cost, confidence) drives **auto-selection**; provider configs reuse the shipped `provider-configs` admin.

## 5. Database · API

- Reuse `enrichment_jobs`/`_chunks`/`_rows` (control + cost columns exist). New: provider-waterfall config,
  provider-history aggregates. API: `POST /admin/data/enrichment/run` + `…/test-batch` (`data:manage`, spend-gated,
  maker-checker for full runs); `…/estimate` (worst-case). The data-ops enrichment console (read, shipped) gains
  the run/re-run/test-batch actions (audit A3).

## 6. Workflows · Edge cases · Risks

- **Workflow:** reuse-check → waterfall → cache evidence → score → project (Phase 05).
- **Edge:** all providers miss (record as `unmatched`, no charge on a miss per charge-on-hit); a provider returns
  a `catch_all`/`unknown` email (never auto-promote to `valid`); a refresh storm (scheduler rate-limits); a budget
  breaker trip (pause the run, surface in the console).
- **Risks:** runaway metered spend without the pre-compute gate (the core control); provider ToS/caching limits.

## 7. Migration · Rollback · Testing · Scale

- **Migration:** the worker + producer are additive behind `BULK_ENRICHMENT_ENABLED`; reuse/waterfall default to
  the current single-provider behavior when unconfigured. **Rollback:** flag off → single-contact `enrichContact`
  only (today). **Tests:** reuse skips a call when fresh; waterfall stops at first hit; worst-case estimate ≥ actual
  spend; bulk worker drains the queue; charge-on-hit-only. **Scale:** dedicated bulk lane below interactive;
  blocking-bounded; cache hit-rate is the cost lever.

## 8. Implementation Checklist

- [ ] `enqueueBulkEnrichment` producer + the bulk worker (drains `BULK_ENRICHMENT_QUEUE`, honors the cap) ·
- [ ] worst-case pre-compute + `awaiting_confirmation` gate · [ ] reuse-before-call (Phase 05) · [ ] provider
  waterfall config + history/auto-select · [ ] enrichment-console run/re-run/test-batch actions · [ ] fix the
  orphan-`queued` bug · [ ] spend + charge-on-hit itests. **Depends on:** Phase 05 (reuse/freshness). **Gated:**
  commercial verifier creds (audit A8) for the verify leg.
