# Import & Data-Model Redesign — Planning Series

> **Status:** complete — all 18 docs written & adversarially reviewed (planning only — no code,
> no migrations ship from this series; `16` stays living as phases ship).
> **Date opened:** 2026-07-02 · **Branch:** feat/data-mgmt-01-research-brief
> **Scope:** the customer-facing Import Management System and the Contact/Company data model
> (multi-value phones/emails, company hierarchy/domains, job visibility, import UX).

## Why this series exists

Two problems were reported against the current implementation:

1. **The import system is broken/untrustworthy** — imports appear to "not work"; queued import
   jobs are visible to every user in a workspace instead of only the owner + authorized admins.
2. **The import UX is poor** — the Import card / Import page are not intuitive; entry points,
   mapping, progress, and error handling need an enterprise-grade redesign.

This series audits the current system (`01`), explains the root causes (`02`), researches how
enterprise Sales-Intelligence/CRM platforms solve these problems (`03`), and designs the target
state (`04`–`15`), ending in an executable phased roadmap. `16` is the living record of what
subsequently ships.

## Two-surface note

This series designs **Surface 2** — customer self-service in `apps/web`, RLS-scoped
(`withTenantTx`) and `requireOrgRole`-gated. The internal staff console (**Surface 1**,
`apps/admin`, cross-tenant `withPlatformTx`, staff capabilities `data:read/manage/review/export`)
is designed in [`database-management-research/`](../database-management-research/README.md) —
especially its `04-Control-Panel-Architecture.md`, `05-Upload-Pipeline-Design.md`, and
`11-Roles-and-Permissions.md`. A staff capability must never gate `apps/web`; an org role must
never gate `/admin/*`.

## Conventions

- **Status legend** (mirrors `database-management-research/`):
  ✅ shipped & live · 🌒 built, dark (flag-off) · 💤 built, inert/double-gated ·
  🟡 partial · 🔲 not built (design only) · ❌ blocked on a missing prerequisite.
- **Per-doc template** (design docs `04`–`15`): Objective · Reconciliation · Current
  Challenges · Enterprise Best Practices (cited) · Gaps · Recommended Solution ·
  Implementation Steps · UI/UX · DB & Backend · API · Edge Cases · Testing · Rollout ·
  Success Metrics. Sections may be omitted only when genuinely inapplicable.
- **Reconciliation is mandatory.** Every design doc opens with a Reconciliation section pinning
  it to shipped code and locked prior decisions: DM1–DM9 (`../data-management/00-overview.md`),
  ADR-0028 (jsonb custom fields), the bulk-import design-of-record
  (`../data-management/15-bulk-import-design.md`), and the **shipped**
  `packages/types/src/staffCapability.ts` (which supersedes doc-era capability lists).
- **Never cite fixed migration numbers.** Migrations have been renumbered before (the import
  trio is `0032_bulk_import_jobs` on disk while older docs say 0024). Designs reference
  **step IDs** (`S1`, `S2`, …, defined in `15`); the next free number is taken at PR time.
- **Gap IDs** are defined in `02-Root-Cause-and-Gap-Analysis.md` and cited by every design doc.
- **Research citations:** no external-platform claim enters a design doc except via the
  citation register in `03-Enterprise-Research.md`; design docs cite `03 §area`.
- **Brand:** the product is **TruePoint**; the package scope is `@leadwolf/*`. Both are
  correct, by design — never "fix" one to match the other.

## Document map & reading order

Orient (`00`→`01`→`02`→`03`) → data model (`04`→`05`→`06`→`07`) → import platform
(`08`→`09`→`10`) → experience (`11`) → cross-cutting (`12`→`13`) → execute (`14`→`15`→`16`).

Doc statuses in this table: 🔲 not written · 🟡 drafted · ✅ written & adversarially verified.

