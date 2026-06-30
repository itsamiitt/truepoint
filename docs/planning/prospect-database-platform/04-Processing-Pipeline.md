# 04 — Processing Pipeline

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 04 · **Status:** ✅ Drafted
> · **Prev:** [`03-Unified-Ingestion-Architecture`](./03-Unified-Ingestion-Architecture.md) · **Next:** `05-Internal-Knowledge-Database`

---

## 1. Executive Summary

The shared pipeline every ingested observation flows through after the connector hands it over:
**normalize → standardize → validate → dedup → identity-resolution (deterministic + probabilistic) → enrich →
score → classify → index → serve.** It composes the shipped pieces (`normalize`, `validateRow`, the validation
rule engine, `resolveForImport`, `revealContact`'s verifiers) and adds the **probabilistic ER tier + evidence
linking** that fixes P02. The pipeline is the single code path all connectors share (Phase 03), so dedup,
suppression, and scoring are guaranteed identical regardless of source.

## 2. Objectives

- One deterministic, ordered, resumable pipeline; per-record isolation (a bad record never fails the batch).
- Add probabilistic matching that writes `match_links` with `review_status` and biases to false-negatives.
- Emit a **trust + freshness score** (P10) the serving + ops layers consume.

## 3. Research synthesis

Deterministic-first, probabilistic-fallback, steward-the-tail (Phase 01 §3.2). Email/phone/domain validation as
discrete stages with multi-valued status (`catch_all`/`unknown` never auto-promoted to `valid`) — the existing
`database-management-research/06` rule. Normalize-before-compare and dedupe-before-enrich (cost control).

## 4. Proposed Architecture — the ordered stages

| Stage | Does | Reuses / New |
|---|---|---|
| **Normalize/standardize** | email/phone/domain/name normalization, blind-index keys | reuse `normalize.ts`, `encryptPii` |
| **Validate** | schema → field-format → cross-record; reject ledger | reuse `validateRow` + the validation rule engine |
| **Dedup (within-source)** | content-hash + identity-key collapse | reuse `runImport` dedup |
| **Identity resolution** | deterministic resolve-or-mint; **probabilistic fallback** → `match_links(review_status)` | reuse `resolveForImport`; **NEW** Splink-style matcher |
| **Evidence link** | append `source_records`, link to cluster | **NEW** (P01) |
| **Enrich** | reuse-before-call → waterfall (Phase 07) | extends `enrichContact` |
| **Score** | trust = f(validation, corroboration, recency); freshness clock | **NEW** (P10) |
| **Classify** | industry/seniority/department tagging | reuse intel signals |
| **Index** | search projection refresh | reuse `searchRepository` |
| **Serve** | masked reads; reveal-gated PII | reuse reveal/suppression |

### 4.1 Probabilistic identity resolution (P02)

- **Blocking** on cheap keys (email-domain, normalized name, company) to bound comparisons (the measured
  blocking-key strategy from `database-management-research/13`).
- **Scoring:** Fellegi-Sunter m/u weights → summed match weight (Splink). Three bands: **auto-merge** (≥ high
  threshold) → `review_status='auto'`; **review** (mid) → `'pending'` (the clerical queue, Phase 08);
  **no-match** (low). Bias: when in doubt, *don't* merge (false-negative bias) — Frankenstein merges are worse.
- **Writes:** `match_links { cluster_id, source_record_id, match_method, match_probability, review_status }` —
  the substrate the dedup-review surface (already shipped, read-only) consumes.
- **Status:** the matcher itself is **XL** (audit A10); v1 wires the deterministic path to write evidence +
  `match_links(review_status='auto')` so the queue, projector, and scoring are unblocked, and the probabilistic
  scorer lands behind a flag as a scale-track follow-up.

## 5. Database · API · Workflows

- DB: `source_records` writer (P01), `match_links` writer (P02), a `data_quality_score`/freshness columns refresh.
- API: internal (the pipeline runs in `apps/workers`); ops surfaces read `match_links` (shipped) + scores.
- Workflow: per observation, run the stages in order inside the appropriate tx (`withTenantTx` for overlay,
  `withErTx`/owner for master graph), isolate per-record errors into the reject ledger.

## 6. Edge cases · Risks · Migration · Rollback

- **Edge:** a record matching two clusters (merge candidate → `is_duplicate_of`, route to review, never auto-join);
  a re-observation of an existing record (append evidence, bump freshness, no new cluster); conflicting field
  values across sources (survivorship, Phase 05).
- **Risk/Migration:** the evidence + `match_links` writes must **dual-write** with the shipped landing behind
  `INGESTION_EVIDENCE_ENABLED` and be itest-proven byte-identical on the deterministic path before the projector
  (Phase 05) reads them. **Rollback:** flag off → deterministic landing only (today's behavior); evidence rows
  are additive.

## 7. Testing · Security · Scalability

Tests: stage ordering; `catch_all`/`unknown` never written `valid`; no auto-merge above the review threshold
without a human; deterministic dual-write parity; cross-tenant isolation. Security: master-graph writes via the
least-privilege `withErTx`/owner path; PII encrypted; suppression enforced at serve. Scale: blocking keys measured
before a run; dedupe-before-enrich; bulk lane below interactive (`…/13`).

## 8. Implementation Checklist

- [ ] `source_records` + `match_links` writers (deterministic path, flagged dual-write) · [ ] evidence-link stage ·
- [ ] trust + freshness scoring · [ ] reject-ledger integration · [ ] dual-write parity itests · [ ] (scale-track)
  the Splink probabilistic scorer behind a flag. **Depends on:** Phase 03 (ingestion) → feeds Phase 05 (projector)
  + Phase 08 (clerical queue).
