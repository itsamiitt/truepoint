# departments/11 — Administration

> The governance persona that **configures the workspace/tenant**: security policy, integrations,
> branding, teams setup, and the global guardrails every other department runs inside.
> Framework: [25](../25-departments-teams-workspaces.md).

## 1. Purpose & users
Workspace/tenant administrators own configuration: security/auth policy, SSO/SCIM, integrations, teams,
branding, and feature governance. **Users:** Workspace owner/admin + tenant owner. `department_type =
administration`. Maps to the workspace/tenant **admin** capability (`H8`), not a separate data scope.

## 2. Persona & surfaces (6 destinations)
- **Home** → admin/config dashboard (§3). **Settings** → the full tenant/workspace settings tree (`12`):
  auth policy (`ADR-0018`), SSO/SCIM (`17 §8`), integrations (`26`), teams (`25`), branding, API keys.
  **Reports** → governance/usage overview. (Platform staff use the separate `apps/admin`, `13`.)

## 3. Dashboard & KPIs
Security-policy posture (MFA/SSO/IP, `17`), team/role structure, integration status, API-key/webhook usage
(`12 §5`), feature-flag state (`13 §3`), workspace/seat limits, data-export/audit activity.

## 4. Workflows & automations (`27`)
- **Policy enforcement**: set MFA/SSO/IP allowlist/session policy (strictest-wins, `ADR-0018`).
- **Team/workspace provisioning**: create teams, assign personas/visibility defaults (`25 §3`).
- **Integration governance**: approve/connect CRM/Slack/webhooks (`26`); rotate keys (`19 §5`).
- **Access reviews**: periodic role/seat/visibility review with HR/Compliance.

## 5. Permissions, visibility & budgets
Admin: manage workspace/tenant settings, members/teams, integrations, policies; broad read; reveal as any
member if needed (under budgets). Tenant owner adds billing/limits/SSO/export (`12 §4`, `H8`).

## 6. Reporting
Configuration/governance overview, security adoption, integration health, audit/export activity; the
operational counterpart to platform-staff admin (`13`).

## 7. Collaboration
Sets the guardrails RevOps/Finance/Compliance/HR operate within; coordinates SSO/SCIM with HR (`10`),
billing with Finance (`09`), policy with Compliance (`08`).

## Links
- **Links to:** [25](../25-departments-teams-workspaces.md), [12](../12-settings.md), [17](../17-authentication.md),
  [26](../26-integrations-data-delivery.md), [27](../27-workflow-automation-engine.md), [13](../13-platform-admin.md),
  [ADR-0018](../decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)
- **Linked from:** [25 §9](../25-departments-teams-workspaces.md), [departments/README](./README.md)
