# 25 — Departments, Teams & Workspaces

> The framework for **department-specific experiences**: teams inside a workspace, department personas,
> intra-workspace data-access controls, per-team budgets, dashboards, reporting, and automation — the
> decided **"teams in one workspace"** model ([ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)).
> Per-department detail lives in [departments/](./departments/).

## 1. Model & scope

A **team** (a.k.a. **department**) is an **intra-workspace** grouping. Departments **share** the
workspace's RLS-scoped data pool ([ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md),
`H9` unchanged) and are segmented by **persona + role + permissions + visibility** — not by a new tenancy
tier and not by hard isolation ([ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)).

> **Scope guardrail.** Non-revenue departments (Operations/RevOps, Compliance, Finance, People/HR,
> Administration) **govern the GTM platform** — data quality, integrations, automation,
> suppression/DSAR/consent, credit budgets/spend/ROI, seats/roles/SSO/SCIM — they are **not** standalone
> ERP/HRIS/ticketing suites. Revisit if the user wants full back-office modules.

## 2. Schema (`teams`, `team_members`, enums)

- **`teams`**: `id, tenant_id, workspace_id, department_type, name, parent_team_id?, settings jsonb,
  created_at`.
- **`team_members`**: `id, team_id, workspace_id, user_id, team_role, created_at`, `UNIQUE(team_id,
  user_id)`. A `team_member` implies a `workspace_member` of that workspace.
- **`department_type`** = `sales|sdr|bdr|marketing|customer_success|support|operations|compliance|finance|
  people_hr|administration|custom`.
- **`team_role`** = `manager|lead|member|viewer` — **orthogonal** to the workspace role (`owner/admin/
  member/viewer`, `H8`): workspace role governs workspace settings/data capability; team role governs
  department views, dashboards, and team management.

## 3. Personas & navigation (H11 intact)

A member's **active team** + `department_type` selects a **persona** that customizes the existing
**6-destination** surface (Home · Prospect · Sequences · Inbox · Reports · Settings, `11 §2`) — **no new
top-level destinations, Credits still not a tab** (`H11`):

- **Home** → the department's default **dashboard** (§6).
- **Prospect** → persona default **filters / saved views / segments** (`24`).
- **Reports** → department **report pack** (§6).
- A **team switcher** (next to the workspace switcher) changes the active persona; multi-team users switch
  freely. Governance departments surface mainly through Reports + Settings (+ `apps/admin` for staff).

## 4. Data-access & visibility (within the shared pool)

- Overlay rows carry `owner_user_id`, `assigned_team_id`, and **`visibility`** (`record_visibility` =
  `workspace|team|owner`, default `workspace`).
- `team`/`owner` visibility restricts read/write to that team/owner via an **app-layer authz filter** (and
  optional extra RLS predicate) layered on the workspace RLS (`H18`) — used by Finance/HR/Compliance for
  sensitive records. This is **authz**, not a new RLS scope; isolation primitives are unchanged.
- **Territory/assignment**: records assign to owners/teams (manually or via automation `27`), powering
  rep-vs-manager views and routing.

## 5. Per-team credit budgets

- **`team_credit_budgets`**: `team_id, period, budget_credits, spent_credits, hard_cap bool`. A
  tenant/RevOps allocates a slice of the **tenant** credit pool ([ADR-0007](./decisions/ADR-0007-per-workspace-reveal-and-credit-counter.md))
  to a department.
- Enforced **at reveal time** next to the tenant counter (`H2`): a `hard_cap` team blocks at budget;
  soft budgets warn and report. Resolves the prior tenant-pool-vs-allocation gap (`07 §5`).

## 6. Dashboards & reporting

- Each department gets a **dashboard** (KPI tiles + trends) and a **report pack** (Reports surface,
  `11 §4.5`), built on ClickHouse/PostHog read models (`18 §6`). Manager personas get **team rollups +
  per-member** breakdowns + coaching views; rep personas get their own pipeline/activity.
- KPIs are department-specific (see [departments/](./departments/)); all reporting respects visibility
  (`§4`).

## 7. Automation & collaboration

- Department workflows run on the **automation engine** (`27`): lead routing, hand-offs (SDR→AE),
  churn-risk plays, signal-to-play — scoped per team with per-team policies (`12`).
- Collaboration: shared **saved views/segments** (`24 §5`), Inbox assignment/@mention (`11 §4.4`), notes,
  and tasks — team-scoped where visibility requires.

## 8. Permissions & entitlements

- **Feature gating** combines workspace role × team role × plan tier × feature flags (`13 §3`): e.g. only
  managers see team rollups; viewers can't reveal/send; Finance manages budgets; Compliance manages
  suppression/DSAR.
- Per-team **automation/export/AI** policies live in settings (`12`); entitlements resolve **strictest-wins**
  (mirrors the auth-policy pattern, `ADR-0018`).

## 9. The 11 department modules

Detailed specs (to a consistent template) in [departments/](./departments/):

| # | Module | Type |
|---|---|---|
| 01 | [Sales](./departments/01-sales.md) | revenue |
| 02 | [SDR](./departments/02-sdr.md) | revenue |
| 03 | [BDR](./departments/03-bdr.md) | revenue |
| 04 | [Marketing](./departments/04-marketing.md) | revenue |
| 05 | [Customer Success](./departments/05-customer-success.md) | revenue |
| 06 | [Support](./departments/06-support.md) | revenue-adjacent |
| 07 | [Operations / RevOps](./departments/07-operations-revops.md) | governance |
| 08 | [Compliance](./departments/08-compliance.md) | governance |
| 09 | [Finance](./departments/09-finance.md) | governance |
| 10 | [People / HR](./departments/10-people-hr.md) | governance |
| 11 | [Administration](./departments/11-administration.md) | governance |

## Links
- **Links to:** [02 §4/§5](./02-architecture.md), [03 §4/§9](./03-database-design.md), [05 §1/§2](./05-features-modules.md),
  [07 §5](./07-billing-credits.md), [09 §4](./09-api-design.md), [11 §2](./11-information-architecture.md),
  [12 §3](./12-settings.md), [24](./24-advanced-search-exploration-ux.md), [27](./27-workflow-automation-engine.md),
  [departments/](./departments/), [ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [05](./05-features-modules.md), [11 §2](./11-information-architecture.md),
  [12 §3](./12-settings.md), README

## Open questions
1. Nested teams (`parent_team_id`) depth + rollup semantics at GA vs. flat teams first.
2. Default personas/visibility per `department_type` (seed config).
3. Cross-team record reassignment + audit UX (`27`/`08`).
