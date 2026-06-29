# 04 — Control-Panel Architecture

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored ·
> **Prev:** [`03-Gap-Analysis`](./03-Gap-Analysis.md) · **Next:**
> [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md)

This is the **architectural spine** of the series. Docs [05](./05-Upload-Pipeline-Design.md)
through [13](./13-Performance-and-Scaling.md) each design one sub-area that *plugs into* the panel
defined here. When a later doc says "the Imports console" or "the Dedup review queue", it means a
feature folder and a router that conform to the contracts established in this document.

---

## 1. Objective

Define the **Database Management control panel** as a concrete, buildable surface across the two
TruePoint front-ends — without inventing a new architecture. The panel is not a new app; it is a
**new nav group + a family of feature folders** inside the apps we already ship, wired to a **new
audited admin router** in `apps/api`. Specifically this doc fixes:

1. **The two surfaces and the boundary between them.**
   - **Surface 1 — Internal Staff Console** (`apps/admin`, package `@leadwolf/admin`, Next 15 App
     Router, port 3003): a new **"Data management"** nav group with sub-area routes. Cross-tenant
     ops/maintenance. Every read/write goes through `apps/api` `/api/v1/admin/data/*` on the
     audited **`withPlatformTx`** path (`packages/db/src/client.ts:121`).
   - **Surface 2 — Customer Self-Service** (`apps/web`): extend the live
     `features/data-health` slice into a **workspace-scoped** data control panel. RLS via
     **`withTenantTx`** (`packages/db/src/client.ts:74`); gated by **`requireOrgRole`**, *not* staff
     RBAC.

2. **Navigation** — the exact `NavDestination` entries to add to
   `apps/admin/src/components/shell/navConfig.ts:32` and the `(shell)` routes to create.

3. **Feature-folder layout** — the `index.ts` / `api.ts` / `types.ts` / `hooks/use*.ts` /
   `components/<Area>Page.tsx` shape, copied verbatim from `features/imports` and `features/retention`,
   for 2-3 sub-areas in full.

4. **The capability model** — four new closed staff capabilities (`data:read`, `data:manage`,
   `data:review`, `data:export`) added to `packages/types/src/staffCapability.ts:13`, how they bundle
   into roles, and how `useStaffMe().has(cap)` gates rendered actions.

5. **The backend seam** — a new `adminDataRoutes` sub-router mounted in
   `apps/api/src/features/admin/routes.ts`, every handler on `withPlatformTx` with an audited action.

This doc does **not** design the *internal logic* of each sub-area (validation rules, dedup
blocking, enrichment waterfall, etc.) — those live in [06](./06-Data-Validation-Framework.md),
[07](./07-Deduplication-and-Linking.md), [08](./08-Data-Enrichment-Workflow.md). It designs the
**container** they all share.

---

## 2. Current Challenges

