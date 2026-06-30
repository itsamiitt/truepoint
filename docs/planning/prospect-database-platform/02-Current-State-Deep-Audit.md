# 02 — Current-State Deep Audit

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 02 · **Status:** ✅ Drafted
> · **Prev:** [`01-Enterprise-Research`](./01-Enterprise-Research.md) · **Next:** `03-Unified-Ingestion-Architecture`

---

## 1. Executive Summary

A code-grounded audit of the platform against the Phase-01 patterns. It extends
[`database-management-research/16-Implementation-Audit`](../database-management-research/16-Implementation-Audit.md)
(which covered the data-management write tier) to the **whole platform** — ingestion, identity-resolution
substrate, knowledge DB, enrichment, extension, and data-ops. Verdict: the **request-time data path is strong**
(two-layer model, RLS, reveal/charge/suppression, validation, deterministic ER, approvals, export); the
**continuous-platform layer is largely greenfield** — the evidence log, probabilistic ER, knowledge-DB
version/lineage/freshness, the multi-source connector framework, the extension, and the bulk-enrichment worker.

## 2. Gap register (platform scope)

Severity: **S0** correctness/safety · **S1** major capability · **S2** enhancement.

| ID | Area | Sev | Current state (cite) | Gap vs the vision |
|---|---|---|---|---|
| **P01** | Evidence log | S0 | `source_records` schema exists; **no production writer** (`masterGraphRepository.resolveForImport` writes none) | No immutable evidence → no lineage, version history, or non-destructive merge. The substrate everything else needs. |
| **P02** | Probabilistic ER | S1 | `match_links` schema + `review_status` exist; **never written**; `masterGraphMatcher` stub | No fuzzy matching, no clerical queue population, no accuracy score. |
| **P03** | Survivorship projector | S1 | `field_provenance`/`prov_hwm` seams exist, **unread** | Golden record is written directly, not *derived* → no recompute/rollback. |
| **P04** | Knowledge DB (version/lineage/freshness/refresh) | S1 | none (provenance seam only) | No "why is this value here", no per-field freshness clock, no refresh scheduler, no reuse-before-enrich. |
| **P05** | Unified ingestion contract | S1 | point sources (`runImport`, reveal) | No single idempotent entry + connector framework → each source re-implements dedup/validate/enrich. |
| **P06** | Connector framework | S1 | none | No pluggable model for CRM / web-form / email-signature / partner / marketplace sources. |
| **P07** | Chrome Extension capture | S1 | none | No browser capture channel; no consent/ToS gate. |
| **P08** | Bulk-enrichment worker | S1 | `bulkEnrich` creates a `queued` job; **no producer/worker/consumer** (audit A3) | Bulk enrichment never runs; orphan `queued` rows. |
| **P09** | Enrichment reuse/cache/waterfall/refresh | S1 | single-contact `enrichContact`; daily $ breaker | No reuse-before-call, no provider waterfall, no cache, no freshness TTL, no provider history/auto-select. |
| **P10** | Confidence + trust + freshness scoring | S1 | `master_persons.data_quality_score` column unused | No published accuracy score (the ZoomInfo-style P(employed)×email-correctness×recency). |
| **P11** | DB-Ops module (operate verbs) | S1 | read surfaces shipped (`apps/admin/features/data-ops`) | No review queue actions, merge/split, conflict resolution, batch admin — only views. |
| **P12** | Advanced filtering | S2 | basic search exists | No source/batch/provider/enrichment-status/confidence/freshness/quality filters for the ops console. |
| **P13** | Bulk import GA | S1 | COPY pipeline built, **DARK** (`BULK_IMPORT_ENABLED`) | COPY spike + prod object store + canary flip (audit A7) — cred/infra-gated. |
| **P14** | Commercial verifier | S2 | `passThroughVerifier` until creds (audit A8) | Reacher/vendor creds. |
| **P15** | Scheduled / incremental imports | S2 | none | No cron-driven or delta imports. |
| **P16** | `master_persons.is_suppressed` | S1 | column exists, **inert** (no reader/writer; DSAR writes `suppression_list` only) | Layer-0 suppression mirror unbuilt — only the overlay path is gated today. |

## 3. What's solid (do not rebuild — compose)

The reveal/charge/suppression money-loop (`revealContact`), the suppression gate + the new explicit-scope matcher
(`assertNotSuppressed`/`findMatchExplicit`), validation (`validateRow` + the rule framework), deterministic ER
(`resolveForImport`), the import landing path (`runImport`), maker-checker approvals + `data_ops` + `data:*`, the
data-ops read console, and the export. The platform layers **on top of** these.

## 4. Dependency ordering (what must come first)

`P01 evidence log` → `{P02 probabilistic ER, P03 projector, P04 knowledge DB}`. `P05 unified ingestion` →
`{P06 connectors, P07 extension}`. `P09 enrichment reuse` depends on `P04 (freshness)` + `P08 (worker)`.
`P10 scoring` depends on `P02 + P04`. `P11 DB-ops` composes the approval engine (shipped) + `P02/P03`.

## 5. Risks

- **The evidence-log migration (P01)** must dual-write alongside the shipped deterministic landing without
  regressing imports — the single highest-risk change (Phase 04/05 design owns it; itest-gated).
- **Continuous enrichment cost** explodes without P04 reuse + P09 waterfall + a spend gate.
- **Extension (P07)** carries consent/ToS/PII-source exposure absent from every other source.

## 6. Implementation Checklist (this phase)

- [x] Platform-scope gap register (P01–P16), code-cited, severity + dependency-ordered.
- [x] "Solid, compose-don't-rebuild" inventory.
- [ ] Phases 03–10 design each cluster of gaps.
