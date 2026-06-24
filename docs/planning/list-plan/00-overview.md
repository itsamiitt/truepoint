# List Tab — Overview & Decisions (00)

> **Status:** Plan (not yet built). **Owner:** Product + Platform. **Last updated:** 2026-06-24.
> This is the spine document for the `docs/planning/list-plan/` set. The **Locked Decisions** and
> **Shared Vocabulary** below are canonical — every other doc in this folder cites them verbatim and
> must not contradict them.

## 1. Why we're building this
TruePoint already lets a workspace search a masked universe and **reveal** contacts on credit. What it
lacks is a first-class **place to collect, own, and work a book of prospects** — the unit of work every
seller actually lives in. Today "lists" exist only as a backend (`@leadwolf` API + schema) with no surface,
no upload path, and no way to act on a list in bulk.

The **List tab** closes that gap. It is the workspace's home for three jobs:

1. **Bring your own data** — upload a CSV/XLSX of prospects, map columns, dedup against what you already
   have, optionally **match-and-enrich** against our data, and land the rows in a list.
2. **Collect from Prospect** — search the universe, **reveal** the contacts worth paying for, and **add
   them to a list** (single or bulk, including select-all-across-search).
3. **Work the list** — run bulk actions on the members: enrich, re-verify, reveal, assign owner, tag,
   change status, enroll in a sequence, push to CRM, export.

Intended outcome: a seller can go from "I have a spreadsheet / I found 200 good prospects" to "they're an
owned, enriched, verified, actionable list" without leaving TruePoint — and the platform can operate that
safely, with a clear, **privacy-first** stance on what staff and admins may do with the uploaded data.

## 2. The three core jobs (scope)
| Job | Entry point | Ends at |
|-----|-------------|---------|
| **Upload your own data** | Lists tab → "Import into list" | Rows landed in a list, deduped, optionally enriched, import receipt |
| **Reveal-from-Prospect → add-to-list** | Prospect surface → reveal → add-to-list / bulk add-to-list | Member rows in the chosen (or new) list |
| **Work the list** | Lists tab → list detail → bulk-action bar | Members enriched / verified / revealed / assigned / exported / enrolled |

### In scope (this plan)
- A new **top-level "Lists" destination** and its `/lists` index + detail surface.
- **CSV + XLSX** upload targeting a list, with column-map templates, preview, dedup, conflict policy, and
  optional **match-first enrichment** on import.
- **Add-to-list** from Prospect (fix the known stubbed `RecordDetail` path; reuse the working bulk path).
- **Work-the-list** bulk operations, reusing the Prospect bulk-action framework.
- **Static lists** now; **dynamic / saved-search lists** in a later phase.
- A **privacy-first admin/staff governance model** for uploaded list data, built on the existing 3-tier
  RBAC + append-only platform audit + impersonation.

### Out of scope (explicitly, for now)
- Any **contributory / co-op** ingestion of uploaded data into the shared graph (see Decision 1 — OFF).
- The **sequences/outreach engine** itself (Lists hands off to it; it ships on its own milestone).
- **CRM sync** beyond a stubbed handoff (M10 track).
- **BYOK**, multi-region **data residency**, and **SOC 2** attestation — noted as roadmap in `08`, not built here.

## 3. Locked decisions (canonical — cite these everywhere)
> Confirmed with the user on 2026-06-24. These are not open for re-litigation inside the other docs.

- **D1 — Uploaded data is strictly isolated.** A customer's uploaded list data is theirs alone and
  **never feeds the shared/global master graph**. We **match-against** the master graph for that
  customer's own dedup + enrichment, but **contribute-to is OFF** (no co-op, no opt-in to contribute in
  this plan). Aligns with **ADR-0021** ("match-against ≠ contribute-to"; co-op off by default) and
  `06-enrichment-engine.md §1`.
- **D2 — Staff powers are privacy-first.** Internal/platform staff see only **list metadata + aggregate
  usage/billing**. Any **record-level** access to a tenant's list contents requires an **audited,
  time-boxed break-glass impersonation** session (built on `impersonationSessions` + `platform_audit_log`).
  **No casual browsing, no bulk PII export by staff.** Abuse and **DNC/suppression** controls are in scope.
