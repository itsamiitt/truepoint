# 11 — Roles & Permissions

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored ·
> **Prev:** [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) ·
> **Next:** [`12-Security-and-Compliance`](./12-Security-and-Compliance.md)

---

## 1. Objective

Define the **complete access model** for the Database-Management panel across **both** of TruePoint's
RBAC systems, and specify the missing `data:*` capability set that every screen in
[`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) through
[`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) is gated by.

Concretely this document:

1. Extends the **closed staff-capability enum** (`packages/types/src/staffCapability.ts:13`) with four new
   capabilities — `data:read`, `data:manage`, `data:review`, `data:export` — and re-bundles them into
   `ROLE_CAPABILITIES` (`staffCapability.ts:37`). This is a **Zod-enum + bundle-map change only** — no DB
   migration, because the enum is code and the *assignment* lives in the `platform_staff` table.
2. Specifies the **per-endpoint `requireCapability(...)` gates** for the new `/api/v1/admin/data/*` routers,
   and which high-risk actions additionally require **JIT elevation** and **maker/checker**
   ([`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md)).
3. Defines the **customer-side** access model for Surface 2 (`apps/web`) — `org_role` + `requireOrgRole`,
   `owner_user_id` owner-scope, and **RLS as the tenant wall** — and draws the hard boundary between the two
   surfaces.
4. Presents the authoritative **capability → panel-action matrix** (the single source of truth the API gates,
   the console hides UI against, and the tests assert).
5. Establishes **separation of duties** (maker ≠ checker), **least privilege** (`read_only`, the default), and
   the **per-API-key credit-cap analog** for metered actions
   ([`02` dim 15](./02-Enterprise-Research.md#415-rbac)).

> **Precedence note.** [`12-Security-and-Compliance`](./12-Security-and-Compliance.md) is **authoritative on
> whether any gate defined here is sufficient.** This document proposes the gates; Security ratifies them. A
> multi-tenant write reachable without an RLS-enforced (or, for cross-tenant, `withPlatformTx`-audited),
> ownership-checked, capability-gated path is a **bug**, not a configuration choice.

---

## 2. Current Challenges

| # | Challenge | Evidence |
|---|---|---|
| C1 | **No `data:*` capability exists.** The staff enum has 16 capabilities; none describe data-platform operations. Every Data-Management screen would otherwise be ungated or mis-gated onto an unrelated capability (e.g. `compliance:manage`). | `staffCapability.ts:13`-`30`; [`01` §5.12](./01-Current-State-Analysis.md#512-access-control--two-distinct-rbac-models) |
| C2 | **Existing data-ops screens borrow neighbour capabilities.** `features/retention` gates on `super_admin` + `compliance:manage`; `features/provider-configs` on `providers:manage`; `features/compliance` on `compliance:read`/`compliance:manage`. There is no coherent "data operator" bundle, so a person who should triage import rejects must be handed `compliance_officer` or `super_admin` — **over-grant by necessity.** | Prompt §"Existing admin data-ops screens"; `staffCapability.ts:37` |
| C3 | **`super_admin` overuse.** Because `super_admin` implies *all* capabilities (`capabilitiesForRole`, `staffCapability.ts:51`), every gap in the bundle map pressures operators toward `super_admin` — the broadest possible grant — which then has unaudited reach across every tenant. | `staffCapability.ts:51`-`52` |
| C4 | **No maker/checker primitive in the RBAC layer.** `requireCapability` is a single-actor gate; it cannot express "the approver must be a *different* staff member than the requester." High-risk data ops (bulk export of PII, retention `enforce` graduation, merge of golden entities) need two-person control. | `requireCapability.ts:15`; [`09`](./09-Review-and-Approval-System.md) |
| C5 | **Surface 2 has no data-management authorization story.** `apps/web` customer self-service must gate on `org_role`/`requireOrgRole` + `owner_user_id`, never on staff RBAC — but that mapping has never been written down, risking a staff-capability leak into the customer app. | `requireOrgRole.ts:14`; `auth.ts:23` (`orgRole`) |
| C6 | **No credit-cap / preview-vs-redeem privilege split.** Metered actions (enrichment re-run, verification) have no per-actor spend ceiling and no separation between *preview* (no spend, no PII) and *redeem* (charges + reveals). [`02` dim 15/16](./02-Enterprise-Research.md#416-approval-workflows) treats this as an auth surface, not a UX nicety. | [`02` dim 15](./02-Enterprise-Research.md#415-rbac) |

---

## 3. Enterprise Best Practices (cited)

Synthesized from [`02-Enterprise-Research`](./02-Enterprise-Research.md). Each maps to a concrete decision below.

- **[Dim 15 — RBAC for data APIs](./02-Enterprise-Research.md#415-rbac):** per-API-key
  **credit caps + rate windows**; a **preview-vs-redeem privilege split** treated as an *auth surface* (not
  cosmetic); least-privilege scoping. → TruePoint analog: a **capability** is the privilege, the **per-tenant
  flag + budget** is the credit cap, and `preview`/`commit` become two distinct capability checks
  (`data:read` previews, `data:manage`/`data:export` commit).
- **[Dim 16 — Approval workflows](./02-Enterprise-Research.md#416-approval-workflows):**
  **preview-then-commit** gate (Cognism Enrich preview = no spend/no PII → Redeem = reveals + charges);
  **pre-compute worst-case spend** before a bulk run. → The approval object in
  [`09`](./09-Review-and-Approval-System.md) carries the pre-computed cost; the *checker* approves the spend.
- **[Dim 9 — Manual review queues](./02-Enterprise-Research.md#49-manual-review-queues):** steward
  review with **two thresholds**, bias to false-negatives. → `data:review` is its own capability so a steward
  can confirm/reject merges **without** the broader `data:manage` write grant.
- **[Dim 11 — Audit / provenance](./02-Enterprise-Research.md#411-audit-logs):** attach
  source/workflow provenance to **every** privileged action; **log match decisions.** → every cross-tenant
  write goes through `withPlatformTx`, which writes a `platform_audit_log` row **in the same transaction**.
- **[Dim 21 — Operational tooling](./02-Enterprise-Research.md#421-operational-tooling):** build
  tools *over* the decision logs; a **clerical-review console.** → the matrix below routes the review console
  to `data:review` and the audit views to `audit:read`.
- **Least privilege & immediate revocation (industry baseline):** the active role is resolved
  **per-request** from the system of record, never trusted from a stale JWT — so a revoked grant takes effect
  on the **next call**, with no token-expiry window. TruePoint already implements this in
  `requireStaffRole.ts:18` / `requireCapability.ts:18` (`platformStaffRepository.getActiveRole`).

---

## 4. Gaps in Current Implementation

Tie-out to [`01-Current-State-Analysis`](./01-Current-State-Analysis.md) and
[`03-Gap-Analysis`](./03-Gap-Analysis.md).

| Gap | Status | Current State | Target |
|---|---|---|---|
| `data:*` capabilities | **Missing** | enum has 16, none data | add 4: `data:read`/`data:manage`/`data:review`/`data:export` (`staffCapability.ts:13`) |
| Data-operator role bundle | **Missing** | no bundle grants data caps; only `super_admin` (implies all) | add the four caps into the `compliance_officer` / `support` bundles per the matrix, and reserve `data:export` to `super_admin` + a JIT-elevated checker |
| Maker ≠ checker | **Missing** | `requireCapability` is single-actor | approval object in [`09`](./09-Review-and-Approval-System.md); RBAC asserts requester ≠ approver |
| Surface 2 data gates | **Missing/Planned** | `requireOrgRole` exists but no data routes use it | map customer data ops onto `org_role` + `owner_user_id` (§5.4) |
| Credit-cap / preview-redeem split | **Partial** | per-provider monthly budget exists (`provider-configs`); no per-actor cap, no preview/redeem capability split | §5.5 |
| Immediate revocation | **Shipped** | `getActiveRole` per request | reuse as-is; assert in tests (§11) |
| Console UI gating | **Shipped (pattern)** | `useStaffMe().has(cap)` / `canMaybe(cap)` | extend `staffMeSchema` consumers to the new caps (no schema change — it already returns `capabilities[]`, `staffCapability.ts:61`) |

---

## 5. Recommended Solution

### 5.1 The four new staff capabilities

Append to the **closed** Zod enum at `packages/types/src/staffCapability.ts:13`. Order/comments mirror the
existing style:

```ts
export const staffCapability = z.enum([
  // ... existing 16 ...
  "data:read",    // read cross-tenant data-ops surfaces (overview, import/enrichment runs, quality rollups) — READ ONLY
  "data:manage",  // operate pipelines: retry/cancel/pause imports, re-run enrichment, configure validation rules
  "data:review",  // clerical review: confirm/reject ER merges & split clusters on match_links.review_status
  "data:export",  // initiate an audited cross-tenant data export (high-risk; maker side of maker/checker)
]);
```

This is a **code change only.** `ALL_CAPABILITIES` (`staffCapability.ts:33`) derives from
`staffCapability.options`, so `super_admin` automatically implies the new four via `capabilitiesForRole`
(`staffCapability.ts:51`). `staffMeSchema` (`staffCapability.ts:61`) already returns
`capabilities: array(staffCapability)`, so `/admin/me` and `useStaffMe().has(cap)` light up with **no schema
migration**.

### 5.2 Role-bundle changes (`ROLE_CAPABILITIES`)

Update the bundle map at `staffCapability.ts:37`. Design intent: a **least-privilege data-operator footprint**
without inventing a new `staffRole` enum value (that *would* be a wider change touching `auth.ts:35` and the
`platform_staff` write path). Instead we **fold data caps into the existing roles** that already operate the
relevant surfaces:

```ts
const ROLE_CAPABILITIES: Record<Exclude<StaffRole, "super_admin">, StaffCapability[]> = {
  support: [
    "users:deactivate", "tenants:notes:write", "tenants:hold",
    "impersonate:start", "content:manage",
    "data:read",                       // NEW — support can OBSERVE data-ops to triage tickets, no writes
  ],
  billing_ops: ["tenants:credits", "billing:read", "elevation:request"],
  compliance_officer: [
    "audit:read", "compliance:read", "compliance:manage",
    "data:read", "data:manage", "data:review",  // NEW — the data steward role; operate + review, NOT export
  ],
  read_only: [],                       // unchanged — sees nothing privileged (least privilege baseline)
};
// super_admin (absent here) implies ALL, incl. data:export.
```

Rationale:

- **`support` → `data:read` only.** Support agents need to *see* a tenant's import/enrichment status to answer
  tickets, but must never operate pipelines or export. Read-only is the floor for a triage role.
- **`compliance_officer` → `data:read` + `data:manage` + `data:review`.** This role becomes the **data
  steward**: operate pipelines (retry/pause), and run the clerical-review queue. It deliberately **excludes
  `data:export`** — bulk cross-tenant export of PII is a strictly higher bar.
- **`data:export` belongs to `super_admin` only** (via implies-all) **and** must additionally pass **maker/
  checker + JIT elevation** (§5.6). No standing role holds standing export power. This directly answers C3
  (super_admin overuse) by making the *most* dangerous capability also the *most* friction-gated, rather than
  a silent side-effect of being super_admin.
- **`read_only` stays empty** — the canonical least-privilege role; it can authenticate into the console and
  the API will 403 every privileged call.

> **Optional future role.** If operational volume justifies a dedicated `data_ops` *role* (separate from
> `compliance_officer`), that is a follow-on: it adds one value to the `staffRole` enum (`auth.ts:35`) and one
> bundle entry. It is **out of scope for Phase 0–2**; folding into `compliance_officer` ships the capability
> model now with zero enum-surface risk. Tracked in [`15-Future-Enhancements`](./15-Future-Enhancements.md).

### 5.3 Per-endpoint gates (staff side)

Every `/api/v1/admin/data/*` route composes `authn → platformAdmin → requireCapability(...)`. `platformAdmin`
(rejects unless signed `claims.pa === true`) is applied to **all** `/admin/*` already; `requireCapability`
resolves the **active** role from `platform_staff` per request (`requireCapability.ts:18`) so revocation is
immediate. Full endpoint table in [§9](#9-api-requirements).

### 5.4 Customer side (Surface 2) — `org_role` + owner-scope + RLS

Surface 2 (`apps/web` data-health control panel) **never** touches staff RBAC. Its gates:

- **Tenant wall = RLS.** Every read/write runs inside `withTenantTx(scope, fn)` (`packages/db/src/client.ts:74`),
  which `SET LOCAL ROLE leadwolf_app` (non-`BYPASSRLS`) and sets `app.current_tenant_id` /
  `app.current_workspace_id` LOCAL. `NULLIF(empty)` ⇒ **fail-closed**. Scope comes from the **verified token**
  (`c.get('tenantId')` / `workspaceId`), never the request body.
- **Org-level admin actions** (workspace-wide import config, export of the workspace's own data,
  retention/DSAR requests) gate on `requireOrgRole(...)` (`requireOrgRole.ts:14`), resolving `org_role` from
  `tenant_members` (RLS-scoped). `owner` implies all org capabilities.
  - Workspace data **export** → `requireOrgRole('owner')` (or `compliance_admin`) — the customer analog of the
    staff `data:export` bar.
  - Import wizard / dedup-review of own data → `requireOrgRole('member')` is sufficient *plus* owner-scope.
- **Record-level owner-scope.** Within a workspace, mutate/reveal is further constrained by `owner_user_id` on
  `contacts` (`contacts.ts:103`): a `member` operates rows they own (or are list-shared); `admin`/`owner`
  operate workspace-wide. This is the [`02` dim 15](./02-Enterprise-Research.md#415-rbac)
  "ownership-checked write" applied to the customer surface.

**Boundary statement (load-bearing):** *Staff console = cross-tenant ops/maintenance, gated by `data:*` + `pa`
+ `withPlatformTx`. Self-service = own-workspace only, gated by `org_role` + `owner_user_id` + RLS via
`withTenantTx`.* A staff capability must **never** appear in an `apps/web` gate; an `org_role` must **never**
gate an `/admin/*` route. [`12`](./12-Security-and-Compliance.md) treats a crossover as a P1 finding.

### 5.5 The credit-cap / preview-redeem split ([`02` dim 15/16](./02-Enterprise-Research.md#416-approval-workflows))

TruePoint's analog of "per-API-key credit caps + preview-vs-redeem":

| Best-practice concept | TruePoint mechanism |
|---|---|
| API-key credit cap | per-tenant **monthly budget + MTD spend** on `provider_configs` (already shipped, `features/provider-configs`); plus a **per-run worst-case estimate** pre-computed before commit ([`08`](./08-Data-Enrichment-Workflow.md)) |
| Rate window | the **bulk lane** queue + per-tenant rate limits ([`13` dim 18](./13-Performance-and-Scaling.md)) |
| Preview privilege (no spend, no PII) | `data:read` — estimate/preview endpoints return counts + worst-case cost, **never** charge, **never** reveal |
| Redeem privilege (charges + reveals) | `data:manage` (re-run) / `data:export` (export) — the commit endpoints; carry `Idempotency-Key`; charge **only on success** (bill 200s only, [`02` dim 19](./02-Enterprise-Research.md#419-error-handling)) |

### 5.6 Separation of duties (maker ≠ checker)

For the highest-risk data ops the RBAC layer alone is insufficient — they require the **approval object** from
[`09`](./09-Review-and-Approval-System.md). The RBAC rule layered on top:

- The **requester** (maker) needs the operating capability (`data:manage` or the `data:export` maker right).
- The **approver** (checker) needs the **same** capability **and** `data:review` (or, in Phase 2, a
  `data:export` held by a *different* staff member), and the approval row **must** record
  `requested_by != approved_by` — enforced in the API handler, asserted in tests (§11).
- The most dangerous actions (cross-tenant **export**, retention `enforce` graduation) **also** require a
  fresh **JIT elevation** (`jit_elevations`, `/admin/elevations`) so the power is time-boxed, not standing.

This is **defence-in-depth**: capability (who may), approval (two-person), elevation (time-boxed), audit
(`withPlatformTx` writes the trail in-tx). Removing any one layer is a regression.

---

## 6. Implementation Steps (sequenced)

1. **Extend the enum** (`packages/types/src/staffCapability.ts:13`) with the four `data:*` values. Pure
   additive change to a Zod enum; `ALL_CAPABILITIES` and `super_admin`-implies-all follow automatically.
2. **Update `ROLE_CAPABILITIES`** (`staffCapability.ts:37`) per §5.2. No DB migration — assignment lives in
   `platform_staff`.
3. **Unit-test the bundle map** — assert `capabilitiesForRole('compliance_officer')` contains
   `data:read|manage|review` and **not** `data:export`; `read_only` ⇒ `[]`; `super_admin` ⇒ all incl.
   `data:export` (§11).
4. **Wire the gates** on the new `/api/v1/admin/data/*` routers (created in
   [`04`](./04-Control-Panel-Architecture.md)) — `requireCapability('data:read')` on every GET,
   `('data:manage')` on operate POSTs, `('data:review')` on review POSTs, `('data:export')` on the export
   initiate (§9).
5. **Layer maker/checker + elevation** on export + retention-enforce per [`09`](./09-Review-and-Approval-System.md);
   enforce `requested_by != approved_by` and a valid elevation in the handler.
6. **Surface 2 gates** — apply `requireOrgRole(...)` + owner-scope on the `apps/web` data routes (§5.4).
7. **Console UI gating** — consume `useStaffMe().has('data:*')` / `canMaybe('data:*')` in the new feature
   folders to hide actions the caller can't perform (defence-in-depth; API stays authoritative).
8. **Isolation + authz integration tests** (§11), including the mandatory tenant-isolation test for any path
   that writes.

---

## 7. UI/UX Requirements

The permission model is mostly invisible, but it surfaces in three places: (a) **nav/action hiding** via
`useStaffMe()`, (b) a **403 empty-state** when a deep link is hit without the capability, and (c) a **staff
RBAC admin** view (existing `features/staff`) where roles ⇄ capabilities are inspected. Below is the
capability-aware **Data-Ops action bar** that every panel renders.

### Key screen — capability-gated action region (ASCII wireframe)

```
┌─ Data management ▸ Imports & Uploads ──────────────────────── [StaffMe: compliance_officer] ─┐
│                                                                                              │
│  Tenant: Acme Corp ▸ ws: Sales         StatusBadge[running]   StatTile  StatTile  StatTile   │
│  ───────────────────────────────────────────────────────────────────────────────────────── │
│  DataTable<ImportRunRow>  (Column<T> sortValue / rowKey)                                      │
│   ┌─────────────┬──────────┬──────────┬───────────┬──────────────────────────────────────┐  │
│   │ job_id      │ status   │ created  │ rejects   │ actions                              │  │
│   ├─────────────┼──────────┼──────────┼───────────┼──────────────────────────────────────┤  │
│   │ imp_8f2…    │ running  │ 2m ago   │ 14        │ [Drill]  [Pause]ᵐ [Cancel]ᵐ          │  │
│   │ imp_7c1…    │ partial  │ 1h ago   │ 203       │ [Drill]  [Retry]ᵐ                    │  │
│   └─────────────┴──────────┴──────────┴───────────┴──────────────────────────────────────┘  │
│                                                                                              │
│   Legend:  [Drill] = data:read   ᵐ = data:manage (hidden if !has('data:manage'))             │
│            [Export rejects ▾] = data:export → opens maker/checker Dialog (justification req.) │
│                                                                                              │
│   ⟶ caller lacks data:manage: operate buttons are ABSENT (not disabled) — canMaybe() hides    │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Components (`@leadwolf/ui`, `var(--tp-*)` tokens)

- `StateSwitch` wrapping `LoadingState` / `EmptyState` / `ErrorState` over the four states.
- `DataTable` + `Column<T>` (`sortValue`, `rowKey`), `StatusBadge` + `StatusTone`, `StatTile`, `Card`.
- Operate/export actions = `TpButton`; the **export** + any maker/checker action opens a `Dialog` with
  `TpTextarea` for the **mandatory justification reason** (mirror `features/tenants/.../TenantActions.tsx`),
  `useToast` for outcome.
- Action visibility driven by `useStaffMe().has(cap)` (strict, for irreversible) / `canMaybe(cap)` (optimistic
  hide). The **API is authoritative**; the UI hiding is convenience + defence-in-depth.

### Four states

| State | Render |
|---|---|
| **Loading** | `LoadingState` / `Skeleton` rows in the `DataTable` while `useImportRuns()` resolves. |
| **Empty** | `EmptyState` "No import runs for this tenant." Action buttons still gated by capability. |
| **Error** | `ErrorState` with `problemMessage(res, fallback)` reading RFC-7807 `detail`/`title`. A **403** renders a *distinct* "You don't have the `data:*` capability for this view" empty-state, not a generic error. |
| **Data** | `DataTable` with capability-filtered action columns; operate buttons **absent** (not disabled) when the cap is missing. |

---

## 8. Database & Backend Changes

### 8.1 No new tables or columns are required for the capability model

- The capability enum is **code** (`packages/types/src/staffCapability.ts`) — a Zod enum, **no migration**.
- Role assignment already lives in **`platform_staff`** (read via `platformStaffRepository.getActiveRole`,
  `requireCapability.ts:18`). Adding `data:*` does not change its shape.
- `/admin/me` already returns `capabilities[]` (`staffMeSchema`, `staffCapability.ts:61`) — the new caps flow
  through unchanged.

### 8.2 Reused existing tables

| Table | Used for |
|---|---|
| `platform_staff` | active staff role → capability resolution (immediate revocation) |
| `platform_audit_log` | written **in-tx** by `withPlatformTx(actor, action, fn, {...})` (`client.ts:121`) for every cross-tenant data write |
| `jit_elevations` | time-boxed grant for export + retention-enforce |
| `tenant_members` | `org_role` resolution for Surface 2 (`requireOrgRole.ts:18`) |
| `contacts.owner_user_id` | record-level owner-scope on the customer surface (`contacts.ts:103`) |
| `audit_log` (`schema/billing.ts:169`) | append-only customer-tenant audit (UPDATE/DELETE blocked by trigger), written via `packages/core/src/compliance/writeAudit.ts` |

### 8.3 If a `data_ops` *role* is added later (deferred)

Only if §5.2's optional dedicated role is adopted: add `"data_ops"` to the `staffRole` enum (`auth.ts:35`) and
a bundle entry in `ROLE_CAPABILITIES`. `platform_staff.role` is a text/enum column already storing a
`staffRole`; **a CHECK-constraint widening would be migration ~`0035`** (4-digit + drizzle slug, journal
`meta/_journal.json`). Out of scope for Phase 0–2.

### 8.4 Tx-wrapper posture (the audited write path)

- **Cross-tenant staff writes** (operate a tenant's import, run a merge, export) → **`withPlatformTx`**
  (`client.ts:121`): owner connection (BYPASSRLS) **but** writes a `platform_audit_log` row in the same
  transaction; only reachable behind a verified `pa` claim. **RLS posture:** bypassed structurally, replaced by
  the audited actor/action contract.
- **Cross-tenant master-graph reads** (linking/ER review reads) → **`withErTx`** (`client.ts:56`): role
  `leadwolf_er`, master graph only, no overlay grant, no GUCs.
- **Customer-surface reads/writes** (Surface 2) → **`withTenantTx`** (`client.ts:74`): RLS-enforced,
  fail-closed, scope from the verified token.

> A cross-tenant data write that does **not** go through `withPlatformTx` (or skips the audit row) is a
> **bug** per the precedence rules — [`12`](./12-Security-and-Compliance.md) is authoritative.

---

## 9. API Requirements

All routes below mount under `apps/api/src/features/admin/` as `/api/v1/admin/data/*`, composing
`authn → platformAdmin → requireCapability(...)`. Bodies parsed at the edge with **`safeParse`** against shared
Zod from `@leadwolf/types`; responses re-validated with `parse`. Errors use the RFC-9457 problem envelope
(`middleware/error.ts`). Scope is **always** from the verified token / explicit `tenantId` path param resolved
through `withPlatformTx`, never the body.

| Method · Path | Gate (capability) | Req (Zod) | Resp | Errors | Idem / Page |
|---|---|---|---|---|---|
| `GET /admin/data/overview` | `data:read` | — | `{ queues, importRuns, enrichmentRuns, retentionRuns, qualityRollup }` | 401/403 | — |
| `GET /admin/data/imports?cursor&limit` | `data:read` | keyset query | `{ items, nextCursor }` | 401/403 | keyset (`search.ts`) |
| `GET /admin/data/imports/:jobId/{chunks,rows,rejects}` | `data:read` | path + keyset | `{ items, nextCursor }` | 404/403 | keyset |
| `POST /admin/data/imports/:jobId/{pause,resume,cancel}` | `data:manage` | `{ reason }` | `{ jobId, status }` | 403/404/409 | `Idempotency-Key` |
| `POST /admin/data/imports/:jobId/chunks/:chunkId/retry` | `data:manage` | `{ reason }` | `{ chunkId, status }` | 403/404/409 | `Idempotency-Key` |
| `GET /admin/data/dedup/review?cursor&limit&status=pending` | `data:review` | keyset | `{ items, nextCursor }` | 401/403 | keyset |
| `POST /admin/data/dedup/{confirm,reject,split}` | `data:review` | `{ ids, reason }` | `{ id, review_status }` | 403/404/409 | `Idempotency-Key` |
| `POST /admin/data/enrichment/runs/:jobId/estimate` | `data:read` | `{ tenantId, scope }` | `{ count, worstCaseCostMicros }` (no spend) | 403/422 | — |
| `POST /admin/data/enrichment/runs/:jobId/commit` | `data:manage` | `{ tenantId, scope, testBatch? }` | `{ jobId }` | 402/403/429 | `Idempotency-Key` |
| `POST /admin/data/export` | `data:export` **+ approval + elevation** | `{ tenantId, query, fields, justification }` | `202 { approvalId }` | 403/422/429 | `Idempotency-Key` |
| `POST /admin/data/export/:approvalId/approve` | `data:review`, `approver != requester` | `{ decision, reason }` | `{ exportId, status }` | 403/409 | `Idempotency-Key` |

Error codes (stable machine ids, `packages/types/src/errors.ts`): `ForbiddenError` (403,
`insufficient_capability` from `requireCapability.ts:21`), `ValidationError` (422), `NotFoundError` (404),
`InsufficientCreditsError` (402), `ProviderBudgetExceededError` (429), `SuppressedError`. The export
maker/checker reuses a `409` `requester_is_approver` when `requested_by == approved_by`.

**Surface 2 (customer)** routes mount under `/api/v1/...` with `requireOrgRole(...)`:

| Method · Path | Gate | Notes |
|---|---|---|
| `POST /api/v1/imports/` (own data) | `requireOrgRole('member')` + owner-scope | RLS via `withTenantTx`; reuses `apps/web` ImportWizard |
| `POST /api/v1/data-health/export` | `requireOrgRole('owner'\|'compliance_admin')` | customer analog of `data:export`; suppression-checked |
| `POST /api/v1/compliance/dsar` | `requireOrgRole('compliance_admin')` | DSAR request |

---

## 10. Edge Cases & Failure Scenarios

| # | Scenario | Required behaviour |
|---|---|---|
| E1 | **Revoked mid-session.** Staff role revoked while a console tab is open. | Next API call 403s — `getActiveRole` is per-request (`requireCapability.ts:18`); the JWT is *not* trusted for role. UI surfaces the 403 empty-state. |
| E2 | **Capability creep.** A new gated action ships without a matching cap and is mistakenly gated on `compliance:manage`. | The matrix (§ below) is the single source of truth; a PR adding an action **must** add/choose a `data:*` cap. Lint/test asserts every `/admin/data/*` route names a `data:*` cap. |
| E3 | **`super_admin` overuse.** Operator uses `super_admin` for routine data ops. | Routine ops are reachable with `compliance_officer` (data steward bundle); `super_admin` is reserved for break-glass. The audit log attributes every write to the actor regardless, so over-grant is *visible*. Export still demands maker/checker + elevation even for super_admin. |
| E4 | **Maker == checker.** Requester tries to approve their own export. | Handler rejects `409 requester_is_approver`; asserted in tests. Ties to [`09`](./09-Review-and-Approval-System.md). |
| E5 | **Elevation expired.** Export approved but the JIT elevation lapsed before commit. | Commit re-checks the elevation; expired ⇒ 403, requester must re-elevate. Power is never standing. |
| E6 | **Surface crossover.** A staff capability check leaks into `apps/web`, or an `org_role` check guards `/admin/*`. | Treated as a P1 by [`12`](./12-Security-and-Compliance.md). The boundary in §5.4 is absolute. |
| E7 | **`read_only` deep-links a write screen.** | API 403s every privileged call; `read_only` bundle is `[]`. UI hides operate buttons. |
| E8 | **Preview leaks PII/spend.** An estimate endpoint accidentally reveals or charges. | Preview endpoints are gated on `data:read` *only* and must not call the reveal/charge path; tested that estimate returns counts/cost with zero `cost_micros` charged. |
| E9 | **Body-supplied scope.** Caller passes a `tenantId` in the body hoping to widen scope. | Scope/tenant comes from the path param resolved through `withPlatformTx` with audit, never silently from the body; cross-tenant reach is always the explicit, audited `pa` path. |

---

## 11. Testing Strategy

**Unit (`@leadwolf/types`):**
- `capabilitiesForRole('compliance_officer')` ⊇ `{data:read, data:manage, data:review}` and **excludes**
  `data:export`.
- `capabilitiesForRole('read_only')` === `[]`.
- `capabilitiesForRole('super_admin')` === `staffCapability.options` (all, incl. `data:export`).
- `roleHasCapability('support','data:read') === true`; `roleHasCapability('support','data:manage') === false`.
- `staffMeSchema.parse({staffRole:'compliance_officer', capabilities:[...]})` round-trips the new caps.

**Integration (`apps/api`, authz):**
- Each `/admin/data/*` route: caller with the cap → 2xx; caller without → 403 `insufficient_capability`;
  caller without `pa` → blocked by `platformAdmin`; `read_only` → 403 on all.
- **Immediate revocation:** seed role, call succeeds; revoke in `platform_staff`; next call 403 (no
  token-refresh in between).
- **Maker ≠ checker:** requester approves own export → 409 `requester_is_approver`.
- **Elevation gate:** export commit without/with expired elevation → 403.
- **Preview no-spend:** `enrichment/estimate` charges zero `cost_micros`.

**itest (mandatory tenant-isolation, where data is written):**
- A `withPlatformTx` data write to tenant A writes a `platform_audit_log` row **in the same tx** (rollback ⇒
  no orphan audit, no orphan write).
- Surface 2: a `member` of workspace W cannot read/write workspace W' rows — `withTenantTx` RLS fail-closed;
  `owner_user_id` owner-scope honoured. This is the **mandatory isolation test** for the customer write path.
- A staff capability presented to an `apps/web` route is ignored (no crossover).

---

## 12. Rollout & Migration Plan

1. **Code-only enum + bundle change** (no DB migration). Ship `data:*` behind the existing console nav being
   dark until [`04`](./04-Control-Panel-Architecture.md) lands. Adding caps to the enum is inert until a route
   gates on them.
2. **Phase 0 (Observe & Enable):** wire `data:read` gates on the read-only Data-Ops Overview + import
   drill-down. Grant `data:read` to `support` and `compliance_officer`. No writes.
3. **Phase 1 (Validate / Dedup-Review / Enrich):** introduce `data:manage` + `data:review` gates; grant the
   data-steward bundle to `compliance_officer`. Shadow → canary (one internal tenant) → GA.
4. **Phase 2 (Approve / Export / Self-Serve):** ship `data:export` behind maker/checker + JIT elevation;
   reserve to `super_admin` standing + elevated checker. Wire Surface 2 `requireOrgRole` gates.
5. **Phase 3+ (Govern & Scale):** optional dedicated `data_ops` `staffRole` (migration ~`0035`), retention
   `enforce` graduation under approvals.
6. **Backfill:** none — no existing rows reference the new caps; assignment is per-staff via `platform_staff`.
7. **Rollback:** removing a `data:*` value is safe only after all gates referencing it are removed (the enum is
   closed; a `safeParse` of an unknown cap fails closed). Prefer leaving the value and removing the bundle
   grant.

Flag/capability gating summary: **nav-group flag** (dark) × **per-route `requireCapability`** × **per-tenant
feature flags** (e.g. `bulk_import_enabled`) × **maker/checker + elevation** for the top tier.

---

## 13. Capability → Panel-Action Matrix (authoritative)

Single source of truth: the API gates on it, the console hides UI against it, the tests assert it. Roles
shown are the **standing** bundles (`super_admin` implies every column). `✓` = granted; `E` = additionally
requires **JIT elevation**; `MC` = additionally requires **maker/checker** ([`09`](./09-Review-and-Approval-System.md)).

| Panel action (doc) | Capability | super_admin | compliance_officer | support | billing_ops | read_only |
|---|---|:--:|:--:|:--:|:--:|:--:|
| Data-Ops Overview read ([`04`](./04-Control-Panel-Architecture.md),[`10`](./10-Monitoring-and-Observability.md)) | `data:read` | ✓ | ✓ | ✓ | — | — |
| Import drill chunks/rows/rejects ([`05`](./05-Upload-Pipeline-Design.md)) | `data:read` | ✓ | ✓ | ✓ | — | — |
| Import retry/pause/cancel ([`05`](./05-Upload-Pipeline-Design.md)) | `data:manage` | ✓ | ✓ | — | — | — |
| Validation rule config ([`06`](./06-Data-Validation-Framework.md)) | `data:manage` | ✓ | ✓ | — | — | — |
| ER merge confirm/reject/split ([`07`](./07-Deduplication-and-Linking.md)) | `data:review` | ✓ | ✓ | — | — | — |
| Enrichment estimate/preview ([`08`](./08-Data-Enrichment-Workflow.md)) | `data:read` | ✓ | ✓ | ✓ | — | — |
| Enrichment re-run / test-batch ([`08`](./08-Data-Enrichment-Workflow.md)) | `data:manage` | ✓ | ✓ | — | — | — |
| Bulk cross-tenant export ([`09`](./09-Review-and-Approval-System.md)) | `data:export` | ✓ E MC | — | — | — | — |
| Retention `enforce` graduation ([`12`](./12-Security-and-Compliance.md)) | `compliance:manage` | ✓ E MC | ✓ E MC | — | — | — |
| Provider enable/budget ([`08`](./08-Data-Enrichment-Workflow.md)) | `providers:manage` | ✓ | — | — | — | — |
| Audit-log read/export ([`10`](./10-Monitoring-and-Observability.md)) | `audit:read` | ✓ | ✓ | — | — | — |
| Surface 2 own-data import ([`05`](./05-Upload-Pipeline-Design.md)) | `org_role:member` + owner-scope | — customer surface — |||||
| Surface 2 own-data export ([`09`](./09-Review-and-Approval-System.md)) | `org_role:owner\|compliance_admin` | — customer surface — |||||

---

## 14. Success Metrics & Acceptance Criteria

Testable checklist (each maps to a test in §11):

- [ ] `staffCapability` enum contains exactly the original 16 **+** `data:read`, `data:manage`, `data:review`,
  `data:export` (20 total), and `StaffCapability` type compiles.
- [ ] `ROLE_CAPABILITIES`: `support` gains `data:read` only; `compliance_officer` gains
  `data:read`+`data:manage`+`data:review` and **not** `data:export`; `read_only` stays `[]`.
- [ ] `super_admin` implies all 20 (via `capabilitiesForRole`), including `data:export`.
- [ ] Every `/api/v1/admin/data/*` route names a `data:*` capability in a `requireCapability(...)` gate; none
  is reachable without `platformAdmin` (`pa` claim).
- [ ] A caller without the capability receives `403 insufficient_capability`; with it, `2xx`.
- [ ] Revoking a staff role in `platform_staff` causes the **next** API call to 403 with **no** token refresh
  (immediate-revocation property holds).
- [ ] `data:export` commit is unreachable without **both** a valid JIT elevation **and** an approval where
  `requested_by != approved_by`; self-approval → `409`.
- [ ] Enrichment **preview** (`data:read`) charges zero `cost_micros` and reveals no PII.
- [ ] Surface 2 data routes gate **only** on `requireOrgRole`/`owner_user_id`/RLS; no `apps/web` route
  references a staff capability, and no `/admin/*` route references an `org_role` (no crossover).
- [ ] Mandatory tenant-isolation itest passes: cross-tenant staff write writes its `platform_audit_log` row in
  the same tx; a `member` cannot read/write another workspace's rows under `withTenantTx`.
- [ ] `/admin/me` (`staffMeSchema`) returns the new caps and `useStaffMe().has('data:*')` correctly hides
  console actions the caller can't perform.

---

### Cross-references

[`01-Current-State-Analysis`](./01-Current-State-Analysis.md) ·
[`02-Enterprise-Research`](./02-Enterprise-Research.md) ·
[`03-Gap-Analysis`](./03-Gap-Analysis.md) ·
[`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) ·
[`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) ·
[`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md) ·
[`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) ·
[`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md) ·
[`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) ·
[`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) ·
[`12-Security-and-Compliance`](./12-Security-and-Compliance.md) ·
[`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) ·
[`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md) ·
[`15-Future-Enhancements`](./15-Future-Enhancements.md) ·
[`README`](./README.md)
