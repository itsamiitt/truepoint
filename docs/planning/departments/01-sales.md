# departments/01 — Sales

> The AE/closer persona: work owned accounts, prospect into buying committees, reveal + sequence
> decision-makers, and manage pipeline. Framework: [25](../25-departments-teams-workspaces.md).

## 1. Purpose & users
Account Executives own a book of accounts and turn qualified interest into closed revenue. **Users:** AEs
(persona) + Sales managers (`team_role` `manager`/`lead`). `department_type = sales`.

## 2. Persona & surfaces (6 destinations)
- **Home** → Sales dashboard (§3). **Prospect** → default views for owned/assigned accounts + buying-committee
  filters (`24`). **Sequences/Inbox** → outreach + replies on owned contacts. **Reports** → pipeline pack.
- AEs see **their** owned/assigned records by default (`assigned_team_id`/`owner_user_id`); managers see the
  team rollup (`§5`).

## 3. Dashboard & KPIs
Pipeline by stage, win-rate, avg. deal cycle, meetings booked, accounts touched, reveal→meeting
conversion, credit burn vs. **team budget** (`§5`), data freshness on owned accounts (`22`).

## 4. Workflows & automations (`27`)
- **Lead/account routing** to AE by territory/ICP (`assign_owner`/`assign_team`).
- **SDR→AE hand-off**: on `meeting_booked`, assign account to AE + create task + notify.
- **Buying-committee expansion**: AI suggests + (on approve) reveals additional decision-makers (`23`).
- **Signal-to-play**: funding/job-change on an owned account → recommended play.

## 5. Permissions, visibility & budgets
AEs: reveal/sequence/export on owned + workspace-visible records; managers: reassign + view team.
Sensitive deals can be `visibility=team`/`owner` (`H18`). **Per-team credit budget** governs reveal spend
(`team_credit_budgets`, `H2`).

## 6. Reporting
Pipeline/forecast, activity-to-outcome, per-AE leaderboard, data-health on owned book; ClickHouse-backed
(`18 §6`), visibility-scoped.

## 7. Collaboration
Shared account views/segments (`24 §5`), Inbox assignment + @mention, account notes/tasks, manager coaching
views.

## Links
- **Links to:** [25](../25-departments-teams-workspaces.md), [24](../24-advanced-search-exploration-ux.md),
  [27](../27-workflow-automation-engine.md), [23](../23-ai-intelligence-layer.md), [05 §13](../05-features-modules.md),
  [07 §5](../07-billing-credits.md)
- **Linked from:** [25 §9](../25-departments-teams-workspaces.md), [departments/README](./README.md)
