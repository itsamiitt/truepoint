# Enterprise Prospect Database Platform — Master Plan

> **Status:** 🔶 Living roadmap · **Type:** Program index · **Owner:** Database/Data-Platform
> · **Policy:** Documentation-first (no implementation before a phase's planning docs are complete + reviewed).

This program designs and builds TruePoint's **central Sales-Intelligence data platform**: the system that
continuously **collects → normalizes → validates → deduplicates → resolves identity → enriches → scores →
versions → indexes → serves** prospect data to every module. It is a *scalable data platform*, not an upload
feature.

It is executed as a **continuous, phase-based workflow**. For every phase: research enterprise best practices →
research how leading platforms solve it → audit the current implementation → identify every gap → design the
enterprise solution → plan DB/backend/frontend/API/security/workflows/dependencies → edge cases → migration →
rollback → **document in detailed `.md`** → review → only then implement → test → optimize → update docs → proceed
to the next phase.

---

## 0. How this relates to what already exists (read first — do not duplicate)

This is **not** a greenfield. Substantial parts are already designed and/or shipped; this program **reconciles +
extends** them, and every phase doc must cite the current code/docs rather than re-describe them.

**Already documented:**
- [`docs/planning/database-management-research/`](../database-management-research/) — 16 docs (README + 01–15) +
  [`16-Implementation-Audit.md`](../database-management-research/16-Implementation-Audit.md): current-state,
  enterprise research (23 dimensions), gap register (G01–G32), control-panel/upload/validation/dedup/enrichment/
  approval/monitoring/roles/security/scaling/roadmap designs, and the live implementation audit.
- [`docs/planning/data-management/`](../data-management/) — 00–13 (the earlier data-management plan series).
- [`docs/planning/crm-sync/`](../crm-sync/) — the CRM bidirectional-sync plan.

**Already shipped (on `feat/data-mgmt-01-research-brief`):** the two-layer data model (Layer-1 overlay RLS +
Layer-0 master graph), the deterministic ER resolve/mint (`masterGraphRepository.resolveForImport`), the import
pipeline (`runImport`) + validation (`validateRow`) + the new global validation framework (rules + reject-on-fail
enforcement), the reveal/charge/suppression money-loop, the maker-checker approval engine + `data_ops` role +
`data:*` caps, the data-ops admin console (overview, import drill-down, enrichment/verification/fleet-quality
monitors, dedup-review read, validation rule-builder), and the **revealed-CSV export** (customer + staff
cross-tenant, suppression-gated). The retention engine (shadow), bulk-import (dark), and the verifier are built
behind flags.

**So this program's NET-NEW scope** (the parts not yet designed/built) is the spine of the phase list below:
a **unified multi-source ingestion layer** + **connector framework**, the **Chrome Extension** capture channel,
the **Internal Knowledge Database** (version history / lineage / provenance / freshness / refresh rules as
first-class), the **probabilistic identity-resolution + survivorship** layer that populates `match_links`/
`source_records` (today unwritten), and the **Database-Operations module** (review queue, quality management,
merge/split, advanced filtering, batch admin) beyond the read surfaces already shipped.

---

## 1. Phase roadmap

Each phase produces its own folder/`.md` set (research → audit → design → plan → document) and is **reviewed**
before its implementation begins. Phases are ordered for the critical path but parallelizable where noted.

| # | Phase | Theme | Net-new vs existing |
|---|---|---|---|
| **00** | [Vision & Scope Reconciliation](./00-Vision-and-Scope.md) | What we're building, mapped to current state | The reconciliation + phase plan (this doc set) |
| **01** | Enterprise Research | Ingestion, ER, enrichment, data-ops patterns (ZoomInfo, Apollo, Cognism, Lusha, RocketReach, Seamless, Sales Navigator, Clay, HubSpot, Salesforce, Outreach, Salesloft) | Extends `database-management-research/02` toward the *platform* (ingestion + knowledge-DB + extension) |
| **02** | Current-State Deep Audit | Every gap/limitation/debt/scalability issue vs the vision | Extends `…/16-Implementation-Audit` to the full platform |
| **03** | Unified Ingestion Architecture | One pipeline, many sources; the **connector framework** | NET-NEW |
| **04** | Processing Pipeline | normalize→validate→dedup→**identity-resolution**→enrich→score→classify→index→serve | Extends shipped `runImport`/validation/ER; adds probabilistic ER + scoring/indexing |
| **05** | Internal Knowledge Database | version history · lineage · provenance · confidence · freshness · refresh rules · survivorship | NET-NEW (the `source_records`/`match_links`/projection substrate is unwritten today) |
| **06** | Chrome Extension Capture | capture · dedup · enrich · consent/compliance · queue | NET-NEW |
| **07** | Enrichment Engine | provider waterfall · cache · dedup-of-enrichment · confidence · refresh-rules · provider history | Extends shipped enrichment; adds the reuse/refresh/cache + bulk pipeline (today broken) |
| **08** | Database-Operations Module | review queue · quality mgmt · merge/split · advanced filters · batch admin | Extends shipped read surfaces to the full ops console |
| **09** | Security, Compliance & Scalability | tenancy/RLS · PII/residency · consent (extension) · abuse · 10× scale | Extends `…/12`,`…/13` to ingestion + extension + knowledge-DB |
| **10** | Implementation Roadmap | sequencing · migration · rollback · flag rollout · risk | The build plan + gates |
| **11+** | **Implementation phases** | Build each phase per its docs; test→optimize→doc-update | Sequential, gated |

---

## 2. Per-document template (every phase doc uses the relevant subset)

Executive Summary · Objectives · Research Findings (cited) · Current System Analysis (cite `file:line`) ·
Gap Analysis · Proposed Architecture · Database Design · API Design · UI/UX · Business Logic · Workflows ·
Dependencies · Risks · Edge Cases · Migration Strategy · Rollback Strategy · Testing Strategy · Security ·
Scalability · Future Enhancements · **Implementation Checklist** · Rationale for major decisions.

## 3. Operating rules (carried from the directive + `CLAUDE.md`)

- **Documentation-first.** No implementation in a phase until its planning docs are complete + internally
  consistent + reviewed.
- **Enterprise research before decisions.** Compare ≥2 industry approaches, weigh trade-offs, design the best
  fit for TruePoint (don't copy one product), record the rationale.
- **No shortcuts.** Choose the scalable/maintainable/extensible solution over the shortest one; temporary debt is
  allowed only when explicitly documented with a remediation plan.
- **Security has final say.** Multi-tenant writes are RLS-enforced + ownership-checked + audited; cross-tenant
  staff writes go through `withPlatformTx`; PII egress is suppression-gated. (`CLAUDE.md` skill precedence.)
- **Branch + gates.** Work on the feature branch, never `main`; the sandbox can't run `bun`/`biome`/`typecheck`/
  itests, so every code slice is flagged for CI + (where sensitive) security review.

## 4. Status log

- **2026-06-30:** Program opened. Phase 00 (Vision & Scope Reconciliation) drafted. Export Phase 1/2 backends
  (from the prior task) are shipped and folded into the current-state baseline.
- **2026-06-30:** **Planning documentation COMPLETE** — Phases 00–10 drafted + internally consistent (vision →
  research → audit → unified ingestion → processing/ER → knowledge-DB → extension → enrichment → DB-ops →
  security/scale → implementation roadmap). The **documentation-first gate is reached**: implementation (stages
  I0 → I7, per [`10-Implementation-Roadmap`](./10-Implementation-Roadmap.md)) begins **after review**, evidence
  substrate (I0) first. All phases committed to `feat/data-mgmt-01-research-brief` (never `main`).