| Doc | Title | Status |
|---|---|---|
| [`00`](00-Executive-Summary-and-Recommendations.md) | Executive Summary & Recommendations | ✅ |
| [`01`](01-Current-State-Audit.md) | Current-State Audit (code-grounded source of truth) | ✅ |
| [`02`](02-Root-Cause-and-Gap-Analysis.md) | Root-Cause & Gap Analysis (gap register G01–G26) | ✅ |
| [`03`](03-Enterprise-Research.md) | Enterprise Research (citation register, 145 sources) | ✅ |
| [`04`](04-Contact-Schema-Design.md) | Contact Schema Design | ✅ |
| [`05`](05-Multi-Value-Channel-Architecture.md) | Multi-Value Channel Architecture (phones & emails) | ✅ |
| [`06`](06-Company-Schema-Design.md) | Company Schema Design | ✅ |
| [`07`](07-Data-Model-Relationships.md) | Data-Model Relationships (ER diagrams, constraints) | ✅ |
| [`08`](08-Import-Architecture.md) | Import Management Architecture | ✅ |
| [`09`](09-Queue-and-Background-Processing.md) | Queue & Background Processing | ✅ |
| [`10`](10-Visibility-and-Permissions.md) | Job Visibility & Permissions | ✅ |
| [`11`](11-UI-UX-Redesign.md) | Import UI/UX Redesign | ✅ |
| [`12`](12-Performance-and-Scalability.md) | Performance & Scalability | ✅ |
| [`13`](13-Security-and-Compliance.md) | Security & Compliance | ✅ |
| [`14`](14-Roadmap-Risk-and-Future-Enhancements.md) | Roadmap, Risk & Future Enhancements | ✅ |
| [`15`](15-Migration-Rollback-and-Testing.md) | Migration, Rollback & Testing | ✅ |
| [`16`](16-Implementation-Audit.md) | Implementation Audit (living) | ✅ (scaffolded; updates as phases ship) |

## Deliverable traceability

The engagement enumerated 20 deliverables. Each resolves here:

| # | Deliverable | Where |
|---|---|---|
| 1 | Current system audit | `01` |
| 2 | Root-cause analysis of existing issues | `02` |
| 3 | Enterprise Sales-Intelligence research findings | `03` |
| 4 | Complete Contact schema design | `04` |
| 5 | Complete Company schema design | `06` |
| 6 | Phone number architecture | `05` (phones **and** emails — same machinery) |
| 7 | Import Management architecture | `08` |
| 8 | Queue & background processing design | `09` |
| 9 | Permission & multi-tenant visibility model | `10` |
| 10 | UI/UX redesign proposal | `11` |
| 11 | Database relationship diagrams | `07` |
| 12 | Performance & scalability strategy | `12` |
| 13 | Security considerations | `13` |
| 14 | Multi-phase implementation roadmap | `14` §Recommended Solution (the phase spine) |
| 15 | Risk assessment | `14` §Risk register |
| 16 | Migration strategy | `15` §M-SEQ + §2 (mechanics per family) |
| 17 | Testing strategy | `15` §5 (Testing strategy) |
| 18 | Rollback strategy | `15` §4 (§R-P0…§R-P5) |
| 19 | Future enhancements | `14` §Future enhancements |
| 20 | Final enterprise architecture recommendations | `00` |

## Confirmed program decisions

1. **One combined series** (this folder) — import and data-model are causally coupled.
2. **The roadmap assumes the three bulk-infra enable gates get cleared** in their phase:
   production S3-compatible object store, real AV/malware scanning, and the Postgres
   COPY-FROM-STDIN spike. (`14` names the gates; `16` tracks their state.)
3. **The job-visibility model applies uniformly to ALL job surfaces** — import, reveal, and
   enrichment job lists plus the home Recent Imports card — not just imports.

## Relationship to prior series

| Series | Relationship |
|---|---|
| [`data-management/`](../data-management/00-overview.md) | DM1–DM9 locked decisions; `15-bulk-import-design.md` is the import design-of-record this series **extends, never contradicts** |
| [`database-management-research/`](../database-management-research/README.md) | Surface-1 counterpart (staff console); conventions/template source |
| [`prospect-database-platform/`](../prospect-database-platform/README.md) | I3 bulk-enrich (dark), I5 ER shadow, `05-Internal-Knowledge-Database` = the future projection that will *feed* (not replace) the overlay channel tables |
| [`worker-platform/`](../worker-platform/README.md) | Queue/outbox/reliability substrate; "Queued 4 / Awaiting Confirmation 1 is by-design" |
