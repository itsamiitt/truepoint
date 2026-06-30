# 00 — Vision & Scope Reconciliation

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 00 · **Status:** ✅ Drafted
> · **Next:** `01-Enterprise-Research`

---

## 1. Executive Summary

TruePoint needs a **central, continuously-operating Sales-Intelligence data platform**: a system that ingests
prospect/company data from many channels, runs it through a deterministic *and probabilistic* processing pipeline
(normalize → validate → dedup → identity-resolution → enrich → score → version → index), stores it as a permanent
**knowledge graph** with full lineage and freshness control, and **serves** clean, trusted records to every
module (search, lists, outreach, scoring, exports). The differentiator vs the current state is *continuity and
trust*: data arrives from uploads, a browser extension, enrichment providers, and connectors; it is never
enriched twice unnecessarily; every value carries a source, a confidence, and a freshness clock; and an internal
**Database-Operations team** governs quality through review queues and merge/split tooling.

This phase fixes the **scope** and reconciles it with what is already designed and shipped, so the program extends
the platform instead of rebuilding it.

## 2. Objectives

1. State the target platform precisely (the capability spine below).
2. Map each requested capability to **shipped / designed / net-new**, citing code + existing docs.
3. Name the **net-new modules** this program owns and the phase that designs each.
4. Set the documentation-first, enterprise-research-first operating model and the decision-rationale bar.

## 3. The capability spine (what "done" means)

- **Unified ingestion** — admin CSV/Excel/API/bulk/scheduled/incremental imports; the **Chrome Extension**;
  the **enrichment provider pipeline**; and an extensible **connector framework** (CRM, web forms, email-signature,
  partner, marketplace, manual/rep submission). One pipeline, many sources, one idempotent entry contract.
- **Processing** — normalize · standardize · validate (email/phone/domain) · dedup · **identity resolution**
  (deterministic + probabilistic) · company/contact matching · enrich · AI-assisted cleaning · quality + trust
  scoring · classification · indexing · serving.
- **Knowledge database** — historical enrichment, change tracking, **version history**, **data lineage**, source
  attribution, confidence scoring, freshness indicators, refresh scheduling, merge strategies, record linking,
  identity resolution — *reuse before re-enrich*.
- **Database-Operations module** — review queue (new/pending/failed/duplicate), manual approve/reject, merge
  suggestions + conflict resolution, quality management (clean/merge/split/validate/correct/restore/history),
  advanced filtering, and batch administration (bulk edit/approve/reject/enrich/export, monitoring, audit,
  lineage, version control, activity tracking).

## 4. Current-State reconciliation (shipped / designed / net-new)

> Grounded in the branch `feat/data-mgmt-01-research-brief`. "Shipped" = code exists (behind flags where noted);
> "Designed" = a planning doc exists; "Net-new" = neither.

