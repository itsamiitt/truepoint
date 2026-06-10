# Department Modules

Per-department specs for LeadWolf's **"teams in one workspace"** model — the framework is
[25 — Departments, Teams & Workspaces](../25-departments-teams-workspaces.md)
([ADR-0022](../decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)). Each department is a
**team** (`department_type`) inside a workspace, expressed as a **persona** over the shared 6-destination
surface (`H11`), with role-based permissions, record-visibility (`H18`), per-team credit budgets, a
dashboard, a report pack, and automation plays (`27`).

Each module follows the same template: **Purpose & users · Persona & surfaces · Dashboard & KPIs ·
Workflows & automations · Permissions, visibility & budgets · Reporting · Collaboration**.

| # | Module | Type | Primary persona |
|---|---|---|---|
| 01 | [Sales](./01-sales.md) | revenue | AE / Sales manager |
| 02 | [SDR](./02-sdr.md) | revenue | SDR / SDR manager |
| 03 | [BDR](./03-bdr.md) | revenue | BDR / BDR manager |
| 04 | [Marketing](./04-marketing.md) | revenue | Demand-gen / ABM |
| 05 | [Customer Success](./05-customer-success.md) | revenue | CSM / CS manager |
| 06 | [Support](./06-support.md) | revenue-adjacent | Support agent / lead |
| 07 | [Operations / RevOps](./07-operations-revops.md) | governance | RevOps / Data-ops |
| 08 | [Compliance](./08-compliance.md) | governance | Compliance officer |
| 09 | [Finance](./09-finance.md) | governance | Finance / billing ops |
| 10 | [People / HR](./10-people-hr.md) | governance | People ops |
| 11 | [Administration](./11-administration.md) | governance | Workspace/tenant admin |

> Governance departments (07–11) **govern the GTM platform** (data, spend, compliance, people, access);
> they are not standalone back-office suites — see the scope guardrail in [25 §1](../25-departments-teams-workspaces.md).
