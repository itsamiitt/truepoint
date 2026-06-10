# departments/07 — Operations / RevOps

> The governance persona that **runs the GTM platform**: data quality, integrations, automation,
> territory/routing design, and process health across all revenue teams.
> Framework: [25](../25-departments-teams-workspaces.md).

## 1. Purpose & users
RevOps/Data-ops own data hygiene, the automation library, integrations, routing rules, and cross-team
process. **Users:** RevOps, Data-ops, Sales-ops. `department_type = operations`. Governs — not isolated.

## 2. Persona & surfaces (6 destinations)
- **Home** → ops control dashboard (§3). **Reports** → data-health + process + economics packs (`22`,
  `19 §8`). **Settings** → automation policies, integrations, routing, dedup rules (`12`). Read-broad
  across the workspace.

## 3. Dashboard & KPIs
`data_quality_score` distribution + freshness (`22`), duplicate/ER review backlog, integration sync health,
automation run success/error (`27`), credit spend by team vs. budget, coverage/match-rate vs. target.

## 4. Workflows & automations (`27`)
- **Routing engine**: design lead/account assignment by territory/ICP/round-robin.
- **Data-hygiene plays**: stale → re-verify; low-quality → enrich; dup → review queue (`22`).
- **Lifecycle automations** across SDR→AE→CS hand-offs.
- **Integration monitors**: sync failure → alert + retry (`26`).

## 5. Permissions, visibility & budgets
RevOps: broad read + manage automations/integrations/routing/dedup + **set per-team credit budgets**
(`team_credit_budgets`, `07 §5`); typically workspace-admin role. Sensitive financial detail deferred to
Finance (`09`).

## 6. Reporting
Cross-team funnel, data-health trends, automation ROI, integration reliability, spend efficiency;
ClickHouse-backed (`18 §6`).

## 7. Collaboration
Sets the shared play/segment/view library for all departments; partners with Finance (budgets),
Compliance (suppression/consent), Admin (provisioning).

## Links
- **Links to:** [25](../25-departments-teams-workspaces.md), [22](../22-data-quality-freshness-lifecycle.md),
  [27](../27-workflow-automation-engine.md), [26](../26-integrations-data-delivery.md), [12](../12-settings.md),
  [07 §5](../07-billing-credits.md), [19 §8](../19-observability-reliability.md)
- **Linked from:** [25 §9](../25-departments-teams-workspaces.md), [departments/README](./README.md)
