# ADR-0022 — Departments & teams as intra-workspace segmentation

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context doc:** [25-departments-teams-workspaces.md](../25-departments-teams-workspaces.md), [03-database-design.md](../03-database-design.md)
- **Amends:** none structurally — this is **additive** to [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md) (tenancy) and [ADR-0019](./ADR-0019-global-identity-and-tenant-membership.md) (identity); neither is reopened.

## Context

LeadWolf must give large customer organizations **department-specific experiences** — Sales, SDR, BDR,
Marketing, Customer Success, Support, Operations/RevOps, Compliance, Finance, People/HR, and
Administration — each with its own tabs, dashboards, workflows, permissions, reporting, and management
tools, at **thousands of concurrent users per workspace**. The current model
([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)) is a single generic workspace with four roles
(`owner`/`admin`/`member`/`viewer`) and **no department concept** (`00 §6` defines a workspace as
"team/brand/region/client"). We must add departments without fragmenting the data or re-opening the
tenancy/identity model.

Three structural options were on the table (see `25 §2`): (A) a department is a **workspace** carrying a
type; (B) a new **department tier** between tenant and workspace; (C) **teams inside one workspace** that
share its data pool. The user chose **(C)**.

## Decision

A **team** (a.k.a. **department**) is an **intra-workspace** grouping. Departments do **not** get a new
tenancy tier and do **not** get hard data isolation from each other — they share the workspace's single
RLS-scoped data pool ([ADR-0006](./ADR-0006-per-workspace-multitenant-model.md), `H9` unchanged).

- **`teams`** (workspace-scoped): `id, tenant_id, workspace_id, department_type, name, parent_team_id?,
  settings jsonb, created_at`. `department_type` is the enum
  `sales|sdr|bdr|marketing|customer_success|support|operations|compliance|finance|people_hr|administration|custom`.
- **`team_members`**: `id, team_id, workspace_id, user_id, team_role, created_at`, `UNIQUE(team_id, user_id)`.
  **`team_role`** = `manager|lead|member|viewer` — a department-scoped role **orthogonal** to the
  workspace role (`H8`): the workspace role still governs what a user can do to workspace settings/data;
  the team role governs department views, dashboards, and team-management.
- **Persona experience:** a member's **active team** (+ `department_type`) drives a **persona** — the
  default Home dashboard, default lists/filters/segments, emphasized tabs, and available
  workflows/automations. Personas customize the existing **6-destination** surface; they do **not** add
  top-level destinations (`H11` intact, `11 §2`).
- **Data-access controls (within the shared pool):** overlay rows (`contacts`/`accounts`) gain
  `owner_user_id`, `assigned_team_id`, and `visibility` (`record_visibility` =
  `workspace|team|owner`, default `workspace`). When a record's visibility is `team`/`owner`, an
  **app-layer authz filter** (and an optional additional RLS predicate) restricts read/write to that
  team/owner — used by sensitive departments (Finance/HR/Compliance). This is **authz layered on** the
  workspace RLS, **not** a new RLS scope.
- **Per-team credit budgets:** `team_credit_budgets` (`team_id, period, budget_credits, spent_credits,
  hard_cap bool`) lets a tenant/RevOps allocate a slice of the **tenant** credit pool
  ([ADR-0007](./ADR-0007-per-workspace-reveal-and-credit-counter.md)) to a department, enforced at reveal
  time alongside the tenant counter. The tenant pool remains the system of record; budgets are a
  **soft/hard allocation overlay** (resolves the prior tenant-pool-vs-allocation gap).
- **Authn is unchanged:** team/persona is **authorization**, not identity; JWT claims
  (`sub/tid/wid`) are untouched ([ADR-0019](./ADR-0019-global-identity-and-tenant-membership.md),
  [17](../17-authentication.md)). Switching team is an app-state change, not a token re-issue.

## Rationale

Option (C) reuses every load-bearing primitive already designed — workspace RLS, the role model, the
4-scope settings, the 6-destination IA, the tenant credit counter — and adds only intra-workspace authz
+ persona configuration. It ships fastest, carries the least risk, and avoids reopening two locked ADRs.
Shared data within a workspace is the correct default for a revenue org (Sales/SDR/Marketing collaborate
on the same accounts); the `visibility` scopes cover the few departments that need privacy.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **(C) Teams inside one workspace (this ADR)** | Chosen | Reuses RLS/roles/IA/credits; additive; fastest; user's choice. |
| (A) Workspace = department | Rejected | Forces cross-workspace data duplication for collaborating revenue teams; heavier nav/credit changes. |
| (B) New department tier (tenant→department→workspace) | Rejected | Reopens [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md)/[ADR-0019](./ADR-0019-global-identity-and-tenant-membership.md); new RLS scope; large schema/auth churn for no near-term need. |

## Consequences

- **Positive:** department personas, dashboards, per-team budgets, and reporting with minimal new
  schema; collaborating teams share accounts/contacts by default; isolation primitives unchanged.
- **Negative (accepted):** departments are **not** hard-isolated — a `workspace`-visibility record is
  visible to all teams in the workspace; strict separation requires `team`/`owner` visibility per record
  or a separate workspace. Per-team budgets add a second check on the reveal path (kept cheap, in-tx).
- **Mitigation:** default `visibility=workspace` keeps the common case simple; sensitive departments set
  stricter visibility; budgets are an in-transaction counter check next to the tenant counter (`H2`).

## Revisit if

A segment needs **hard** inter-department data isolation or department-level billing as a first-class
unit — then revisit option (A)/(B) for that segment (a department becomes its own workspace, or a
department tier is introduced).
