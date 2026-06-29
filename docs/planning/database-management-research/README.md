# Database Management — Control Panel & Upload Workflows (Research + Multi-Phase Plan)

> **What this is.** A standalone, enterprise-grade research and implementation-planning series for a
> **Database Management control panel** and the **upload / data-operations workflows** that sit behind it —
> the surfaces where data can be **managed, validated, enriched, imported, exported, monitored, and
> maintained directly from the platform**.
>
> **Audience.** The TruePoint Database Management team (internal data-ops staff) and the engineers who will
> build the control panel, plus the product/security reviewers who gate it.
>
> **Status of this series.** `01` (current state) is authoritative and code-grounded. `02`–`15` are the
> research-and-design corpus. This is a *planning* deliverable — **no application code, schema, or config is
> changed by these documents.**

---

## The two-surface model

The plan deliberately separates **two distinct control surfaces**, because TruePoint already has two
distinct access models in code and conflating them is the most common way data-ops tooling becomes a
security incident:

| | **Surface 1 — Internal Staff Console** | **Surface 2 — Customer Self-Service** |
|---|---|---|
| **App** | `apps/admin` (port 3003, `admin.truepoint.internal`) | `apps/web` (the customer app) |
| **Who** | TruePoint Database Management / data-ops staff | A customer's own workspace admins |
| **Visibility** | **Cross-tenant** (every workspace) | **Own workspace only** (RLS-scoped) |
| **Access model** | Staff RBAC (`staffRole` + capabilities) | Customer RBAC (`org_role` / `requireOrgRole`) |
| **DB path** | `withPlatformTx` (audited, owner-role) / `withErTx` | `withTenantTx` (RLS, `leadwolf_app`) |
| **Audit** | `platform_audit_log` (in-tx) | `audit_log` (tenant, append-only) |
| **Purpose** | Operate, maintain, and remediate data at the fleet level | Let a customer manage *their* data |

Every document calls out which surface it is talking about. The default reading is **Surface 1** (the
"Database Management team" control panel); Surface 2 is the customer-facing mirror where a capability is
also exposed to workspace admins.

---

## Status legend (used throughout)

| Badge | Meaning |
|---|---|
| ✅ **Shipped** | Built and live in production-bound code, no gate. |
| 🌒 **Dark** | Fully built but disabled by a flag/env (no effect until flipped). |
| 💤 **Inert** | Built and "running," but in shadow / no-op mode (observes, changes nothing). |
| 🟡 **Partial** | Some of it exists; meaningful pieces are stubs or deferred. |
| 🔲 **Planned** | Designed/specced but not built (greenfield). |
| ❌ **Missing** | No implementation and (until this series) no committed design. |

---

## Document map