- **D3 — Lists is a new top-level destination.** A 7th entry in `apps/web/src/components/shell/navConfig.ts`,
  with `app/(shell)/lists/` + `apps/web/src/features/lists/` mirroring the `features/prospect` structure.
- **D4 — Hard boundary stays Postgres RLS.** Workspace/tenant isolation is enforced below the app layer
  (`withTenantTx` GUCs + `rls/*.sql`), unchanged. List ownership and "my lists" are **filters**, not a new
  access wall (mirrors the prospect soft-owner model).
- **D5 — Money rules are inherited, not reinvented.** Reveal is per-workspace first-wins, idempotent,
  suppression-gated; **charge only for matched/valid data**, **credit-back on hard bounce** (ADR-0007,
  ADR-0013). Bulk actions always **show cost + estimate before spend**.

## 4. Shared vocabulary (canonical)
- **List** — a workspace-scoped, named collection of contacts. `list_kind ∈ {static, dynamic}`.
- **Static list** — explicit membership (`list_members` rows); a snapshot you curate.
- **Dynamic / saved-search list** — membership derived from a saved `ContactQuery`; auto-refreshes (Phase 4).
- **Member** — a `list_members` row linking a list to a workspace-visible `contacts` row.
- **Import into list** — an upload job whose landed rows are added to a target list.
- **Match-against** — resolving an uploaded/owned row to a master entity for the customer's own
  dedup/enrichment (always allowed). **Contribute-to** — feeding the shared graph (OFF, per D1).
- **Work-the-list** — the bulk-action surface on a list's members.
- **Break-glass** — an approved, time-boxed, fully-audited staff impersonation used for record-level support.

## 5. What we build on (summary; details in `02`–`08`)
The Lists **backend already exists** (schema/repo/core/API/RLS); the **import pipeline** exists (CSV, async,
deduped, PII-encrypted; XLSX is the gap); **enrichment + reveal + add-to-list** exist; and a **3-tier staff
RBAC + append-only `platform_audit_log` + impersonation** foundation exists. This plan is therefore mostly
**surface + wiring + governance**, not greenfield. The per-area "build-on-this" maps live in each doc.

## 6. Success metrics
- **Activation:** % of workspaces that create ≥1 list and add ≥1 member within 7 days.
- **Upload success:** import match-rate surfaced; <2% rejected-row rate on well-formed files; p95 import job
  < a documented SLO for 10k rows.
- **Work-the-list:** % of list members enriched/verified; bulk-action affected-count accuracy = 100%.
- **Trust/governance:** 100% of staff record-level accesses carry an impersonation + audit row; 0 cross-tenant
  leaks in the isolation-guarantee itest; DSAR deletion provably cascades.

## 7. Milestone map (full detail in `09-rollout-phases.md`)
`Phase 0` data-model & foundations → `Phase 1` Lists tab surface → `Phase 2` upload-into-list (+XLSX) →
`Phase 3` work-the-list bulk ops → `Phase 4` dynamic/saved-search lists → `Phase 5` admin/staff governance
& compliance.

## 8. Document index
| Doc | Purpose |
|-----|---------|
| `00-overview.md` (this) | Vision, locked decisions, vocabulary, scope, metrics, index |
| `01-research-summary.md` | Web research: enterprise mechanics + governance, with sources |
| `02-data-model.md` | Schema extensions, RLS, isolation guarantee, DSAR cascade |
| `03-upload-and-import.md` | Upload-your-own-data → list (CSV/XLSX, map, dedup, match-first) |
| `04-list-workspace-ui.md` | The Lists tab + list detail + work-the-list UI |
| `05-prospect-to-list.md` | Reveal-from-Prospect → add-to-list path |
| `06-enrichment-verification.md` | Bulk enrich/verify/reveal, match-first→waterfall, credit-back |
| `07-admin-staff-governance.md` | Privacy-first staff capability matrix + audit + DNC |
| `08-security-compliance.md` | RLS, encryption, GDPR/CCPA/DPA, DSAR, retention |
| `09-rollout-phases.md` | Phased roadmap, work units, e2e verification recipe |
