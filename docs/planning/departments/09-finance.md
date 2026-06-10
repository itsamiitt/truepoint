# departments/09 — Finance

> The governance persona that **governs spend**: credit budgets, usage/cost, ROI, and billing oversight
> across teams. Surfaces billing ([07](../07-billing-credits.md)) + FinOps ([19 §8](../19-observability-reliability.md)).
> Framework: [25](../25-departments-teams-workspaces.md).

## 1. Purpose & users
Finance/billing-ops manage the tenant credit pool, per-team budgets, invoices/top-ups, and unit economics.
**Users:** Finance, billing-ops. `department_type = finance`. (Governs platform spend — not a general AP/GL
system, `25 §1`.)

## 2. Persona & surfaces (6 destinations)
- **Home** → spend/budget dashboard (§3). **Settings → Billing** → credit pool, top-ups, plan,
  **per-team budgets** (`12 §4`, `07`). **Reports** → cost/ROI pack. Read-broad on spend, minimal PII.

## 3. Dashboard & KPIs
Credit balance + burn rate, spend by team vs. **budget** (`team_credit_budgets`), cost-per-reveal /
cost-per-verified-record, AI cost (`23`), credit-back recovered (`H13`), ROI (pipeline/$ spent), forecast
to depletion.

## 4. Workflows & automations (`27`)
- **Budget alerts**: team nearing/over budget → notify + (hard-cap) block reveals (`H2`).
- **Top-up automation**: low balance → notify/auto-purchase (`07 §4`).
- **Anomaly detection**: spend spike → alert (`19 §8`).
- **Period close**: usage report export to finance systems (`26`).

## 5. Permissions, visibility & budgets
Finance: manage tenant billing + **set/adjust per-team budgets**; read cost everywhere; **no contact-PII
reveal** needed (visibility minimized). Typically tenant-owner/billing capability (`H8`, `12 §4`).

## 6. Reporting
Spend by team/period, unit economics, ROI, credit-back, invoice/top-up history, forecast; reconciles
against FinOps cost attribution (`19 §8`).

## 7. Collaboration
Sets budgets with RevOps (`07`), reviews retention cost with Compliance (`08`), seat costs with HR/Admin
(`10`/`11`).

## Links
- **Links to:** [25](../25-departments-teams-workspaces.md), [07](../07-billing-credits.md),
  [19 §8](../19-observability-reliability.md), [12 §4](../12-settings.md), [27](../27-workflow-automation-engine.md),
  [26](../26-integrations-data-delivery.md)
- **Linked from:** [25 §9](../25-departments-teams-workspaces.md), [departments/README](./README.md)
