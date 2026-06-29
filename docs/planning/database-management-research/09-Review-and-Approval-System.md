# 09 — Review & Approval System

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored · **Prev:** [`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md) · **Next:**
> [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md)

---

## 1. Objective

Introduce a **maker/checker (dual-control) approval workflow** for high-blast-radius data operations — the
human-in-the-loop gate that TruePoint does **not** have today ([`01` §8](./01-Current-State-Analysis.md#8-current-challenges-synthesis)).
A staff operator (or, on Surface 2, a workspace admin) who wants to run an irreversible or
expensive-and-wide operation must first **request** it; a *different* qualified principal must **approve**
it; only then can it **execute**, exactly once, against a frozen, pre-computed plan.

The system is **`Missing`** at the start of this series — `01` §10 lists *approval / maker-checker* as
`Missing` and *version history / rollback* as `Missing`. This doc designs the gate; the destructive ops it
guards are designed in the sibling docs it links. The model deliberately **layers on top of** the two
controls TruePoint already ships:

- **JIT elevation** (`jit_elevations`, `/admin/elevations`) — a time-boxed grant of a high-privilege
  capability that an operator must request before sensitive work; today it elevates *who you are*.
- **`withPlatformTx`** (`packages/db/src/client.ts:121`) — the audited, BYPASSRLS, cross-tenant write path
  that writes a `platform_audit_log` row **in the same transaction** as the mutation.

Approval adds the missing third leg: elevation says *you are allowed to ask*, audit says *we recorded what
happened*, and approval says **a second human agreed this specific plan should happen before it did.** This
is the [`02` §4.16 preview-then-commit](./02-Enterprise-Research.md#416-approval-workflows) gate
(Cognism Enrich *preview → redeem*) generalized to every destructive data op.

**In scope:** the `approval_request` ledger; the operation registry of what requires approval; the
preview/worst-case-impact computation; separation-of-duties enforcement; idempotent execute keyed on the
approval id; the staff approval-queue + request-detail UI; the Surface-2 customer equivalent via `org_role`.

**Out of scope (designed elsewhere):** the destructive ops themselves — bulk delete & retention enforce
([`12-Security-and-Compliance`](./12-Security-and-Compliance.md)), dedup merge/split
([`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md)), bulk export & mass enrich
([`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md)), and the capability model
([`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md)). This doc owns the **gate**, not the blast.

---

## 2. Current Challenges

TruePoint today can execute every high-blast-radius operation with **a single principal and no second
sign-off**. Concretely, on branch `feat/data-mgmt-01-research-brief`:

1. **No four-eyes anywhere.** `withPlatformTx` audits *after the fact* but nothing requires a second person
   *before* the write. A `super_admin` (who implies ALL 16 capabilities — `packages/types/src/staffCapability.ts`)
   can suspend, overwrite, delete, or export with one token. Audit is *detective*, not *preventive*.
2. **Retention enforce is a single flip.** The retention engine is `Inert` (`retention_engine_enabled false`
   + per-class `mode shadow`, `schema/retention.ts`, migration `0033`). Graduating a class from `shadow` to
   `enforce` — which begins **deleting real rows** — is today a single audited `PUT /admin/retention-policies`
   by a `super_admin` (`features/retention`, action `retention_policy.set`). One mistake deletes a class
   fleet-wide. ([`12` §retention](./12-Security-and-Compliance.md)).
