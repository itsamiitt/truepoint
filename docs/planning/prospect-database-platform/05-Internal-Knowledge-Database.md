# 05 — Internal Knowledge Database

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 05 · **Status:** ✅ Drafted
> · **Prev:** [`04-Processing-Pipeline`](./04-Processing-Pipeline.md) · **Next:** `06-Chrome-Extension-Capture`

---

## 1. Executive Summary

The knowledge database turns every observation into a **permanent, queryable, re-derivable intelligence asset**.
The golden `master_*` record becomes a **survivorship projection** over the immutable `source_records` evidence
log; each field carries **source attribution, confidence, and a freshness timestamp**; changes are *appended*, not
overwritten; "version history" is replay of the log; "freshness" is per-field age; and **refresh rules** decide
when to re-observe. This is the layer that makes *reuse-before-enrich*, lineage ("why is this value here?"), and
non-destructive merge/unmerge possible (gaps P01/P03/P04/P10).

## 2. Objectives

- Golden record = pure function of the cluster's evidence → recompute converges, rollback = replay.
- Per-field provenance + confidence + freshness; configurable refresh TTLs.
- Reuse: never enrich a field that is fresh + high-confidence.

## 3. Research synthesis

ZoomInfo's accuracy score is only possible because every value has source + validation-timestamp + confidence
(Phase 01 §3.2/3.4). MDM survivorship (attribute-level source-priority/recency/frequency rules) and append-only
evidence are the enterprise norm. We adopt **derived-golden-over-immutable-evidence** (advantage: lineage,
rollback, reuse; disadvantage: a projector + storage — accepted).

## 4. Proposed Architecture

### 4.1 The projection

```
source_records (immutable evidence: source, collectedAt, rawData, confidence)
        │  match_links (cluster membership; is_duplicate_of on merge)
        ▼
survivorship projector  →  master_persons / master_companies / master_employment
                            + field_provenance {field: {src, confidence, validatedAt}}
                            + prov_hwm (high-water-mark)
                            + data_quality_score (the trust score)
```

- **Survivorship rules** (per field, configurable, audited): source-priority → recency → frequency →
  completeness → confidence, with cascading fallback (`database-management-research/07` G24). Deterministic →
  recompute is idempotent.
- **Projection trigger:** a `projection_outbox` row enqueued on any evidence change for a cluster; a worker
  rebuilds the affected golden record. Re-projection is the unit of "refresh after merge/unmerge/new-evidence".

### 4.2 Version history & lineage

- **Version history** = the ordered evidence + the projection at each high-water-mark; "restore previous version"
  = re-project excluding evidence after a timestamp (no separate version table needed — replay).
- **Lineage** = trace a golden field → its winning `source_record` → the ingestion job → the connector/source.

### 4.3 Freshness & refresh rules

- Each field's `validatedAt` drives a **freshness clock**; a per-class **TTL** (e.g. email 90d, title 180d) marks
  a field stale. A **refresh scheduler** (worker) enqueues re-verification/re-enrichment for stale, in-use fields
  (reuse the reverification queue). Reuse: the enrichment engine (Phase 07) checks freshness *before* any provider
  call.

### 4.4 Reuse / dedup-of-enrichment

Before an enrichment provider is called for a field, the engine checks the knowledge DB: if a fresh,
high-confidence value exists (own data or a cached prior enrichment), **reuse it — no call, no spend**. Provider
results are cached as evidence with confidence + provider attribution + a TTL.

## 5. Database design

- **Writers (new):** `source_records`, `match_links`, `projection_outbox` (cluster_id, reason, enqueued_at,
  status). **Activate (unread today):** `field_provenance`, `prov_hwm`, `data_quality_score`.
- **Refresh:** a `field_freshness`/TTL config (per data class) + the scheduler.
- RLS: master graph is system-owned (`withErTx`/owner); evidence is platform-owned, retention-swept.

## 6. API · UI · Workflows

- API: lineage/version reads for the ops console (`/admin/data/records/:id/{lineage,history}`); survivorship-rule
  config (`data:manage`, audited). UI: a record-detail "lineage + version history + freshness" panel (Phase 08).
- Workflow: evidence change → `projection_outbox` → projector rebuilds golden + provenance + score → search index
  refresh → freshness clock set.

## 7. Edge cases · Risks · Migration · Rollback

- **Edge:** conflicting high-confidence values (survivorship picks; the loser stays as evidence, visible in
  lineage); a merge then unmerge (re-project both clusters from evidence — byte-identical to pre-merge); evidence
  for a since-suppressed/erased subject (excluded from projection; tombstoned).
- **Migration:** backfill `source_records` from existing `contacts`/imports as "legacy evidence" so the projector
  has a baseline; dual-write new evidence; flip the projector to authoritative behind a flag once parity is
  itest-proven. **Rollback:** flag off → the directly-written golden columns remain authoritative (today's
  behavior); evidence/outbox are additive.

## 8. Testing · Security · Scalability

Tests: merge→unmerge→re-derive is byte-identical (the audit's G21 acceptance); survivorship determinism; reuse
skips a provider call when fresh; suppressed evidence never projects. Security: master-graph isolation; PII in
evidence encrypted + retention-swept; lineage reads are masked unless reveal-gated. Scale: outbox-driven async
projection; blocking-bounded; the projector is the load-bearing throughput component (`…/13`).

## 9. Implementation Checklist

- [ ] `projection_outbox` + the survivorship projector worker · [ ] activate `field_provenance`/`prov_hwm`/score ·
- [ ] freshness TTL config + refresh scheduler · [ ] reuse-before-enrich check · [ ] lineage/version reads ·
- [ ] legacy-evidence backfill · [ ] merge→unmerge re-derive itest. **Depends on:** Phase 04 (evidence + match_links
  writers). **Blocks:** Phase 07 (reuse), Phase 08 (lineage/history UI).