The data subsystems already exist but are **scattered, partly dark, and have no unifying operator
surface** (full inventory in [01-Current-State-Analysis §10](./01-Current-State-Analysis.md#10-status-summary-the-one-table-to-remember)):

| Subsystem | Status | Where it surfaces today |
|---|---|---|
| Standard import | **Shipped** (monitor-only) | `features/imports` — read-only tallies, never row contents |
| Bulk import (COPY) | **Dark** | `BULK_IMPORT_ENABLED` default false (`packages/config/src/env.ts:174`); no UI |
| Data validation | **Missing** | no framework, no console |
| Within-ws dedup | **Shipped** (auto, no UI) | dedup worker survivorship; nothing to review |
| Entity resolution / merge | **Partial** | deterministic only; `match_links.review_status` has no queue UI |
| Enrichment | **Shipped** | `features/provider-configs` (provider health only — no run console) |
| Verification | **Dark** | `passThroughVerifier` until `REACHER_*`/`TWILIO_*` creds |
| Data quality | **Shipped** (customer-only) | `apps/web/features/data-health`; **no fleet view** |
| Retention engine | **Inert shadow** | `features/retention` (policies + runs); deletes nothing |
| Compliance DSAR | **Shipped** | `features/compliance` |
| Monitoring | **Partial** | `features/system-health` (queue depth only) |
| Audit | **Shipped** | `features/audit-log` |

Concrete problems this doc solves:

- **No single pane.** An operator investigating "why is tenant X's import stuck" must cross four
  separate screens (`imports`, `system-health`, `retention`, `compliance`) with no rollup.
- **No drill-down.** `features/imports` shows `import_jobs` tallies only; there is no path to
  `import_job_chunks` / `import_job_rows` / rejects — exactly the row-level error report enterprise
  bulk pipelines expose ([02 §19](./02-Enterprise-Research.md#419-error-handling)).
- **No `data:*` capability.** The closed staff enum (`staffCapability.ts:13`) has 16 capabilities and
  **none** for data operations. There is no way to grant "can review merges but cannot export PII".
- **Dark features have no enable surface.** Bulk import and verification are flag-gated off with no
  operator screen to observe a canary before GA.
- **No cross-tenant data writes exist yet on a safe path.** Every data mutation today is either the
  customer's own (RLS via `withTenantTx`) or a worker. There is **no audited staff write path for
  data ops** — `withPlatformTx` exists but no data router uses it.

---

## 3. Enterprise Best Practices (cited)

This doc draws on the cross-cutting *operator-surface* dimensions of
[02-Enterprise-Research](./02-Enterprise-Research.md). The per-subsystem dimensions are cited by the
sibling docs that own them; here we cite the ones that shape the **panel**:

- **[02 §1 — Data ingestion](./02-Enterprise-Research.md#41-data-ingestion):** a server-owned job with
  an explicit state machine; get-job-info returns processed/failed/total. The console must read job
  state, not reconstruct it. → drives the **Imports & Uploads** drill-down.
- **[02 §11 — Audit logs / provenance](./02-Enterprise-Research.md#411-audit-logs):** attach
  source/workflow provenance to every record and **log every decision**. Every panel write is audited
  in-transaction (`withPlatformTx` → `platform_audit_log`). This is the load-bearing reason the panel
  cannot be a thin DB client.
- **[02 §15 — RBAC](./02-Enterprise-Research.md#415-rbac):** preview-vs-redeem privilege split as an
  *auth surface*; tenant/workspace-scoped, ownership-checked, RLS-enforced. → drives the four
  `data:*` capabilities and the read/manage/review/export split.
- **[02 §16 — Approval workflows](./02-Enterprise-Research.md#416-approval-workflows):**
  preview-then-commit; pre-compute worst-case spend before a bulk run. → the panel's high-risk
  actions (export, retention enforce) route through maker/checker, designed in
  [09](./09-Review-and-Approval-System.md).
- **[02 §20 — Monitoring dashboards](./02-Enterprise-Research.md#420-monitoring-dashboards):** job
  state + record counts + per-dimension quality + segment match-rate. → the **Data-Ops Overview**
  composes exactly these signals.
- **[02 §21 — Operational tooling](./02-Enterprise-Research.md#421-operational-tooling):** build tools
  *over* the audit/decision logs (Apollo Duplicate Analyzer); clerical-review console. → the panel is
  that tool layer over the data subsystems.

---

## 4. Gaps in Current Implementation

Mapped to the gap register in [03-Gap-Analysis](./03-Gap-Analysis.md):

| Gap | Tier | What's missing in the panel |
|---|---|---|
| No "Data management" nav group | **MVP / Phase 0** | one `NavDestination` group + sub-routes in `navConfig.ts` |
| No `data:read` capability | **MVP / Phase 0** | new closed-enum capability + `requireCapability` gate |
| No Data-Ops Overview | **MVP / Phase 0** | a rollup feature folder composing existing admin signals |
| No import drill-down | **MVP / Phase 0** | chunks/rows/rejects read endpoints + UI |
| Bulk import unenablable | **MVP / Phase 0** | observe surface to flip the dark flag per-tenant (engine work in [05](./05-Upload-Pipeline-Design.md)) |
| No dedup/ER review queue | **Medium / Phase 1** | `match_links.review_status=pending` queue ([07](./07-Deduplication-and-Linking.md)) |
| No enrichment run console | **Medium / Phase 1** | runs/cost/hit-rate ([08](./08-Data-Enrichment-Workflow.md)) |
| No `data:manage`/`data:review` | **Medium / Phase 1** | two more capabilities |
| No maker/checker | **Medium / Phase 2** | approval workflow ([09](./09-Review-and-Approval-System.md)) |
| No audited export + `data:export` | **Medium / Phase 2** | export feature folder |
| No customer self-service panel | **Medium / Phase 2** | extend `apps/web/features/data-health` |

The **panel architecture itself** (this doc) is the Phase-0 prerequisite: nav group + `data:read` +
Data-Ops Overview + the `adminDataRoutes` seam. Everything else hangs off it.

---

## 5. Recommended Solution

### 5.1 Two surfaces, one boundary

```
                        ┌─────────────────────────────────────────────┐
                        │                 apps/api                     │
                        │            (Hono on Bun, /api/v1)            │
                        │                                              │
   Surface 1            │   /api/v1/admin/data/*   (NEW router)        │
   apps/admin  ────────▶│     authn → platformAdmin → requireCapability│
   "Data management"    │     EVERY handler: withPlatformTx (audited,  │
   staff RBAC           │       owner conn, BYPASSRLS, in-tx audit row)│
                        │                                              │
                        │   /api/v1/admin/* (existing: import-jobs,    │
                        │     retention-runs, system-health, provider- │
                        │     configs, compliance, audit-log)          │
                        │                                              │
   Surface 2            │   /api/v1/data-health/*, /imports/*,         │
   apps/web  ──────────▶│     /enrichment/*, /compliance/dsar          │
   "Data" panel         │     authn → requireOrgRole → withTenantTx    │
   org RBAC             │       (SET LOCAL ROLE leadwolf_app, RLS on)  │
                        └─────────────────────────────────────────────┘
```

**The boundary, stated once:** *Staff console = cross-tenant ops & maintenance, owner-role,
audited, RLS-bypass-but-recorded. Self-service = own-workspace data management, app-role,
RLS-enforced, never audited to `platform_audit_log` (it's the tenant's own data).* A staff operator
acting on tenant data is a privileged, recorded event; a customer acting on their own data is not.
Per CLAUDE.md precedence: **Security has final say** — a cross-tenant data write without an
RLS-enforced-or-owner-audited, ownership/capability-checked path is a bug, not a style choice.

### 5.2 Surface 1 — the "Data management" nav group

A **single grouped destination** plus sub-routes. The current `navConfig.ts` is a flat
`DESTINATIONS` array (`navConfig.ts:32`); to introduce a *group* we extend `NavDestination` with an
optional `group` tag and a `children` list, keeping `isActive`/`sectionTitleFor` working. The
minimal, backward-compatible change:

```ts
// navConfig.ts — additions. Existing 14 flat destinations are untouched.
import {
  Activity, Building2, Database, FileUp, Flag, GitMerge, Layers, Megaphone,
  Plug, ScrollText, ShieldAlert, ShieldCheck, Sparkles, Tag, Timer,
  Users, Wallet, Workflow, Download, ListChecks,
} from "lucide-react";

export interface NavDestination {
  label: string;
  href: string;
  match: string;
  icon: IconComponent;
  /** Optional capability the caller must hold for this destination to render (UI gate only;
   *  the api stays authoritative). Omit = visible to any staff tier that reaches the shell. */
  requires?: StaffCapability;
}

export interface NavGroup {
  label: string;          // section header in the rail
  icon: IconComponent;
  children: NavDestination[];
}

/** The new Data management group (doc 04 §5.2). Rendered as a labelled section in the Sidebar.
 *  Every child is gated by data:read at minimum; the api re-checks per endpoint. */
export const DATA_MANAGEMENT_GROUP: NavGroup = {
  label: "Data management",
  icon: Database,
  children: [
    { label: "Data-Ops Overview", href: "/data", match: "/data", icon: Database, requires: "data:read" },
    { label: "Imports & Uploads", href: "/data/imports", match: "/data/imports", icon: FileUp, requires: "data:read" },
    { label: "Validation", href: "/data/validation", match: "/data/validation", icon: ListChecks, requires: "data:read" },
    { label: "Dedup & Linking", href: "/data/dedup", match: "/data/dedup", icon: GitMerge, requires: "data:review" },
    { label: "Enrichment", href: "/data/enrichment", match: "/data/enrichment", icon: Sparkles, requires: "data:read" },
    { label: "Review & Approval", href: "/data/review", match: "/data/review", icon: Workflow, requires: "data:review" },
    { label: "Monitoring", href: "/data/monitoring", match: "/data/monitoring", icon: Activity, requires: "data:read" },
    { label: "Retention & Governance", href: "/data/retention", match: "/data/retention", icon: Timer, requires: "data:read" },
    { label: "Export", href: "/data/export", match: "/data/export", icon: Download, requires: "data:export" },
  ],
};
```

> **Note on the existing `Bulk imports` and `Retention` flat destinations:** they stay where they
> are for now (sibling units own them). The new group's *Imports & Uploads* and *Retention &
> Governance* areas are the **cross-tenant data-ops** evolution; during Phase 0/1 they can re-host
> the existing read-only `features/imports` and `features/retention` slices, then absorb the
> drill-down/enforce features. We do **not** delete the flat entries in the same change — see §12.

`sectionTitleFor` is extended to search group children too, and `isActive` is unchanged (prefix
match still works because sub-routes are `/data/...` under the `/data` match prefix — the Overview
uses an exact match so it doesn't swallow children: keep the existing
`pathname === match || pathname.startsWith(match + "/")` and order children so the most-specific
wins, or give Overview `match: "/data"` and accept it highlights for children too, with the
sub-route's own entry winning via `sectionTitleFor` iterating children first).

**New `(shell)` routes** (mirror the existing `imports/page.tsx` thin wrapper at
`apps/admin/src/app/(shell)/imports/page.tsx`):

```
apps/admin/src/app/(shell)/data/
  page.tsx                      -> <DataOpsOverviewPage/>   (features/data-ops)
  imports/page.tsx              -> <DataImportsPage/>       (features/data-imports)
  imports/[jobId]/page.tsx      -> <DataImportDetailPage/>  (drill chunks/rows/rejects)
  validation/page.tsx           -> <DataValidationPage/>    (features/data-validation)
  dedup/page.tsx                -> <DedupReviewPage/>        (features/data-dedup)
  enrichment/page.tsx           -> <EnrichmentConsolePage/> (features/data-enrichment)
  review/page.tsx               -> <ReviewQueuePage/>       (features/data-review)
  monitoring/page.tsx           -> <DataMonitoringPage/>    (features/data-monitoring)
  retention/page.tsx            -> <RetentionGovernancePage/>(features/data-retention)
  export/page.tsx               -> <DataExportPage/>        (features/data-export)
```

Each `page.tsx` is the same three-line thin wrapper as `imports/page.tsx` — *all* behavior lives in
the feature slice; the `(shell)` group provides the `AdminShell` chrome and the two-stage authn+authz
gate (`AdminShell.tsx`).

### 5.3 Sub-area list and how each composes existing + new endpoints

| Sub-area | Composes existing `/admin/*` | New `/admin/data/*` | Min cap |
|---|---|---|---|
| **Data-Ops Overview** | `GET /admin/system-health` (queues/services), `GET /admin/import-jobs`, `GET /admin/retention-runs` | `GET /admin/data/overview` (aggregated `data_quality_snapshots` fleet rollup) | `data:read` |
| **Imports & Uploads** | `GET /admin/import-jobs` | `GET /admin/data/imports/:jobId` (chunks), `…/:jobId/rows`, `…/:jobId/rejects`, `POST …/:jobId/{pause,resume,cancel}` (job-level), `POST …/:jobId/chunks/:chunkId/retry` (chunk-level) | `data:read` / `data:manage` |
| **Validation** | — | `GET /admin/data/validation/rejects`, `…/rules`, `POST …/rejects/:id/requeue` | `data:read` / `data:manage` |
| **Dedup & Linking** | — | `GET /admin/data/dedup/review` (`match_links.review_status=pending`), `POST …/dedup/{confirm,reject,split}` (ids in body) | `data:review` |
| **Enrichment** | `GET /admin/provider-configs` | `GET /admin/data/enrichment/runs`, `…/runs/:jobId`, `POST …/runs/:jobId/{estimate,commit,rerun-failed}`, `POST …/test-batch` | `data:read` / `data:manage` |
| **Review & Approval** | — | `GET /admin/data/approvals`, `POST …/:id/{approve,reject}` | `data:review` |
| **Monitoring** | `GET /admin/system-health` | `GET /admin/data/monitoring/metrics` | `data:read` |
| **Retention & Governance** | `GET/PUT /admin/retention-policies`, `GET /admin/retention-runs`, `GET /admin/compliance/*` | `GET /admin/data/retention/preview` | `data:read` / `compliance:manage` |
| **Export** | — | `POST /admin/data/export` (request), `GET …/export/:id`, `GET …/export/:id/download` | `data:export` |

The **Overview composes signals already in the api** — it is mostly an aggregator. Only the fleet
`data_quality_snapshots` rollup is a genuinely new read. This keeps Phase 0 small: nav group +
`data:read` + one new endpoint + a page that fans out to four existing reads.

### 5.4 The `api.ts` seam + `useState` hook pattern (NO TanStack)

The admin app's network seam is **exactly** the `features/imports/api.ts` shape: a typed
`fetchWithAuth` against `${API_BASE}/api/v1/admin/...`, with a local `problemMessage(res, fallback)`
reading the RFC-7807 `detail`/`title`. Hooks are **hand-rolled `useState`/`useEffect` returning
`{ data, loading, error, reload }`** — *no TanStack/React Query* (see [11 §RBAC](./11-Roles-and-Permissions.md)
and the user-memory `turbo-cross-package-devdep-cycle` constraint: keep the admin app's deps lean).

Worked example — the **Data-Ops Overview** slice, file by file (mirrors `features/imports`):

```
apps/admin/src/features/data-ops/
  index.ts                       // public surface: export { DataOpsOverviewPage }
  api.ts                         // the ONLY network seam
  types.ts                       // presentation mirrors of @leadwolf/types shapes
  format.ts                      // number/date formatting helpers (like imports/format.ts)
  hooks/useDataOpsOverview.ts    // {data, loading, error, reload}
  components/DataOpsOverviewPage.tsx
```

```ts
// features/data-ops/api.ts
import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { DataOpsOverview } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/data/overview — fleet-wide data-ops rollup (queues + import/retention runs +
 *  aggregated data_quality_snapshots). Counts/aggregates only — never row contents/PII. */
export async function fetchDataOpsOverview(): Promise<DataOpsOverview> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/overview`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load data-ops overview"));
  return (await res.json()) as DataOpsOverview;
}
```

```ts
// features/data-ops/hooks/useDataOpsOverview.ts
"use client";
import { useCallback, useEffect, useState } from "react";
import { fetchDataOpsOverview } from "../api";
import type { DataOpsOverview } from "../types";

export function useDataOpsOverview() {
  const [data, setData] = useState<DataOpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDataOpsOverview());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data-ops overview");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}
```

This is byte-for-byte the `useImportJobs` convention (`features/imports/hooks/useImportJobs.ts:10`).
A **write** slice (e.g. retry an import) mirrors `features/retention`'s write path: a separate
mutation function in `api.ts` (POST), invoked from a `Dialog` with a **mandatory justification
reason** + `useToast`, then `reload()` — the `TenantActions.tsx` pattern.

### 5.5 The capability model + render-gating via `useStaffMe`

Add **four** capabilities to the closed enum (`packages/types/src/staffCapability.ts:13`):

```ts
export const staffCapability = z.enum([
  // …existing 16…
  "data:read",    // read the cross-tenant Data-Ops console (overview, imports, monitoring, runs)
  "data:manage",  // mutate data pipelines: retry/cancel/pause imports, requeue rejects, rerun enrichment
  "data:review",  // clerical review: confirm/reject/split merges, approve maker/checker items
  "data:export",  // request a cross-tenant data export (PII-bearing; approval + suppression gated)
]);
```

Bundle them into roles (`ROLE_CAPABILITIES`), respecting least-privilege:

```ts
const ROLE_CAPABILITIES = {
  support:            [/*…*/, "data:read"],                       // observe only
  billing_ops:        [/*…*/ ],                                   // none — data ops are not billing
  compliance_officer: [/*…*/, "data:read", "data:review", "data:export"], // review + DSAR-grade export
  read_only:          ["data:read"],                             // observe only
};
// super_admin implies ALL (incl. all four) — handled by capabilitiesForRole().
```

> **`data:manage` is super_admin-only by default** (no role bundle holds it) — mutating another
> tenant's pipeline is a high-privilege act; grant it explicitly via `staff:manage` or gate behind
> JIT elevation (§8). **Security has final say** here.

Render-gating uses the existing `useStaffMe()` provider (`lib/staffMe.tsx` — `StaffMeProvider`
fetches `GET /admin/me` → `{staffRole, capabilities}`):

```tsx
const { has, canMaybe } = useStaffMe();
// strict: hide the destructive button unless the cap is certainly present
{has("data:manage") && <TpButton tone="danger" onClick={openCancelDialog}>Cancel job</TpButton>}
// optimistic: render a nav link if the cap is plausibly present (api re-checks)
{canMaybe("data:read") && <NavLink dest={overview} />}
```

The `requires` field on `NavDestination` (§5.2) is consumed by `Sidebar.tsx`: a child renders only
if `canMaybe(child.requires)`. **This is defence-in-depth UI hiding — the api is authoritative.**
Every `/admin/data/*` endpoint carries its own `requireCapability(...)` gate, so hiding a button
never *grants* anything.

### 5.6 Surface 2 — extend `apps/web/features/data-health`

The customer surface already exists and ships a live data-health dashboard
(`apps/web/src/features/data-health/` — `DataHealthPage.tsx`, `MetricsSection`, `PerFieldFill`,
`FreshnessTrend`, `VerificationBreakdown`, `RetentionActivity`, `ReverificationActivity`,
`ReverifyNowButton`). We **extend it into a workspace-scoped control panel** by adding tabs/sections,
*not* a new app:

- **Import** — reuse the existing `apps/web` `ImportWizard` (own-data CSV upload + mapping +
  validation preview); posts to `POST /api/v1/imports` (multipart). RLS via `withTenantTx`.
- **Data health** — already live (the current `DataHealthPage`).
- **Dedup review** — own-workspace merge suggestions (`match_links` scoped to the caller's
  workspace; RLS makes this safe automatically).
- **Enrichment usage** — own spend/hit-rate via `GET /api/v1/enrichment/jobs`.
- **Export** — own-data export (`POST /api/v1/contacts/bulk/export`), suppression-checked.
- **Retention / DSAR requests** — own retention runs + DSAR via `/api/v1/compliance/dsar`.

**Gate:** `requireOrgRole` (the org-level RBAC), **never** staff RBAC — a customer is not platform
staff. **Scope:** always `withTenantTx(scope, fn)` so RLS forces `workspace_id = current GUC`; the
workspace id comes from the **verified token** (`c.get("workspaceId")`), never the request body. No
`platform_audit_log` row — it's the tenant's own data; the tenant-side `audit_log`
(`packages/core/src/compliance/writeAudit.ts`) records it where appropriate.

The Surface-2 design detail is owned by the sibling docs ([05](./05-Upload-Pipeline-Design.md) import
wizard, [08](./08-Data-Enrichment-Workflow.md) usage, [12](./12-Security-and-Compliance.md) DSAR);
this doc fixes only that it is an **extension of `features/data-health`**, org-gated, RLS-scoped.

---

## 6. Implementation Steps (sequenced)

**Phase 0 (Observe & Enable) — the panel skeleton:**

1. **Types:** add `data:read` (only) to `staffCapability` enum; bundle into `support`, `read_only`,
   `compliance_officer`. Add `data:manage`/`data:review`/`data:export` enum values now (so the closed
   enum is stable) but leave them unbundled (super_admin-only) until their phases.
2. **Backend seam:** create `apps/api/src/features/admin/data/routes.ts` exporting
   `adminDataRoutes`; mount it in `routes.ts` (`adminRoutes.route("/data", adminDataRoutes)`). Parent
   `authn` + `platformAdmin` already apply.
3. **First endpoint:** `GET /admin/data/overview` — a single `withPlatformTx` read aggregating
   `data_quality_snapshots` + job/run tallies. Action string `admin.data_overview` (a READ — plain
   `withPlatformTx` string, **not** in the `platformAuditAction` mutation enum, matching
   `admin.list_import_jobs`).
4. **Repository:** add `platformDataRepository.fleetOverview(tx)` to `@leadwolf/db` — bounded
   (`PLATFORM_READ_LIMIT`), aggregates only, **never selects `contacts`/`import_job_rows` contents**.
5. **Nav:** extend `NavDestination` with `requires`; add `DATA_MANAGEMENT_GROUP`; render it as a
   labelled section in `Sidebar.tsx` (children filtered by `canMaybe(requires)`); extend
   `sectionTitleFor` to search group children.
6. **Route + feature folder:** `(shell)/data/page.tsx` → `features/data-ops` (the §5.4 file tree).
7. **Import drill-down (read-only):** `GET /admin/data/imports/:jobId` (chunks), `…/rows`,
   `…/rejects`; `features/data-imports` + `(shell)/data/imports/[jobId]/page.tsx`. Metadata + rejects
   only; never contact PII for non-`data:review` tiers.
8. **Enable-and-harden dark bulk import** (engine in [05](./05-Upload-Pipeline-Design.md)): the panel
   provides the *observe* surface; flipping `bulk_import_enabled` per-tenant is a feature-flag write
   (existing `/admin/feature-flags/:key/tenant`).

**Phase 1 (Validate, Dedup-Review, Enrich):** bundle `data:manage`/`data:review`; add Validation,
Dedup & Linking, Enrichment console folders + their `/admin/data/*` routers.

**Phase 2 (Approve, Export, Self-Serve):** maker/checker (`/admin/data/approvals`); audited Export
(`data:export`); extend `apps/web/features/data-health` into the self-service panel.

**Phase 3+ (Govern & Scale):** retention enforce rollout via the panel; version-history/rollback;
SLOs/lineage in Monitoring.

---

## 7. UI/UX Requirements

### 7.1 Data-Ops Overview — the key screen

Built from `@leadwolf/ui`: **`StatTile`** row (fleet KPIs), then **`Card`**-wrapped **`DataTable`**
panels for live signals, all under one **`StateSwitch`** managing the four states. `Tabs` are *not*
needed on the overview (it's a single rollup); drill-downs (Imports detail) use `Tabs`.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Data management ▸ Data-Ops Overview                         [↻ Reload]        │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐             │
│  │ Imports  │ │ Queue    │ │ DLQ /    │ │ Pending  │ │ Fleet    │   StatTile  │
│  │ running  │ │ depth    │ │ failed   │ │ merges   │ │ quality  │   × 5       │
│  │   12     │ │  1,840   │ │   3 ⚠    │ │   57     │ │  72.4 ▲  │             │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘             │
│                                                                                │
│  ┌─ Service health ────────────────────────────────────────────────────────┐ │
│  │ api ● up   database ● up   workers ● up   redis ● up   search ◌ unknown  │ │ StatusBadge
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  ┌─ Active imports (cross-tenant)  ──────────────────── DataTable ──────────┐ │
│  │ Tenant        Job          Status      Rows ok / rej   AV     Started     │ │
│  │ Acme Corp     imp_8f2…  ◗ running       4,210 / 12     clean  2m ago  →   │ │
│  │ Globex        imp_7a1…  ⏸ paused        1,002 / 0      clean  9m ago  →   │ │
│  │ Initech       imp_55c…  ✖ failed            0 / 0      —      14m ago  →  │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│  ┌─ Retention runs (shadow)  ───────────────────────── DataTable ───────────┐ │
│  │ Tenant     Class                Mode    Would-delete   Deleted   Ran      │ │
│  │ Acme       contact_unverified   shadow      1,204          0     1h ago   │ │
│  │ Globex     activity_stale       shadow        330          0     1h ago   │ │
│  └──────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Components used:** `StatTile` (×5 KPIs), `Card` (panel wrappers), `DataTable` + `Column<T>`
(`sortValue`, `rowKey`) for the two tables, `StatusBadge` + `StatusTone` (service + job status),
`Icon`, `TpButton` (reload), `StateSwitch` (the four-state wrapper), `Tooltip` (DLQ warning detail),
`Pagination` (if a table exceeds the bounded page). The row `→` opens `(shell)/data/imports/[jobId]`.

### 7.2 The four states (`StateSwitch` contract)

- **Loading:** `StateSwitch` renders `LoadingState` / `Skeleton` rows for the StatTile row and table
  bodies (skeleton shimmer, not a spinner-only blank).
- **Empty:** `EmptyState` — "No active data operations. The fleet is idle." with a muted illustration
  and a *Reload* affordance. Distinct empties per panel (no active imports ≠ no retention runs).
- **Error:** `ErrorState` showing the `problemMessage` text from `api.ts` + a *Retry* button calling
  `reload()`. A 403 (caller lacks `data:read`) renders a *"You don't have access to Data Ops"* empty,
  not a scary error.
- **Data:** the wireframe above.

```tsx
// components/DataOpsOverviewPage.tsx (sketch)
const { data, loading, error, reload } = useDataOpsOverview();
return (
  <StateSwitch
    loading={loading} error={error} empty={data?.activeImports.length === 0 && /*…*/}
    onRetry={reload}
    skeleton={<OverviewSkeleton />}
    emptyState={<EmptyState title="The fleet is idle" action={{ label: "Reload", onClick: reload }} />}
  >
    <StatTileRow kpis={data!.kpis} />
    <ServiceHealthCard services={data!.services} />
    <Card title="Active imports"><DataTable columns={importCols} rows={data!.activeImports} rowKey={(r) => r.jobId} /></Card>
    <Card title="Retention runs (shadow)"><DataTable columns={runCols} rows={data!.retentionRuns} rowKey={(r) => r.runId} /></Card>
  </StateSwitch>
);
```

Accessibility (WCAG 2.2 AA per [truepoint-design]): tables get caption/`scope` headers; status is
never colour-only (`StatusBadge` pairs an icon+label with the tone); the reload control is keyboard
reachable; live counts use `aria-live="polite"` on refresh.

---

## 8. Database & Backend Changes

### 8.1 No new tables for the panel container (Phase 0)

The Overview is a **read aggregator** — it reuses existing tables, no DDL:

- `import_jobs` / `import_job_chunks` / `import_job_rows` (`schema/importJobs.ts`, migration 0032) —
  job state machine + tallies + rejects.
- `retention_runs` (`schema/retention.ts`, migration 0033) — shadow would-delete/deleted counts.
- `data_quality_snapshots` (`schema/dataQualitySnapshots.ts`, migration 0031) — daily per-ws jsonb
  rollup; the fleet KPI averages across tenants.
- `enrichment_jobs` (`schema/enrichmentJobs.ts`) — run/cost signals for the Enrichment area.
- BullMQ live probe via `probeQueues()` (already in `system-health`).

### 8.2 New tables arrive with later phases (not here)

- **Phase 2 — maker/checker** ([09](./09-Review-and-Approval-System.md)) owns the approval store. The
  panel does **not** define its own approval table: the canonical table is `approval_request`
  (`schema/approvalRequest.ts`), introduced by the next sequential migration (0035+) in
  [09](./09-Review-and-Approval-System.md). The panel only *references* it — a high-risk action
  (export, retention enforce, bulk merge) creates an `approval_request` row (operation e.g.
  `bulk_export`) and the approve/reject endpoints drive its `status`. Platform-managed (no `tenant_id`
  RLS scoping); written ONLY via `withPlatformTx` (owner conn); the app role (`leadwolf_app`) gets NO
  grant — deny-all under FORCE RLS. The server-side `maker != checker` rule lives in 09.

- **Phase 2 — export jobs:** a `data_export_jobs` table (request → approval → bounded download
  window per [02 §2](./02-Enterprise-Research.md#42-bulk-uploads)) — designed in
  [12](./12-Security-and-Compliance.md). Same posture: platform-managed, owner-only writes, audited.

### 8.3 RLS posture & tx wrapper — the non-negotiable

**Every `/admin/data/*` handler runs on `withPlatformTx(actor, action, fn, {targetType, targetId,
tenantId, metadata})`** (`packages/db/src/client.ts:121`):

- **Owner connection, `BYPASSRLS`** — necessary because the operator reads *across* tenants; the
  overlay tables (`contacts`, `import_job_rows`, …) are RLS-forced and `withTenantTx` would scope to a
  single workspace.
- **Writes a `platform_audit_log` row in the SAME transaction** — if the operation rolls back, so
  does the audit row; if a write throws (unknown id), no trace is left for an action that didn't
  happen (the `feature_flag`-404 discipline in `routes.ts`).
- **Only behind a verified `pa===true` claim** (the `platformAdmin` middleware) + a per-endpoint
  `requireCapability("data:*")` (or `requireStaffRole` for read-only tiers).

Reads use a **plain action string** (`admin.data_overview`, `admin.list_data_rejects`) — like
`admin.list_import_jobs`/`admin.list_tenants`, deliberately **not** in the `platformAuditAction`
mutation enum. Writes use enum-tracked actions (`data.import.retry`, `data.merge.confirm`,
`data.export.request`, etc.) added to the `platformAuditAction` vocabulary.

**The `ownerClient` raw bypass** (`client.ts:27`) is **never** used by the panel — it exists only for
the bulk-import UNLOGGED staging COPY (Postgres forbids COPY on RLS tables). Panel code uses
`withPlatformTx` exclusively.

**High-risk writes layer JIT elevation** (`jit_elevations`, consumed in-tx — the
`tenant.suspend`/`credit.adjust` pattern in `routes.ts:226`): `data:manage` cancel/purge and
`data:export` consume a live elevation for the target action before the write; without one → `403
elevation_required`. Phase 2 adds maker/checker on top for the highest-risk class.

### 8.4 Backend mount

```ts
// apps/api/src/features/admin/routes.ts — add near the other sub-router mounts
import { adminDataRoutes } from "./data/routes.ts";
// …
// Data-management ops console (doc 04) — cross-tenant data ops; data:* capabilities; all writes audited.
adminRoutes.route("/data", adminDataRoutes);
```

```ts
// apps/api/src/features/admin/data/routes.ts (skeleton)
export const adminDataRoutes = new Hono<{ Variables: ApiVariables }>();
// parent adminRoutes already applies authn + platformAdmin to "*"; we add per-route capability gates.

adminDataRoutes.get("/overview", requireCapability("data:read"), async (c) => {
  const overview = await withPlatformTx(actorOf(c), "admin.data_overview", (tx) =>
    platformDataRepository.fleetOverview(tx),
  );
  return c.json(overview); // aggregates only — never contact PII
});
```

---

## 9. API Requirements

All under `/api/v1/admin/data`, all behind **`authn` → `platformAdmin`** (inherited) **+ a
per-route `requireCapability`**. RFC 9457 problem envelope (`middleware/error.ts`). Keyset pagination
(`packages/types/src/search.ts`: `cursor?`, `limit` 1..200 default 50 → `nextCursor`). Money/PII
mutations carry **`Idempotency-Key`** (`middleware/idempotency.ts`). Scope is always from the verified
token / explicit path param — never the body.

### Phase 0

```
GET  /api/v1/admin/data/overview
     gate: requireCapability("data:read")  · audited READ "admin.data_overview"
     req:  —
     res:  { kpis: { importsRunning, queueDepth, deadLetter, pendingMerges, fleetQuality },
             services: ServiceStatus[], activeImports: ImportRunRow[], retentionRuns: RetentionRunRow[] }
     errs: 401 (no token) · 403 forbidden (no data:read)

GET  /api/v1/admin/data/imports/:jobId
     gate: requireCapability("data:read")  · audited READ "admin.data_import_detail"
     res:  { job: ImportJobRow, chunks: ImportChunkRow[] }   // metadata + tallies, NO row PII
     errs: 422 (bad UUID) · 404 (NotFoundError) · 403

GET  /api/v1/admin/data/imports/:jobId/rows?status=&cursor=&limit=
     gate: requireCapability("data:review")  // row-level can expose values → higher cap
     res:  { rows: ImportRowView[], nextCursor: string|null }
     errs: 422 · 404 · 403

GET  /api/v1/admin/data/imports/:jobId/rejects?cursor=&limit=
     gate: requireCapability("data:read")  // reject = error code + field, not full PII
     res:  { rejects: RejectRow[], nextCursor: string|null }
```

### Phase 1

```
POST /api/v1/admin/data/imports/:jobId/chunks/:chunkId/retry  gate data:manage · Idempotency-Key
     body: { reason: string (min 8) }              · audited WRITE "data.import.retry"  (chunk-level retry)
     res:  { ok: true, jobId, chunkId, status }    · 422 · 404 · 409 (not retryable) · 403
POST /api/v1/admin/data/imports/:jobId/cancel      gate data:manage · JIT-elevated · audited "data.import.cancel"
POST /api/v1/admin/data/imports/:jobId/pause|resume gate data:manage · audited "data.import.pause|resume"

GET  /api/v1/admin/data/dedup/review?cursor=&limit= gate data:review · audited READ "admin.list_merge_queue"
     res:  { clusters: MergeCandidate[], nextCursor }   // match_links.review_status='pending'
POST /api/v1/admin/data/dedup/confirm   gate data:review · Idempotency-Key · audited "data.merge.confirm"  (ids in body)
POST /api/v1/admin/data/dedup/reject     gate data:review · audited "data.merge.reject"  (ids in body)
POST /api/v1/admin/data/dedup/split      gate data:review · audited "data.merge.split"  (ids in body; non-destructive re-derive)

GET  /api/v1/admin/data/enrichment/runs?cursor=&limit=   gate data:read · READ "admin.list_enrichment_runs"
POST /api/v1/admin/data/enrichment/runs/:jobId/rerun-failed  gate data:manage · Idempotency-Key · "data.enrichment.rerun"
POST /api/v1/admin/data/enrichment/test-batch             gate data:manage · "data.enrichment.test_batch" (25-50 rows, pre-flight cost)

GET  /api/v1/admin/data/validation/rejects?cursor=&limit= gate data:read · READ "admin.list_validation_rejects"
POST /api/v1/admin/data/validation/rejects/:id/requeue    gate data:manage · "data.validation.requeue"
```

### Phase 2

```
GET  /api/v1/admin/data/approvals?status=&cursor=&limit=  gate data:review · READ "admin.list_approvals"
POST /api/v1/admin/data/approvals/:id/approve             gate data:review · checker≠maker enforced · "data.approval.approve"
POST /api/v1/admin/data/approvals/:id/reject              gate data:review · "data.approval.reject"

POST /api/v1/admin/data/export                            gate data:export · Idempotency-Key · "data.export.request"
     body: { scope: ExportScope, format: "csv"|"jsonl", reason: string }
     -> creates an approval (maker/checker) + pre-computes worst-case row count; suppression-checked
     res:  { exportId, status: "pending_approval" }       · 402 (InsufficientCredits if metered) · 429 (budget) · 403
GET  /api/v1/admin/data/export/:id                        gate data:export · READ "admin.get_export"
GET  /api/v1/admin/data/export/:id/download               gate data:export · bounded window · "data.export.download"
```

**Error codes** reuse the typed catalog (`packages/types/src/errors.ts`): `ValidationError` 422,
`NotFoundError` 404, `ForbiddenError` 403, `InsufficientCreditsError` 402, `SuppressedError`,
`ProviderBudgetExceededError` 429, plus `ElevationRequiredError` 403 (`elevation_required` code) for
JIT-gated writes. Every `code` is a stable machine id.

---

## 10. Edge Cases & Failure Scenarios

1. **Caller has `pa` but no `data:read`.** `platformAdmin` passes; `requireCapability("data:read")`
   → 403 `forbidden`. The nav group still hides via `canMaybe` (so they never see the link), but the
   route is independently safe. `/admin/me` returns no `data:*` cap → Sidebar filters the whole group.
2. **`pa` holder with no active `platform_staff` row.** `/admin/me` returns `staffRole: null`,
   `capabilities: []` (per `routes.ts:78`). The group renders empty (no children pass `requires`). The
   api would 403 anyway — `requireStaffRole` resolves the *active* role per-request (immediate
   revocation, no stale-JWT window).
3. **Overview read hits a tenant whose snapshot is missing.** `data_quality_snapshots` is daily; a
   brand-new tenant has none. `fleetOverview` LEFT-JOINs and treats missing as "no data" (not 0 —
   distinguish "no snapshot yet" from "quality 0"), so the fleet KPI excludes it from the average.
4. **Bounded read truncation.** Cross-tenant lists are capped at `PLATFORM_READ_LIMIT`. The Overview
   response includes `truncated: true` when the cap is hit (the `system-health` `jobs.truncated`
   pattern) and the UI shows a "showing first N" banner — never a silent partial.
5. **Import drill-down on a deleted/DSAR-tombstoned job.** Rows reference `contacts.deleted_at`
   tombstones; `…/rows` filters them and the reject view shows `<redacted: deleted>` rather than PII.
   A `data:review` operator cannot resurrect DSAR-deleted data through the console.
6. **Concurrent operator actions.** Two operators cancel the same import. The first write moves
   `import_jobs.status`→`cancelled`; the second's repo update touches 0 rows → `409`/`NotFoundError`
   inside the tx → audit row rolls back. No double-cancel, no orphan audit entry.
7. **A write capability granted but JIT elevation absent.** `data:manage` cancel without a live
   `jit_elevations` row → `ElevationRequiredError` 403 `elevation_required`; the consumed-elevation
   pattern means a failed attempt rolls back so the operator can retry after elevating.
8. **Export request exceeds budget / hits suppression.** `POST /export` pre-computes worst-case
   spend ([02 §16](./02-Enterprise-Research.md#416-approval-workflows)); over budget → 429
   `provider_budget_exceeded`; any suppressed contact in scope → `SuppressedError` (the export is
   blocked, not silently filtered, unless the request explicitly opts into suppression-filtering).
9. **Token expiry mid-session.** `fetchWithAuth` (in-memory access token) → 401 → the slice surfaces
   `ErrorState`; PKCE refresh re-mints; `reload()` recovers. No infinite spinner.
10. **Search service `unknown`.** The Overview service-health row shows `search ◌ unknown` (no api
    client to probe — never fabricate a green check), matching `system-health` exactly.
11. **Self-service (Surface 2) cross-workspace leak attempt.** A customer crafts a body with another
    workspace's id. Ignored — scope comes from `c.get("workspaceId")`; `withTenantTx` sets the GUC
    from the token and RLS `WITH CHECK workspace_id = current_setting(...)` fails-closed (NULLIF empty
    → no rows). The body id is never trusted.

---

## 11. Testing Strategy

**Unit (Bun test):**
- `staffCapability`: `capabilitiesForRole`/`roleHasCapability` include the new `data:*` for the
  bundled roles; `super_admin` implies all four; `read_only` has `data:read` only and *not*
  `data:manage`.
- `navConfig`: `sectionTitleFor` resolves group-child paths (`/data/imports` → "Imports & Uploads");
  `isActive` highlights the parent group for nested routes.
- `api.ts` slices: `problemMessage` reads `detail` then `title` then status fallback; hook
  transitions `loading→data` / `loading→error` and `reload()` re-enters loading.

**Integration (api, in-process Hono):**
- `GET /admin/data/overview` with a `data:read` token → 200 aggregate shape; with a token lacking it
  → 403; with no token → 401.
- Each write endpoint: capability gate (403 without cap), UUID validation (422 before tx, **no audit
  row written**), idempotency replay (same `Idempotency-Key` returns the first response), and the
  `platform_audit_log` row is present **and rolls back** when the inner write throws.
- JIT-gated writes return `elevation_required` 403 without a live elevation; succeed with one.

**itest (DB-backed) — the MANDATORY tenant-isolation test (CLAUDE.md non-negotiable):**
Wherever the panel **writes** cross-tenant, prove isolation:
- A `data.import.cancel` on tenant A's job must touch **only** tenant A's `import_jobs` row; assert
  tenant B's identically-named job is untouched.
- A `data.merge.confirm` writes `match_links` for the target cluster only.
- A Surface-2 (`withTenantTx`) write under workspace W cannot read/write workspace W2's rows: seed
  two workspaces, run the handler with W's token, assert RLS yields zero W2 rows even with a forged
  body id. This is the **fail-closed RLS** proof.
- Every cross-tenant write produces exactly one `platform_audit_log` row with the right
  `action`/`targetTenantId`/`actor`; a rolled-back write produces **zero**.

**Frontend (component):** `DataOpsOverviewPage` renders all four `StateSwitch` states from a mocked
hook; `useStaffMe` gating hides `data:manage` actions for a `read_only` caller; the 403 path renders
the access-empty, not the error state.

---

## 12. Rollout & Migration Plan

**Flag/capability gating:**
- The whole group sits behind a **feature flag** `data_console_enabled` (seeded
  `default=false`, `feature_flags` migration-0034 mechanism) so the nav group and routes are dark
  until enabled per the staff cohort. The api routes also exist but return 404/forbidden until the
  flag + capability align — defence in depth.
- `data:read` ships in Phase 0 bundled to `support`/`read_only`/`compliance_officer`;
  `data:manage`/`data:review`/`data:export` ship in the enum but **unbundled** (super_admin-only)
  until Phases 1-2 grant them deliberately via `staff:manage`.

**Shadow → canary → GA:**
- **Shadow:** mount `adminDataRoutes` + `GET /overview` behind the flag for super_admin only; verify
  reads, audit rows, bounded truncation. No writes.
- **Canary:** enable for the internal ops cohort; turn on import drill-down (read-only) + the
  observe surface for the dark bulk-import; flip `bulk_import_enabled` for **one** pilot tenant and
  watch it in the console (this is exactly the COPY-spike validation gate — see
  [05-Upload-Pipeline-Design](./05-Upload-Pipeline-Design.md)).
- **GA:** enable `data_console_enabled` globally for staff; bundle Phase-1 capabilities; enable
  writes behind JIT elevation.

**Nav de-duplication migration:** the existing flat `Bulk imports` (`/imports`) and `Retention`
(`/retention`) destinations are **kept** through Phase 0/1 (no breaking change). Once the group's
*Imports & Uploads* and *Retention & Governance* areas reach feature parity (drill-down + enforce),
remove the flat entries in a single follow-up change and add redirects `/imports → /data/imports`,
`/retention → /data/retention`. No data migration — this is pure routing.

**Backfill:** none required. The Overview aggregates existing tables. The only new schema
(`approval_request`, `data_export_jobs`) arrives empty in Phase 2 migrations (the next sequential
migrations, 0035+) with no backfill.

---

## 13. Success Metrics & Acceptance Criteria

**Metrics:**
- **Mean-time-to-diagnose** a stuck import drops (operator reaches root cause from one screen, not
  four) — [02 §21](./02-Enterprise-Research.md#421-operational-tooling).
- **100% of cross-tenant data writes** produce a matching `platform_audit_log` row (audit coverage,
  measured by reconciling write endpoints against audit actions).
- **Zero RLS-isolation test failures** in CI for every panel write.
- Dark bulk import observably canaried for ≥1 tenant before GA.

**Acceptance criteria (testable checklist):**

- [ ] `navConfig.ts` exports `DATA_MANAGEMENT_GROUP` with the 9 children; `Sidebar.tsx` renders it as
      a labelled section; children filter by `canMaybe(requires)`.
- [ ] `(shell)/data/page.tsx` mounts `DataOpsOverviewPage` via the thin-wrapper pattern (mirrors
      `imports/page.tsx`).
- [ ] `staffCapability` enum contains exactly `data:read`, `data:manage`, `data:review`,
      `data:export`; `capabilitiesForRole(read_only)` returns `["data:read"]`; `super_admin` implies
      all four; `data:manage` is in **no** non-super role bundle.
- [ ] `features/data-ops` follows the file tree `index.ts`/`api.ts`/`types.ts`/`hooks/use*.ts`/
      `components/DataOpsOverviewPage.tsx`; `api.ts` is the only network seam; the hook returns
      `{data, loading, error, reload}` with **no** TanStack import.
- [ ] `GET /api/v1/admin/data/overview` returns 200 with `data:read`, 403 without, 401 with no token.
- [ ] `adminDataRoutes` is mounted at `/data` in `routes.ts`; every handler runs on `withPlatformTx`;
      every write writes a `platform_audit_log` row in the same tx and rolls it back on failure.
- [ ] Reads use plain action strings; writes use enum-tracked `platformAuditAction` values.
- [ ] `DataOpsOverviewPage` renders loading/empty/error/data via `StateSwitch`; the 403 path renders
      an access-empty, not an error.
- [ ] The mandatory tenant-isolation itest passes for at least one cross-tenant write **and** for the
      Surface-2 `withTenantTx` workspace-isolation case (forged body id yields zero foreign rows).
- [ ] Surface 2 extends `apps/web/features/data-health`, gated by `requireOrgRole`, scoped by
      `withTenantTx`; no `platform_audit_log` writes from the customer path.
- [ ] The group is dark behind `data_console_enabled` until the canary completes.

---

### Cross-references

- [01-Current-State-Analysis](./01-Current-State-Analysis.md) — subsystem status matrix (§10).
- [02-Enterprise-Research](./02-Enterprise-Research.md) — §1, §11, §15, §16, §20, §21 (cited above).
- [03-Gap-Analysis](./03-Gap-Analysis.md) — the gap register + canonical tiering.
- [05-Upload-Pipeline-Design](./05-Upload-Pipeline-Design.md) — the Imports & Uploads engine this
  panel observes/controls.
- [06-Data-Validation-Framework](./06-Data-Validation-Framework.md) — the Validation sub-area logic.
- [07-Deduplication-and-Linking](./07-Deduplication-and-Linking.md) — the Dedup & Linking review queue.
- [08-Data-Enrichment-Workflow](./08-Data-Enrichment-Workflow.md) — the Enrichment console logic.
- [09-Review-and-Approval-System](./09-Review-and-Approval-System.md) — maker/checker + `approval_request`.
- [10-Monitoring-and-Observability](./10-Monitoring-and-Observability.md) — the Monitoring sub-area.
- [11-Roles-and-Permissions](./11-Roles-and-Permissions.md) — the `data:*` capability model in full.
- [12-Security-and-Compliance](./12-Security-and-Compliance.md) — export safety, DSAR, residency.
- [13-Performance-and-Scaling](./13-Performance-and-Scaling.md) — bounded reads, blocking, scale.
- [14-Implementation-Roadmap](./14-Implementation-Roadmap.md) — phase sequencing.
- [15-Future-Enhancements](./15-Future-Enhancements.md) — automation/rules engine, CRM sync console.
