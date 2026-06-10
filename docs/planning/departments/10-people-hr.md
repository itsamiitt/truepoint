# departments/10 — People / HR

> The governance persona that **governs people on the platform**: seats, team membership, onboarding/
> offboarding, and role provisioning across the workspace. Framework: [25](../25-departments-teams-workspaces.md).

## 1. Purpose & users
People-ops manage who is on the platform and in which teams — seat allocation, onboarding/offboarding, and
team/role assignment. **Users:** People-ops/HR admins. `department_type = people_hr`. (Platform
people-governance — **not** a full HRIS/payroll, `25 §1`.)

## 2. Persona & surfaces (6 destinations)
- **Home** → people/seat dashboard (§3). **Settings → Members/Teams** → invites, roles, team membership,
  SSO/SCIM (`12 §4`, `17 §8`). **Reports** → seat/enablement pack. No contact-PII focus.

## 3. Dashboard & KPIs
Seats used vs. licensed, members by team/role, pending invites, onboarding/offboarding queue, MFA/SSO
adoption (`17`), activation/enablement, inactive seats.

## 4. Workflows & automations (`27`)
- **Onboarding**: new hire → invite + team assignment + default persona/views (`25 §3`) + starter tasks.
- **Offboarding**: departure → revoke access, reassign owned records (`assign_owner`), suppress sending
  identity (`08 §6`).
- **Role/seat hygiene**: inactive seat → reclaim alert; SCIM provisioning sync (`17 §8`).

## 5. Permissions, visibility & budgets
People-ops: manage `team_members`/roles/seats + invites + SSO/SCIM; **no contact reveal** (no budget).
Acts with workspace-admin (+ tenant capability for seat limits, `H8`). Does not see private records unless
admin.

## 6. Reporting
Seat utilization, team composition, enablement/activation, security-policy adoption (MFA/SSO); ties to
Finance for seat cost (`09`).

## 7. Collaboration
Provisioning with Admin (`11`), seat budget with Finance (`09`), access reviews with Compliance (`08`).

## Links
- **Links to:** [25](../25-departments-teams-workspaces.md), [12 §4](../12-settings.md), [17 §8](../17-authentication.md),
  [27](../27-workflow-automation-engine.md), [09 Finance](./09-finance.md), [11 Administration](./11-administration.md)
- **Linked from:** [25 §9](../25-departments-teams-workspaces.md), [departments/README](./README.md)