| # | Document | Type | What it answers |
|---|---|---|---|
| — | [`README.md`](./README.md) | Index | This file — orientation, surfaces, status legend, reading order. |
| 01 | [`01-Current-State-Analysis.md`](./01-Current-State-Analysis.md) | Analysis | What exists **today**, per subsystem, with `file:line` and gate state. |
| 02 | [`02-Enterprise-Research.md`](./02-Enterprise-Research.md) | Research | How enterprise Sales-Intelligence platforms run data ops (live-web, cited). |
| 03 | [`03-Gap-Analysis.md`](./03-Gap-Analysis.md) | Analysis | Best-practice (02) vs current-state (01) → prioritized gap register. |
| 04 | [`04-Control-Panel-Architecture.md`](./04-Control-Panel-Architecture.md) | Design | The control panel itself — both surfaces, nav, feature folders, composition. |
| 05 | [`05-Upload-Pipeline-Design.md`](./05-Upload-Pipeline-Design.md) | Design | End-to-end upload / import workflows; enable-and-harden the bulk pipeline. |
| 06 | [`06-Data-Validation-Framework.md`](./06-Data-Validation-Framework.md) | Design | Validation rules engine, reject triage, quality scoring. |
| 07 | [`07-Deduplication-and-Linking.md`](./07-Deduplication-and-Linking.md) | Design | Dedup, entity resolution, company↔person linking, review queue. |
| 08 | [`08-Data-Enrichment-Workflow.md`](./08-Data-Enrichment-Workflow.md) | Design | Enrichment console, provider waterfall, verification, freshness. |
| 09 | [`09-Review-and-Approval-System.md`](./09-Review-and-Approval-System.md) | Design | Maker/checker approval workflow for high-risk data operations. |
| 10 | [`10-Monitoring-and-Observability.md`](./10-Monitoring-and-Observability.md) | Design | Pipeline dashboards, queue/DLQ health, SLOs, lineage, cost. |
| 11 | [`11-Roles-and-Permissions.md`](./11-Roles-and-Permissions.md) | Design | Staff RBAC vs customer RBAC; capability matrix; separation of duties. |
| 12 | [`12-Security-and-Compliance.md`](./12-Security-and-Compliance.md) | Design | Tenant isolation, PII, residency, suppression, DSAR, hardening. |
| 13 | [`13-Performance-and-Scaling.md`](./13-Performance-and-Scaling.md) | Design | Scale strategy for ingest/enrich/dedup/search at 10×. |
| 14 | [`14-Implementation-Roadmap.md`](./14-Implementation-Roadmap.md) | Roadmap | Prioritized MVP / Medium-P1 / Medium-P2 / Enterprise phases, dependencies, gates. |
| 15 | [`15-Future-Enhancements.md`](./15-Future-Enhancements.md) | Vision | Long-horizon: CRM sync console, probabilistic ER, versioning, automation. |

### Recommended reading order

1. **Orient** — `01` (what we have) → `02` (what "great" looks like) → `03` (the gap between them).
2. **Design** — `04` (the panel) → `05`–`08` (the pipelines) → `09`–`13` (the cross-cutting concerns).
3. **Execute** — `14` (the phased roadmap) → `15` (where it goes next).

A reviewer short on time can read `01`, `03`, and `14` and get the whole arc.

---

## Document template

Every design document (`04`–`14`) follows the same skeleton so they are comparable and complete:

`Objective` · `Current Challenges` · `Enterprise Best Practices (cited)` · `Gaps in Current Implementation` ·
`Recommended Solution` · `Implementation Steps` · `UI/UX Requirements` · `Database & Backend Changes` ·
`API Requirements` · `Edge Cases & Failure Scenarios` · `Testing Strategy` · `Rollout & Migration Plan` ·
`Success Metrics & Acceptance Criteria`.

Analysis/research/vision docs (`01`, `02`, `03`, `15`) use the relevant subset.

---

## How this relates to the rest of the repo (light cross-links)

This series is **standalone** — it is written from first principles, not as an extension of the existing
planning corpus. Where a subject is already designed elsewhere, we cross-link rather than restate:

- `docs/planning/data-management/00–16` — the prior data-management spec + implementation log (bulk import,
  retention engine, enrichment/verification, identity/dedup). `01` and `03` here reconcile against its
  **shipped** reality.
- `docs/planning/crm-sync/00-enterprise-implementation-plan.md` — the enterprise bidirectional CRM-sync
  plan (greenfield); referenced by `08`, `15`.
- `docs/planning/list-plan/00–09` — list upload / import / governance series; referenced by `05`.
- `docs/ARCHITECTURE_MAP.md` — the live navigation map (auto-generated).

> **Brand vs code.** The product is **TruePoint**; the npm scope is **`@leadwolf/*`** and the root package
> is `leadwolf`. Both are correct, by design — do not "fix" one to match the other.

---

## Keeping this in sync

When a subsystem's status changes (a flag flips, a stub is implemented, a phase ships), update the
**status badge and `file:line` in `01`** first, then the affected gap row in `03` and phase gate in `14`.
`01` is the single source of current-state truth for the series; the rest reference it.