3. **Dedup merge has no review and no undo.** Within-workspace dedup is `Shipped` with **auto-survivorship
   and no UI** (`01` §5.3); ER merge/split review is `Partial` (deferred), and `match_links.review_status`
   already carries `pending`. A wrong merge is a `Frankenstein` record with no rollback
   ([`07` §clerical-review](./07-Deduplication-and-Linking.md), [`02` §4.9](./02-Enterprise-Research.md#49-manual-review-queues)).
4. **Spend has no pre-commit ceiling.** Enrichment is metered (`enrichment_jobs.cost_micros`, `charged`).
   A bulk enrich can run up a large bill with no one having seen the **pre-computed worst-case spend** that
   [`02` §4.16](./02-Enterprise-Research.md#416-approval-workflows) (Cognism) and `§4.21` (pre-flight cost)
   demand.
5. **Bulk export is unguarded egress.** There is no audited, approval-gated, suppression-checked bulk export
   path; export is exactly the operation an insider-threat or compromised-staff model fears most
   ([`12` §export](./12-Security-and-Compliance.md)).
6. **No params freeze.** Even where an operator *previews*, nothing guarantees the thing executed equals the
   thing previewed — the dataset drifts between preview and run (the *params-drift* edge case, §10).
7. **No SoD primitive.** The capability enum has no notion of *requester* vs *approver*; `staff:manage` and
   `super_admin` are all-or-nothing. There is no closed table that records "A asked, B agreed".

The cost of leaving this open is in [`03` §6](./03-Gap-Analysis.md#6-top-risks-of-leaving-gaps-open): a single
fat-fingered enforce flip or merge is **unrecoverable** because version-history/rollback is also `Missing`.

---

## 3. Enterprise Best Practices (cited)

Drawn from [`02-Enterprise-Research`](./02-Enterprise-Research.md). The load-bearing dimension is **16**, with
support from 9, 11, 13, 15, 19, 21.

- **Preview-then-commit, pre-computed worst-case spend** — [`02` §4.16](./02-Enterprise-Research.md#416-approval-workflows).
  Cognism Enrich splits **Preview** (no spend, no PII reveal) from **Redeem** (reveals + charges); a bulk run
  **pre-computes worst-case spend before** it starts. This is the spine of our model: every approval request
  carries a frozen *preview* (impact + worst-case spend) and execute is the *redeem*.
- **Two thresholds, bias to false-negatives** — [`02` §4.9](./02-Enterprise-Research.md#49-manual-review-queues).
  D&B Confidence Code drives a three-way *auto-merge / steward-review / auto-reject* split; the discipline is
  to **prefer a missed merge (false-negative) over a Frankenstein merge**. Our merge/split approvals inherit
  this: when in doubt, route to a human, never auto-commit.
- **Non-destructive resolution, roll back by re-deriving** — [`02` §4.13](./02-Enterprise-Research.md#413-rollback-mechanisms)
  & [`§4.12`](./02-Enterprise-Research.md#412-version-history). Salesforce Data Cloud treats the golden record
  as a *recomputable view over preserved source rows*; you roll back a merge by re-deriving (vs HubSpot's
  destructive merge). Approval execution must therefore be **reversible-by-design** wherever the underlying op
  is, and the approval record is the anchor a rollback re-derives from.
- **Idempotent receivers; replay the first response** — [`02` §4.19](./02-Enterprise-Research.md#419-error-handling).
  PDL/Apollo bulk: senders retry, so receivers must be idempotent and **replay the first response (including
  failures)**. Our execute uses the approval id as the idempotency key — a double-click or retry never
  double-deletes.
- **Build tooling over decision logs** — [`02` §4.21](./02-Enterprise-Research.md#421-operational-tooling)
  (Apollo Duplicate Analyzer; clerical-review console; pre-flight cost + test batch). The approval queue *is*
  that console; the `approval_request` table *is* the decision log other tooling reads.
- **RBAC: preview-vs-redeem as an auth surface** — [`02` §4.15](./02-Enterprise-Research.md#415-rbac). The
  privilege to *preview* and the privilege to *commit* are **distinct auth surfaces**. We map: `data:review`
  (and the op's own `data:manage`/`data:export`) to request; the **`data:review`** capability — plus a
  server-side maker≠checker check — to approve.
- **Provenance on every decision** — [`02` §4.11](./02-Enterprise-Research.md#411-audit-logs). Log the match
  decision and its composition. Every approve/reject writes `platform_audit_log` via `withPlatformTx`.

> See [`02` §6 Key takeaways](./02-Enterprise-Research.md#6-key-takeaways-for-truepoint) and the
> [`02` §7 Citations](./02-Enterprise-Research.md#7-citations) block for source links.

---

## 4. Gaps in Current Implementation

Mapped from [`01-Current-State-Analysis`](./01-Current-State-Analysis.md) and the register in
[`03-Gap-Analysis`](./03-Gap-Analysis.md#3-gap-register). This doc closes the **Phase 2 (Approve, Export,
Self-Serve)** approval gap.

| # | Gap (best-practice − current) | Today | Target | Tier |
|---|---|---|---|---|
| A | No maker/checker for any op | `Missing` (`01` §10) | `approval_request` ledger + execute gate | **Medium / Phase 2** |
| B | Retention enforce flip = 1 person | single audited `PUT` | approval-gated state change | **Medium / Phase 2** → graduates in **Phase 3+** |
| C | Dedup merge/split has no review/undo | `Partial`, auto-survivorship | approval on `match_links.review_status=pending` | **Medium / Phase 1→2** |
| D | Bulk export unguarded | no path | approval + suppression-check + `data:export` | **Medium / Phase 2** |
| E | Bulk enrich has no worst-case ceiling | `cost_micros` post-hoc | pre-computed worst-case spend in request | **Medium / Phase 1→2** |
| F | No params-freeze (preview≠execute) | n/a | frozen `params` + `content_hash` drift guard | **Medium / Phase 2** |
| G | No SoD primitive | all-or-nothing caps | `data:review` request / `data:review` approve (maker≠checker) | **Medium / Phase 2** ([`11`](./11-Roles-and-Permissions.md)) |
| H | Customer side has no approvals | none | Surface-2 own-workspace via `org_role` | **Medium / Phase 2** |

Dependencies (from [`03` §5](./03-Gap-Analysis.md#5-dependency-graph--sequencing)): approval **depends on** the
Phase-0 `data:read` console + nav group ([`04`](./04-Control-Panel-Architecture.md)) and the new capability
scaffold ([`11`](./11-Roles-and-Permissions.md)); it is **depended on by** retention enforce rollout, bulk
export, and the dedup merge console.

---

## 5. Recommended Solution

### 5.1 The model in one paragraph

A **destructive op is no longer called directly.** Instead the operator calls `POST .../approvals/create`
with an `operation` id and its `params`. The server **computes the preview** — what would change, how many
rows, worst-case spend — *without mutating anything*, freezes both `params` and the preview into an immutable
`approval_request` row (`status=pending`), and snapshots a `content_hash` of the target selection. A second,
qualified principal opens the queue, reads the diff/impact, and calls `approve` (or `reject` with a reason).
Only an **approved, unexpired** request can `execute`; execute re-validates the `content_hash` against live
data (drift guard), runs the real op inside **`withPlatformTx`** (so the mutation + `platform_audit_log` are
one transaction), and flips the row to `executed` — **idempotently, keyed on the approval id.**

```
                  preview (NO mutation)                 second human                 idempotent, audited
 operator ──create──▶ [pending] ──────────────▶ approver ──approve──▶ [approved] ──execute──▶ [executed]
   │  (data:review +          │                    │  (data:review,             │   (withPlatformTx,
   │   op capability)         │                    │   maker≠checker)           │    content_hash re-check)
   └─ JIT elevation if        ├─ reject(reason) ──▶ [rejected]                  └─ replay first result on retry
      op is high-privilege    └─ expires_at lapses ▶ [expired]
```

### 5.2 Operations that REQUIRE approval (the registry)

A **server-owned registry** (`packages/types/src/approvalOperation.ts`, a closed enum + per-op config) is the
single source of truth. Calling a registered op *directly* (bypassing approval) is rejected at the route
layer. Each entry declares: the request capability, whether JIT elevation is required, the execute capability,
whether it is reversible, the worst-case-spend computer, and the impact computer.

| `operation` | What it does (blast radius) | Request cap | JIT? | Approve cap | Reversible? | Worst-case |
|---|---|---|---|---|---|---|
| `bulk_delete` | soft-delete (DSAR tombstone `contacts.deleted_at`) N contacts in a ws | `data:manage` | yes | `data:review` | yes (tombstone, re-derivable) | row count |
| `dedup_merge` | collapse a `match_links` cluster to one survivor | `data:review` | no | `data:review` | yes (non-destructive, re-derive) | members affected |
| `dedup_split` | un-merge a survivor cluster | `data:review` | no | `data:review` | yes | members affected |
| `retention_enforce_flip` | `retention_class_policies.mode shadow→enforce` (begins deleting) | `data:manage` | **yes** | `super_admin` | **no** (deletes) | est. rows/run, classes |
| `bulk_export` | export contacts/accounts to a download artifact | `data:export` | yes | `data:review` | n/a (egress) | rows + PII columns |
| `mass_field_overwrite` | overwrite a field across N records (provenance reset) | `data:manage` | yes | `data:review` | yes (field-version) | rows × fields |
| `enrich_with_spend` | bulk enrich whose **worst-case spend ≥ threshold** | `data:manage` | conditional | `data:review` | n/a (charge-on-success) | Σ `cost_micros` |

> **Threshold gating.** `enrich_with_spend` only *requires* approval when pre-computed worst-case spend
> crosses a configurable ceiling (`APPROVAL_ENRICH_SPEND_THRESHOLD_MICROS`, `packages/config/src/env.ts`,
> default e.g. 5,000,000 µ = $5). Below the ceiling the existing preview-then-redeem path
> ([`08`](./08-Data-Enrichment-Workflow.md)) is enough. This mirrors [`02` §4.2](./02-Enterprise-Research.md#42-bulk-uploads):
> size the gate from a budget, don't gate everything.

> **Bulk export uses this same gate.** `bulk_export` approval is **not** a separate mechanism: it flows through
> this generic `approval_request` flow (`operation=bulk_export`, gated `data:export` to request / `data:review`
> to approve). The `data_export_jobs` row ([`12`](./12-Security-and-Compliance.md)) is the export **artifact**;
> its `status` is **driven by** this `approval_request`, which remains authoritative for the approve/reject
> decision.

### 5.3 Layering on existing controls (no parallel universe)

- **Elevation is a precondition, not a replacement.** For ops marked *JIT yes*, the requester must already
  hold a valid `jit_elevations` grant (checked by `requireCapability` resolving the active role). Approval is
  *additive*: elevated **and** approved.
- **Execute always uses `withPlatformTx`.** The cross-tenant mutation and its `platform_audit_log` row are
  one transaction (`client.ts:121`). Approve/reject also write audit via the same path. There is **no**
  un-audited execution path — a multi-tenant write without an RLS-enforced, ownership-checked, audited path is
  a bug, not a style choice (project precedence).
- **Surface 2 mirror.** Customer-side approvals reuse the same `approval_request` table (scoped by
  `tenant_id`+`workspace_id`, RLS-enforced via `withTenantTx`, `client.ts:74`) but the request/approve
  capabilities are `org_role` checks (`requireOrgRole`), never staff RBAC. See §5.4.

### 5.4 Surface boundaries

| | Surface 1 — Staff Console (`apps/admin`) | Surface 2 — Customer (`apps/web`) |
|---|---|---|
| Who | platform staff | workspace members |
| Auth | staff capabilities (`data:read`/`data:manage`/`data:review`/`data:export`) + `pa` claim | `org_role` (e.g. `owner`/`admin` requests, `owner` approves) |
| Tx | `withPlatformTx` (BYPASSRLS, audited) | `withTenantTx` (RLS, fail-closed) |
| Scope | any tenant (cross-tenant) | own workspace only (`workspace_id` from token) |
| Audit | `platform_audit_log` | `audit_log` (`packages/core/src/compliance/writeAudit.ts`) |
| Ops | all 7 registry entries | own-ws subset: `bulk_delete`, `dedup_merge`, `bulk_export` |

---

## 6. Implementation Steps (sequenced)

1. **Capability scaffold** ([`11`](./11-Roles-and-Permissions.md)). The closed enum in
   `packages/types/src/staffCapability.ts` grows by **exactly four** data caps — `data:read`/`data:manage`/`data:review`/`data:export`
   (16 → 20); there is **no** separate `data:approve` capability. The act of **approving/rejecting** a request is
   gated by the existing **`data:review`** capability **plus a server-side `requester != approver` (maker≠checker)
   check** — SoD comes from that runtime check, not a distinct grant. Wire `ROLE_CAPABILITIES`,
   `capabilitiesForRole()`, and `staffMeSchema` accordingly.
2. **Operation registry.** Create `packages/types/src/approvalOperation.ts`: the `ApprovalOperation` enum, the
   per-op config (caps, JIT flag, reversible flag), and the shared Zod schemas for each op's `params`
   (`bulkDeleteParams`, `dedupMergeParams`, …) exported from `@leadwolf/types`.
3. **Migration `~0035`.** Add the `approval_request` table + enum + RLS policy + audit-trigger (block
   `UPDATE`/`DELETE` of terminal rows). Renumber to the next free 4-digit slug after `0034`
   (`packages/db/src/migrations/`), update `meta/_journal.json` via `drizzle.config.ts` generate. Drizzle
   schema in `packages/db/src/schema/approvalRequest.ts`, exported from `schema/index.ts`.
4. **Preview/impact computers.** `packages/core/src/approval/computeImpact.ts` — one pure function per op that,
   given `params` + a read-only tx, returns `{rowsAffected, worstCaseSpendMicros, contentHash, sampleDiff}`
   **without mutating**. Reuses the estimate paths already built (`enrichment/bulk/estimate.ts`, dedup
   helpers).
5. **Execute dispatcher.** `packages/core/src/approval/executeApproval.ts` — re-checks `content_hash`, then
   dispatches to the real op (delete fanout, dedup merge, retention flip, export job enqueue, …) **inside the
   caller's `withPlatformTx`/`withTenantTx`**. Returns a per-record status array ([`02` §4.19](./02-Enterprise-Research.md#419-error-handling)).
6. **Admin router.** `apps/api/src/features/admin/dataApprovals/routes.ts` mounting
   `POST /api/v1/admin/data/approvals/{create,approve,reject,execute}` + `GET /approvals` (keyset) +
   `GET /approvals/:id`. Wire into `apps/api/src/features/admin/routes.ts`. Middleware: `authn` → `platformAdmin`
   → `requireStaffRole` → `requireCapability`.
7. **Customer router.** `apps/api/src/features/dataApprovals/` mounting the Surface-2 subset under
   `/api/v1/...` with `requireOrgRole` and `withTenantTx`.
8. **Idempotency.** Reuse `middleware/idempotency.ts` on `execute`, but the **db unique on `approval_request`
   status transition is the real guard** (§8) — the approval id *is* the idempotency key.
9. **Admin UI feature folder.** `apps/admin/src/features/data-approvals/` (barrel + `api.ts` + `types.ts` +
   `hooks/useApprovalQueue.ts` + `hooks/useApprovalDetail.ts` + `components/ApprovalsPage.tsx` +
   `ApprovalDetail.tsx`) following `features/retention` (tabs + super-admin gate) and
   `features/tenants/components/TenantActions.tsx` (Dialog + mandatory reason). Add nav destination under the
   Data management group ([`04`](./04-Control-Panel-Architecture.md)).
10. **Customer UI.** Extend `apps/web/src/features/data-health` with an Approvals tab ([`04`](./04-Control-Panel-Architecture.md)).
11. **Wire the destructive ops behind the gate.** Change retention enforce, bulk delete, dedup merge/split,
    bulk export, and over-threshold enrich to **refuse direct execution** and require an approved
    `approval_request` (the registry guard from step 2).
12. **Flag + rollout.** `APPROVAL_WORKFLOW_ENABLED` (`packages/config/src/env.ts`) default `false`;
    shadow→canary→GA per §12.

---

## 7. UI/UX Requirements

Two screens in `apps/admin`, following the established `features/*` templates and `@leadwolf/ui` tokens
(`var(--tp-*)`). All four states handled via **`StateSwitch`** (loading/error/empty/data).

### 7.1 Approval Queue (`ApprovalsPage.tsx`)

**Components:** `Tabs` (Pending | Approved | Executed | Rejected/Expired) · `DataTable` + `Column<T>` ·
`StatusBadge`+`StatusTone` (pending=warn, approved=info, executed=success, rejected/expired=neutral/danger) ·
`StatTile` row (Pending count, Awaiting-my-approval, Worst-case-spend-queued, Expiring <24h) · `Combobox`
(filter by operation) · `Pagination` (keyset) · `StateSwitch`.

```
┌─ Data management ▸ Review & Approval ───────────────────────────────────────────────┐
│ [ Pending 7 ]  Approved  Executed  Rejected/Expired                                   │
│ ┌─StatTile─┐ ┌─StatTile──────┐ ┌─StatTile────────┐ ┌─StatTile────────┐                │
│ │ Pending  │ │ Awaiting MY   │ │ Worst-case $ in │ │ Expiring < 24h  │                │
│ │   7      │ │ approval  3   │ │ queue  $1,240   │ │      2          │                │
│ └──────────┘ └───────────────┘ └─────────────────┘ └─────────────────┘                │
│ Operation [All ▾]   Requester [All ▾]   Tenant [All ▾]            [ Refresh ]          │
│ ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Operation         Tenant/WS     Impact         Worst $   Requested by   Status  Exp │ │
│ │ retention enforce  acme/—        ~12,400 rows   —         dana (you?)    ●pending 6h │ │
│ │ bulk_export        beta/sales    8,210 rows·PII  —        evan           ●pending 22h│ │
│ │ dedup_merge        acme/mkt      318 members     —        evan           ●pending 3h │ │
│ │ enrich_with_spend  acme/sales    4,000 rows      $420.00  dana           ●pending 48h│ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│  Rows show "you?" badge when requester == current staff (self-approval will be blocked)│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Loading:** `LoadingState` / `Skeleton` table rows.
- **Empty:** `EmptyState` — "No pending approvals. High-risk operations will appear here for review."
- **Error:** `ErrorState` with the RFC-7807 `detail` surfaced via the feature's `problemMessage(res, fallback)`
  helper; a Retry button calls the hook's `reload()`.
- **Data:** the table above; clicking a row opens the detail drawer.

### 7.2 Request Detail + Decision (`ApprovalDetail.tsx`, a `Drawer`)

**Components:** `Drawer` · `Card` (params + impact) · `DataTable` (sample diff, first N rows) · `StatusBadge` ·
`TpButton` (Approve / Reject) · `Dialog` (confirm) · `TpTextarea` (mandatory reason, ≥10 chars, like
`TenantActions.tsx`) · `Tooltip` (why disabled) · `ToastProvider/useToast` (result).

```
┌─ Approval · retention_enforce_flip ─────────────────────────────[ × ]┐
│ Status ●pending   Tenant acme   Requested by dana · 2026-06-29 14:02 │
│ Expires in 5h 51m                                                     │
│ ── Operation params (frozen) ──────────────────────────────────────  │
│  classes: [marketing_events, raw_imports]  mode: shadow → enforce     │
│  content_hash: 9f3c…a1 (re-checked at execute)                        │
│ ── Worst-case impact (preview, no mutation) ───────────────────────   │
│  est. rows deleted / run: ~12,400      reversible: NO (hard delete)   │
│  classes affected: 2                   worst-case spend: —            │
│ ── Sample of affected rows (read-only, first 25) ──────────────────   │
│  [DataTable: class · row_id · last_activity_at · age_days ]           │
│ ──────────────────────────────────────────────────────────────────   │
│  ⚠ You cannot approve your own request.            (if maker==you)    │
│  Reason (required) [ TpTextarea …………………………………………………………… ]            │
│            [ Reject ]                 [ Approve ]  ← disabled w/Tooltip │
└──────────────────────────────────────────────────────────────────────┘
```

- Approve/Reject open a `Dialog` confirm; the **reason is mandatory** for both (audited).
- When `requested_by == current staff id`, both buttons render disabled with a `Tooltip`:
  "Separation of duties — a different approver is required." (server enforces regardless; UI is courtesy).
- After a successful `execute` (from the Executed-eligible state), a `useToast` success surfaces the
  per-record result summary and a link to the resulting job/audit entry.
- **Accessibility:** WCAG 2.2 AA — focus trapped in the Drawer, the reason field is labelled, the danger
  (irreversible) state uses `--tp-` danger tokens *and* an icon + text (not colour alone).

---

## 8. Database & Backend Changes

### 8.1 New table `approval_request` (migration `~0035`)

Reuses scope columns and conventions from `import_jobs`/`retention_runs`. **Layer-1 overlay** posture for the
customer surface (carries `tenant_id`+`workspace_id`, RLS-scoped); staff cross-tenant rows are written via
`withPlatformTx` (owner connection, BYPASSRLS) but still carry their target scope for filtering and audit.

```sql
-- packages/db/src/migrations/  — the next sequential migration (0035+), assigned at implementation time
--   (several docs add migrations this phase; slug indicative, the actual number is the next free after 0034)

CREATE TYPE approval_status AS ENUM
  ('pending', 'approved', 'rejected', 'expired', 'executed', 'execute_failed');

CREATE TABLE approval_request (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- target scope (NULL workspace_id => tenant-wide op, e.g. retention class flip)
  tenant_id               uuid        NOT NULL,
  workspace_id            uuid,
  -- what
  operation               text        NOT NULL,          -- ApprovalOperation enum (app-validated)
  params                  jsonb       NOT NULL,           -- frozen, Zod-validated per operation
  -- preview (computed at create, no mutation)
  impact                  jsonb       NOT NULL,           -- {rowsAffected, classesAffected, sampleDiff,…}
  worst_case_spend_micros bigint      NOT NULL DEFAULT 0,
  content_hash            text        NOT NULL,           -- hash of the target selection at request time
  reversible              boolean     NOT NULL,
  -- maker / checker (dual control)
  requested_by            uuid        NOT NULL,           -- staff id (S1) or user id (S2)
  requested_reason        text        NOT NULL,
  approver_id             uuid,                            -- set on approve/reject; MUST differ from requester
  decided_reason          text,                            -- mandatory on approve & reject
  decided_at              timestamptz,
  -- lifecycle
  status                  approval_status NOT NULL DEFAULT 'pending',
  expires_at              timestamptz NOT NULL,            -- create + TTL (e.g. 48h)
  executed_at             timestamptz,
  execution_result        jsonb,                           -- per-record status array + correlation token
  surface                 text        NOT NULL,            -- 'staff' | 'customer'
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- SoD: approver can never equal requester (defence in depth; app also checks)
  CONSTRAINT approval_maker_ne_checker
    CHECK (approver_id IS NULL OR approver_id <> requested_by),
  -- a decided row must carry an approver, a reason and a timestamp
  CONSTRAINT approval_decided_complete
    CHECK (status NOT IN ('approved','rejected')
           OR (approver_id IS NOT NULL AND decided_reason IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT approval_executed_complete
    CHECK (status <> 'executed' OR executed_at IS NOT NULL)
);

-- Double-execute race guard: only ONE live execution per approval.
-- A partial unique index ensures at most one row can sit in a terminal-executed lineage.
CREATE UNIQUE INDEX uniq_approval_executed_once
  ON approval_request (id) WHERE status = 'executed';

-- Queue read paths (keyset on created_at,id).
CREATE INDEX idx_approval_pending  ON approval_request (status, created_at DESC, id)
  WHERE status = 'pending';
CREATE INDEX idx_approval_by_tenant ON approval_request (tenant_id, status, created_at DESC, id);
CREATE INDEX idx_approval_expiry    ON approval_request (expires_at) WHERE status = 'pending';
```

**RLS posture (Surface 2 rows).** Add `approval_request` to `packages/db/src/rls/*.sql` with `ENABLE` +
`FORCE ROW LEVEL SECURITY` and the standard policy
`USING/WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)`. Staff
cross-tenant rows are reached only through `withPlatformTx` (BYPASSRLS owner role), so RLS protects the
customer path and the staff path is gated by `pa` + capability + audit.

**Immutability trigger.** Add a `BEFORE UPDATE` trigger that **rejects any transition out of a terminal
status** (`executed`, `rejected`, `expired`) and rejects edits to `params`/`content_hash`/`requested_by` once
set — the row's request is frozen (params-drift defence at the storage layer; see §10).

### 8.2 Tables reused (no schema change)

- `jit_elevations` / `/admin/elevations` — precondition for JIT-flagged ops (read-checked at create/execute).
- `platform_audit_log` — written by `withPlatformTx` on approve/reject/execute (staff).
- `audit_log` (`schema/billing.ts:169`, via `packages/core/src/compliance/writeAudit.ts`) — customer surface.
- `match_links.review_status` (`auto|pending|confirmed|rejected`) — the dedup approvals **drive** these.
- `retention_class_policies.mode` — `retention_enforce_flip` targets `shadow→enforce`.
- `enrichment_jobs.cost_micros`/`charged` — worst-case spend computed from estimate, charged-on-success at
  execute.
- `contacts.deleted_at` — `bulk_delete` sets the DSAR tombstone (re-derivable → reversible).

### 8.3 Tx wrappers used

| Path | Wrapper | Why |
|---|---|---|
| Staff create/approve/reject/execute | **`withPlatformTx`** (`client.ts:121`) | audited, BYPASSRLS, cross-tenant; mutation + `platform_audit_log` atomic |
| Customer create/approve/reject/execute | **`withTenantTx`** (`client.ts:74`) | RLS-scoped, fail-closed; `audit_log` written in-tx |
| Impact preview (read-only) | `withTenantTx` (S2) / `withPlatformTx` read (S1) | no mutation; reuses estimate readers |

---

## 9. API Requirements

All under `apps/api` (Hono). Shared Zod from `@leadwolf/types`, parsed at the edge with `safeParse`,
responses re-validated with `parse`. RFC 9457 problem envelope (`middleware/error.ts`). Scope **always** from
the verified token (`c.get('tenantId')`/`workspaceId`/`claims.sub`), **never** the body.

### 9.1 Staff endpoints (`/api/v1/admin/data/approvals/*`)

Middleware chain on all: `authn` → `platformAdmin` (`pa===true`) → `requireStaffRole` → `requireCapability(...)`.

**`POST /api/v1/admin/data/approvals/create`** — `requireCapability` = the op's *request* cap (e.g.
`data:manage`). If the op is JIT-flagged, a valid `jit_elevations` grant is additionally required.

```ts
// request
{ operation: ApprovalOperation,        // enum
  targetTenantId: string,              // uuid (validated against op)
  targetWorkspaceId?: string,          // uuid | omitted for tenant-wide
  params: <op-specific Zod>,           // e.g. bulkDeleteParams { selection, … }
  reason: string }                      // ≥10 chars, audited
// response 201
{ id, operation, status: 'pending',
  impact: { rowsAffected, classesAffected?, sampleDiff },
  worstCaseSpendMicros, reversible, expiresAt, contentHash }
// errors: ValidationError(422) bad params; ForbiddenError(403) missing cap/elevation;
//         ProviderBudgetExceededError(429) if worst-case spend exceeds tenant ceiling
```

**`POST /api/v1/admin/data/approvals/approve`** — `requireCapability('data:review')` **plus a server-side
`requester != approver` (maker≠checker) check**.

```ts
{ id: string, reason: string }                  // reason mandatory, audited
// → 200 { id, status: 'approved', approverId, decidedAt }
// errors: NotFoundError; ForbiddenError(403) SELF-APPROVAL (approver==requester) or missing cap;
//         ValidationError(422) not pending / expired
```

**`POST /api/v1/admin/data/approvals/reject`** — `requireCapability('data:review')` (+ maker≠checker). Same
shape; → `rejected`.

**`POST /api/v1/admin/data/approvals/execute`** — `requireCapability` = the op's *execute* cap;
**`Idempotency-Key` accepted but the approval `id` is the real idempotency key** (`uniq_approval_executed_once`).

```ts
{ id: string }
// → 200 { id, status: 'executed', executedAt,
//         result: { perRecord: [{ recordId, status:'ok'|'failed', code? }], correlationToken } }
// errors: ValidationError(422) not 'approved' / expired / content_hash drift (code DATA_SELECTION_DRIFT);
//         ForbiddenError(403) approver revoked / missing cap;
//         Conflict-style replay: returns the FIRST result on retry (never re-executes)
```

**`GET /api/v1/admin/data/approvals`** — `requireCapability('data:read')`. Keyset pagination
(`packages/types/src/search.ts`: `cursor?`, `limit 1..200 default 50` → `nextCursor`). Filters:
`status`, `operation`, `targetTenantId`, `mine=awaiting|requested`.

**`GET /api/v1/admin/data/approvals/:id`** — `data:read`. Returns the full frozen request + impact + decision
trail.

### 9.2 Customer endpoints (`/api/v1/.../approvals/*`)

Same four verbs under the customer tree; middleware `authn` → `requireOrgRole(...)`; `withTenantTx`; scope
from token; op set limited to the Surface-2 subset (§5.4). Request cap maps to `org_role` (e.g. `admin`
requests, `owner` approves; `owner` may not approve own request — SoD applies identically).

### 9.3 Direct-op guard

The destructive routes (retention `PUT`, bulk delete, dedup merge, export, over-threshold enrich) gain a guard
that **refuses execution unless invoked by the approval executor with an `approved` request id**. This closes
gap F (no bypass) — the approval is the *only* door.

---

## 10. Edge Cases & Failure Scenarios

1. **Self-approval (maker == checker).** Blocked three ways: the `approval_maker_ne_checker` CHECK constraint,
   an explicit `approver_id !== requested_by` check in the approve/reject handler (→ `ForbiddenError` 403,
   code `SELF_APPROVAL_FORBIDDEN`), and the UI disabling the buttons. Defence in depth — the DB constraint is
   authoritative.
2. **Expiry.** `expires_at` (create + TTL, e.g. 48h). A daily/periodic sweep (a leader-locked sweep in
   `apps/workers`, sibling to `data-retention-sweep`) flips lapsed `pending` rows to `expired`. Approve/execute
   on an expired row → `ValidationError` 422 `APPROVAL_EXPIRED`. Expiry is also checked lazily at
   approve/execute so a stale row is never actionable even before the sweep runs.
3. **Double-execute race.** Two concurrent `execute` calls: the transition to `executed` is guarded by
   `uniq_approval_executed_once` + an `UPDATE … WHERE status='approved'` returning-zero-rows check inside the
   tx. The loser sees zero rows updated and **replays the first execution's stored `execution_result`**
   ([`02` §4.19](./02-Enterprise-Research.md#419-error-handling)) — never a second mutation. The approval id is
   the idempotency key.
4. **Params drift between request and execute.** The target dataset changes after preview (rows added/removed,
   a contact already deleted). At execute we recompute `content_hash` over the live selection; mismatch →
   `ValidationError` 422 `DATA_SELECTION_DRIFT`, the request is **not** executed, and the operator must
   re-request with a fresh preview. The immutability trigger guarantees the stored `params`/`content_hash`
   were never tampered with.
5. **Revoked approver.** Capabilities resolve per-request from `platform_staff` (`requireStaffRole` → immediate
   revocation, no stale-JWT window). If the approver's `data:review` was revoked between approve and execute,
   execute still proceeds (the *decision* was valid when made) — but if the approver is revoked *before*
   deciding, the approve call fails. For belt-and-braces on irreversible ops, execute re-checks that the
   approver was a valid staff member at decision time (recorded), not at execute time.
6. **Requester loses capability before execute.** Execute checks the *executor's* current execute cap, not the
   requester's — so a departed requester does not strand an approved, time-sensitive op; any holder of the
   execute cap may run an already-approved request (still SoD-clean because approval is locked in).
7. **Worst-case spend exceeds tenant budget at execute.** Even with approval, execute re-checks the tenant
   budget (`ProviderBudgetExceededError` 429); approval authorizes the *plan*, not an overrun. Charge-on-success
   only ([`08`](./08-Data-Enrichment-Workflow.md)).
8. **Partial execution failure.** Per-record status array; failed records go to a separate failed-results
   artifact with the echoed correlation token; the request lands in `execute_failed` with `execution_result`
   populated, and is **safe to retry** (idempotent re-execute resumes only the unprocessed/failed records).
   Bill only the 200s.
9. **Irreversible op (retention enforce, export).** UI and API both mark `reversible=false`; the confirm
   `Dialog` requires re-typing the operation name and a reason; `super_admin` (not merely `data:review`) is
   required to approve `retention_enforce_flip`. There is no undo — so the gate is the safety.
10. **Tenant deleted / workspace archived between request and execute.** Execute resolves scope; if the target
    tenant/workspace is gone, `NotFoundError`, request auto-`expired`.
11. **Cross-tenant leak via body.** The `targetTenantId` in the body is validated but scope for *audit and
    isolation* is enforced by `withPlatformTx`'s explicit `tenantId`/`workspaceId` args and the `pa` claim —
    a customer-surface request can never widen beyond its token's `workspace_id` (RLS fail-closed).

---

## 11. Testing Strategy

**Unit (`packages/core`, `packages/types`):**
- `computeImpact` is pure and **non-mutating** — assert no rows change for every op; assert `content_hash`
  is stable for identical selections and differs on drift.
- Registry: every `ApprovalOperation` has caps, JIT flag, reversible flag, and a Zod params schema; the enum
  is closed.
- Worst-case spend math (`enrich_with_spend`) matches `estimate.ts`.
- SoD predicate: `approver_id !== requested_by`.

**Integration (`apps/api`, route + db):**
- Full lifecycle: create→approve→execute happy path returns `executed` with a per-record result.
- Self-approval rejected (403) at the handler **and** the CHECK constraint (insert a violating row directly →
  DB error).
- Expiry: approve/execute on expired → 422; sweep flips pending→expired.
- Double-execute: two concurrent executes → exactly one mutation, loser replays first result.
- Params drift: mutate the dataset between create and execute → 422 `DATA_SELECTION_DRIFT`, no mutation.
- Direct-op guard: calling retention `PUT`/bulk delete *without* an approved request → rejected.
- Idempotency: same approval id executed twice → identical response, single mutation.

**Itest (full stack, gated CI):**
- Staff path writes a `platform_audit_log` row in the **same** transaction as the mutation (assert atomicity:
  force the mutation to fail → no audit row, no execution).
- Customer path writes `audit_log` and respects RLS.

**Mandatory tenant-isolation test (data is written → required by project precedence):**
- An approval requested/approved in workspace A can **never** execute against workspace B's rows. Drive the
  customer endpoints with workspace-A's token, target a workspace-B `id`, assert RLS fail-closed (empty/forbidden),
  and assert no row in B changed. Repeat for the staff path asserting the `withPlatformTx` scope args and `pa`
  gate are the only widening path and that it is audited. This is the non-negotiable isolation test
  ([`12`](./12-Security-and-Compliance.md)).

---

## 12. Rollout & Migration Plan

- **Flag.** `APPROVAL_WORKFLOW_ENABLED` (`packages/config/src/env.ts`) default `false`. Per-tenant
  `feature_flags` override (`approval_workflow_enabled`) resolves override→global→default, **fail-closed**
  (`isFlagEnabledForTenant`). The `data:review` capability is seeded but the approve action stays dark until GA.
- **Migration.** `~0035` is **additive** (new table + enum + policy + trigger); no backfill of existing data.
  Apply via `applyMigrations.ts` (bootstraps roles); `meta/_journal.json` updated by `drizzle.config.ts`.
- **Shadow.** Flag on for internal tenant only; approvals are *created and approved* but execute is wired to a
  **dry-run** that produces the per-record result without committing the destructive op — validates impact
  math and the queue UX against real data with zero blast.
- **Canary.** Enable execute for the **reversible** ops first (`dedup_merge`, `bulk_delete` tombstone) on 1–2
  design-partner tenants; keep the irreversible ops (`retention_enforce_flip`, `bulk_export`) dry-run.
- **GA.** Enable all ops; flip the destructive routes' direct-op guard to **enforce** (no bypass). Graduate
  `retention_enforce_flip` last, in lockstep with the Phase-3+ retention enforce rollout
  ([`12`](./12-Security-and-Compliance.md), [`14` Phase 3+](./14-Implementation-Roadmap.md)).
- **Rollback.** Because the gate is additive and fail-closed, disabling the flag reverts to today's behaviour
  (direct ops) without data migration; in-flight `pending` rows simply expire.

---

## 13. Success Metrics & Acceptance Criteria

**Metrics (feed [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md)):** % of destructive
ops that went through an approval (target 100% at GA); median time-to-decision; self-approval attempts blocked
(should be >0 and all rejected); drift-rejected executes; expired-request rate; worst-case-spend vs actual
spend delta on `enrich_with_spend`; zero un-audited executions.

**Acceptance criteria (testable checklist):**

- [ ] The closed enum in `packages/types/src/staffCapability.ts` carries exactly the four data caps
      (`data:read`/`data:manage`/`data:review`/`data:export`, 16 → 20); the approve/reject action is gated by
      `data:review` **plus** a server-side `requester != approver` check, and `super_admin` implies all four.
- [ ] `approval_request` table, `approval_status` enum, RLS policy, immutability trigger, and
      `uniq_approval_executed_once` index ship in migration `~0035` with `_journal.json` updated.
- [ ] Every `ApprovalOperation` in the registry declares request cap, JIT flag, approve cap, reversible flag,
      and a Zod `params` schema exported from `@leadwolf/types`.
- [ ] `POST .../approvals/create` computes impact + worst-case spend **without mutating** and freezes
      `params`+`content_hash`.
- [ ] A requester **cannot** approve their own request (DB CHECK + handler 403 + disabled UI), proven by test.
- [ ] `execute` is idempotent on the approval id: a second call replays the first result and never mutates twice.
- [ ] `execute` recomputes `content_hash`; on drift it returns 422 `DATA_SELECTION_DRIFT` and does **not** run.
- [ ] Expired requests cannot be approved or executed; a leader-locked sweep flips `pending→expired`.
- [ ] Staff execute writes the mutation + `platform_audit_log` in **one** `withPlatformTx`; customer execute
      uses `withTenantTx` + `audit_log`.
- [ ] The tenant-isolation test passes: an approval can never execute against another workspace's rows.
- [ ] Destructive routes (retention enforce flip, bulk delete, dedup merge/split, bulk export, over-threshold
      enrich) **refuse** direct execution and require an approved request id.
- [ ] Admin Approval Queue + Detail render all four states via `StateSwitch`, use `@leadwolf/ui` components
      and `var(--tp-*)` tokens, and meet WCAG 2.2 AA (no colour-only danger signalling).
- [ ] Surface-2 customer approvals work via `org_role` for the allowed op subset, RLS-enforced.
- [ ] Whole workflow is dark behind `APPROVAL_WORKFLOW_ENABLED` (default false), fail-closed per tenant.

---

> **Cross-links:** [`01-Current-State-Analysis`](./01-Current-State-Analysis.md) ·
> [`02-Enterprise-Research`](./02-Enterprise-Research.md) · [`03-Gap-Analysis`](./03-Gap-Analysis.md) ·
> [`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) ·
> [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) ·
> [`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md) ·
> [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) ·
> [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) ·
> [`12-Security-and-Compliance`](./12-Security-and-Compliance.md) ·
> [`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md) · [`README`](./README.md)