| Capability | State | Evidence / Gap |
|---|---|---|
| Two-layer model (overlay RLS + master graph) | **Shipped** | `packages/db/src/schema/{contacts,masterGraph}.ts`; `withTenantTx`/`withErTx`/`withPlatformTx` (`client.ts`) |
| Admin CSV/XLSX import + validation + reject artifact | **Shipped** | `runImport`, `validateRow`, `rejectedRowsToCsv`; bulk COPY pipeline built but **DARK** (`BULK_IMPORT_ENABLED`) |
| Global validation framework (rules + reject-on-fail) | **Shipped** | `validation_rules` + engine + import enforcement + rule-builder UI (this branch) |
| Deterministic ER (resolve-or-mint) | **Shipped** | `masterGraphRepository.resolveForImport` — but writes **no** `source_records`/`match_links` |
| Probabilistic ER (Splink) + clerical queue | **Net-new** | `match_links` schema exists but is **never written**; `masterGraphMatcher` is a stub (audit A2/A10) |
| Identity-resolution **substrate** (source_records, projection) | **Net-new** | no `source_records` writer, no survivorship projector (`…/16` A2) |
| Knowledge DB: version history / lineage / freshness / refresh | **Designed-partial / Net-new** | `field_provenance` + `prov_hwm` seams exist, **unread**; no version table, no refresh scheduler |
| Enrichment engine (single-contact) | **Shipped** | `enrichContact`; bulk pipeline control rows exist but **no producer/worker** (audit A3) |
| Enrichment reuse/cache/refresh-rules/provider-history | **Net-new** | no dedup-of-enrichment, no refresh expiry, no provider confidence history |
| Reveal/charge/suppression money-loop | **Shipped** | `revealContact`, `assertNotSuppressed`, `suppressionRepository` |
| Export (customer + staff, suppression-gated) | **Shipped** | `bulkRevealExport`, `staffWorkspaceExport`, `findMatchExplicit` (this branch) |
| Maker-checker approvals + `data_ops` role + `data:*` caps | **Shipped** | approval engine + `staffCapability` (this branch) |
| Data-ops admin console (read surfaces) | **Shipped** | `apps/admin/features/data-ops` (overview, imports, enrichment/verification/quality monitors, dedup-read, validation rules) |
| **Chrome Extension capture** | **Net-new** | none |
| **Unified ingestion / connector framework** | **Net-new** | sources are point-built (import, reveal); no unified contract |
| DB-Ops module (review queue, merge/split, batch admin, filters) | **Designed-partial / Net-new** | read surfaces shipped; the *operations* (queue, merge/split, batch) are unbuilt |
| Retention engine (shadow→enforce) | **Shipped (inert)** | flag + approval-gated enforce wired; rollout deferred (sign-off) |

## 5. Net-new modules this program owns

1. **Unified Ingestion + Connector Framework** (Phase 03) — the single entry contract + the pluggable connector
   model that admin-upload, extension, enrichment, CRM, web-form, etc. all implement.
2. **Knowledge Database** (Phase 05) — version history, lineage, provenance, confidence, freshness, refresh rules,
   and the survivorship projector that makes the golden record a *re-derivable* view over immutable evidence.
3. **Probabilistic Identity Resolution** (Phase 04) — the Splink-style matcher + the `source_records`/`match_links`
   substrate + the clerical-review/merge-split actions (the audit's A2/A10).
4. **Chrome Extension Capture** (Phase 06) — the capture channel with consent/compliance + queue ingestion.
5. **Enrichment Engine v2** (Phase 07) — provider waterfall + reuse/cache/refresh + the bulk worker (the audit's A3).
6. **Database-Operations Module** (Phase 08) — the operate-the-data console for the internal data team.

## 6. Decision-rationale bar (carried into every phase)

Every architecture choice records: the enterprise patterns compared, the trade-offs, the chosen approach, and
*why it fits TruePoint's two-layer + multi-tenant + RLS model*. No shortest-path choice without justification; any
temporary debt is documented with a remediation plan. Security has final say on tenancy/PII/consent/egress.

## 7. Implementation Checklist (this phase)

- [x] Program README + roadmap created.
- [x] Capability spine + current-state reconciliation table (cited).
- [x] Net-new module list + owning phases.
- [ ] Phase 01 (Enterprise Research) — next iteration.

## 8. Edge cases / risks already visible

- **Substrate gap:** the knowledge-DB + probabilistic-ER vision rests on `source_records`/`match_links` being
  populated; today the deterministic path writes golden columns directly. Phase 04/05 must introduce the evidence
  log *without* breaking the shipped import landing path (a migration + dual-write window).
- **Extension consent/compliance:** browser capture introduces consent, scraping-ToS, and PII-at-source concerns
  that the upload path doesn't — Phase 06 + Phase 09 own this; Security has final say.
- **Cost control:** continuous enrichment across sources must reuse + cap spend (the worst-case pre-compute
  pattern already used for reveal) — Phase 07.
