# 08 — Database-Operations Module

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 08 · **Status:** ✅ Drafted
> · **Prev:** [`07-Enrichment-Engine`](./07-Enrichment-Engine.md) · **Next:** `09-Security-Compliance-Scalability`

---

## 1. Executive Summary

The console the internal **Database-Operations team** uses to *operate* the data — review queues, quality
management (merge/split/validate/correct/restore/history), advanced filtering, and batch administration. It
**extends the shipped data-ops read surfaces** (`apps/admin/features/data-ops`: overview, imports, enrichment/
verification/quality monitors, dedup-review read, validation rule-builder) with the *operate* verbs, all over the
**maker-checker approval engine already built** so destructive actions stay approval-gated + audited (gaps
P11/P12).

## 2. Objectives

- One place to review newly-collected/pending/failed/duplicate records and act (approve/reject/merge/split/correct).
- Advanced filtering across every operational dimension; safe batch operations.
- Every action audited; destructive/cross-tenant ones maker-checker-gated.

## 3. Research synthesis

ML-proposes / humans-review-the-tail, with confidence thresholds routing only ambiguous cases to stewards
(Phase 01 §3.6). We adopt the **review-queue + clerical-merge/split + batch-admin** pattern, layered on our
approval engine (advantage: governed, audited, reuses shipped infra; disadvantage: more UI — accepted).

## 4. Proposed Architecture (sub-surfaces)

| Sub-surface | Does | Built on |
|---|---|---|
| **Review Queue** | new / pending-enrich / failed-enrich / duplicate-review; approve/reject | `match_links(review_status='pending')` (Phase 04) + approvals |
| **Dedup Merge/Split** | confirm/reject a match; merge two clusters; split a bad merge | non-destructive re-projection (Phase 05); `dedup_merge` approval op (exists) |
| **Quality Management** | clean/validate company+contact, correct enrichment, approve/reject AI suggestions, restore version, view history | knowledge-DB lineage/version (Phase 05) |
| **Conflict Resolution** | resolve survivorship conflicts (pick the winning value) | `field_provenance` (Phase 05) |
| **Advanced Filtering** | filter by source / batch / collection-method / provider / enrichment-status / validation-status / confidence / freshness / industry / geo / size / revenue / tech / title / dept / seniority / tags / review-status / quality-score | search + the new operational columns |
| **Batch Admin** | bulk edit/approve/reject/enrich/export; scheduled maintenance; queue + perf monitoring; audit; lineage; version control; activity tracking | bulk actions + approvals + the monitors (shipped) |

## 5. Database · API · UI

- API: `/admin/data/review/*` (queue + decisions, `data:review`), `/admin/data/records/*` (detail + lineage +
  history + correct, `data:manage`), `/admin/data/dedup/*` (merge/split — the executor lands with Phase 04/05;
  the `dedup_merge` approval branch is currently stubbed, audit A2), `/admin/data/batch/*` (bulk ops, approval-
  gated). UI: `apps/admin/features/data-ops` gains `review/`, `records/[id]/`, `dedup/` action surfaces +
  the filter bar; follows the shipped single-file `api.ts` + `useState` + `StateSwitch`/`DataTable`/`Dialog`
  pattern.
- Permissions: `data:read` (view), `data:manage` (correct/batch), `data:review` (approve merges/queue),
  `data:export`; destructive/cross-tenant via `withPlatformTx` + maker-checker.

## 6. Workflows · Edge cases · Risks

- **Workflow:** record enters the queue (low-confidence/failed/duplicate) → steward reviews → action (approve/
  reject/merge/split/correct) → audited; merges/exports/deletes → maker-checker → executor.
- **Edge:** an empty pending queue until probabilistic ER populates it (Phase 04 — flagged today); a merge a
  steward wants to undo (non-destructive re-projection); a batch action exceeding the cap (chunk/async).
- **Risks:** the merge/split executor mutates the master graph (audit A2 — security-reviewed, non-destructive);
  cross-tenant PII in the review queue (gated `data:review`, audited — the X1 "both screens" decision).

## 7. Migration · Rollback · Testing · Scale

- **Migration:** additive surfaces behind the `data:*` caps (shipped); the merge/split executor lands with the
  Phase-04/05 substrate. **Rollback:** surfaces are read-safe; the write actions are flag/approval-gated.
  **Tests:** queue routing by confidence; merge→split→re-derive; batch-op caps; cross-tenant isolation on every
  read/write; maker≠checker on destructive ops. **Scale:** bounded reads (`PLATFORM_READ_LIMIT`), async batch,
  filter indexes.

## 8. Implementation Checklist

- [ ] Review-queue surface + decisions · [ ] dedup merge/split actions (Phase 04/05 executor) · [ ] record detail
  (lineage/version/correct) · [ ] advanced filter bar · [ ] batch admin (approval-gated) · [ ] activity/audit
  views · [ ] isolation + maker-checker itests. **Depends on:** Phase 04 (queue population) + Phase 05 (lineage/
  non-destructive merge) + the shipped approval engine.
