# departments/06 — Support

> The customer-facing support persona: resolve inbound, keep contact context fresh, and surface
> account/relationship data to agents. Framework: [25](../25-departments-teams-workspaces.md).

## 1. Purpose & users
Support agents handle inbound issues with accurate account/contact context and route escalations.
**Users:** Support agents + leads. `department_type = support`. (Lightweight case/queue surface — **not** a
full ticketing suite, `25 §1`.)

## 2. Persona & surfaces (6 destinations)
- **Home** → support queue/SLA dashboard (§3). **Inbox** → assigned conversations + tasks (the agent's
  driver). **Prospect/Reports** → account lookup + contact verification, support analytics.

## 3. Dashboard & KPIs
Open/assigned cases, first-response + resolution time vs. SLA, reopen rate, CSAT inputs, contact-data
accuracy on active accounts, escalations.

## 4. Workflows & automations (`27`)
- **Assignment/routing** of inbound to agent/lead by skill/load.
- **Escalation**: severity/age threshold → reassign + notify CS/AE.
- **Contact verification**: stale contact on an active account → re-verify (`22`).
- **Status sync**: case events → CRM/Slack (`26`).

## 5. Permissions, visibility & budgets
Agents: read account/contact context, verify; limited reveal under **per-team budget**; leads: routing +
team views. Records can be `visibility=team` (`H18`).

## 6. Reporting
SLA adherence, volume/backlog trends, escalation paths, data-accuracy impact; visibility-scoped.

## 7. Collaboration
Escalate to CS (`05`)/Sales, shared account timeline, @mention + assignment in Inbox.

## Links
- **Links to:** [25](../25-departments-teams-workspaces.md), [27](../27-workflow-automation-engine.md),
  [26](../26-integrations-data-delivery.md), [22](../22-data-quality-freshness-lifecycle.md), [11 §4.4](../11-information-architecture.md),
  [05 Customer Success](./05-customer-success.md)
- **Linked from:** [25 §9](../25-departments-teams-workspaces.md), [departments/README](./README.md)
