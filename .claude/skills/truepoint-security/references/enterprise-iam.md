# Enterprise Identity and Access Management

"Enterprise-grade" sold to organisations has a specific identity bar that a single
JWT with a hardcoded `customer|staff|admin` role does not meet. Enterprises bring
their own identity provider, expect users to be provisioned and deprovisioned
automatically, and need access control richer than three global roles. This file is
that model. It is the identity half of access control; the enforcement half (RLS,
record-level visibility, mass-assignment) is in `access-control.md`.

---

## Single Sign-On (SSO): SAML and OIDC

Enterprise customers authenticate through their own identity provider, not a
TruePoint-specific password:

- **SAML 2.0 and OIDC** are both supported — these are the two protocols enterprise
  IdPs (Okta, Entra/Azure AD, Google Workspace, Ping) speak. An enterprise tenant
  configures their IdP and their users log in through it.
- **SSO is configured per-org.** Each enterprise tenant has its own IdP connection;
  the login flow routes a user to their org's IdP. The centralised auth service (see
  **truepoint-architecture** auth) brokers this; the app never handles IdP
  credentials directly.
- **Just-in-time (JIT) provisioning** can create a user on first SSO login (with a
  default role per the org's config), so access follows the IdP without manual setup.
- **The OIDC/SAML flow is validated** — state/nonce checked, assertions verified,
  tokens validated — the same outbound/callback discipline as any OAuth flow (see
  `integrations.md`).

> **Implementation status:** SSO is the **target**, not yet met. The OIDC/SAML adapters
> in `packages/auth/src/sso/providers.ts` are **unwired — they throw "not configured"**
> (see `docs/planning/28-enterprise-readiness-audit.md` §3.1). Keep the mandate; build
> per-org IdP brokering before claiming SSO support to a buyer.

---

## SCIM Provisioning and Deprovisioning

SSO handles *authentication*; SCIM handles *lifecycle* — who exists and what they
can do, synced from the customer's IdP:

- **SCIM provisioning** creates/updates users and group memberships from the
  customer's directory automatically. The customer manages people in their IdP; SCIM
  reflects it into TruePoint.
- **Deprovisioning is the security-critical half.** When a customer removes a user
  from their directory (someone leaves the company), SCIM **deactivates that user in
  TruePoint promptly** — their access is revoked, their sessions/tokens invalidated.
  A departed employee retaining CRM access is a real breach vector; automated
  deprovisioning closes it.
- **Owned records are reassigned, not orphaned**, on deprovisioning (see
  **truepoint-data** ownership-and-sharing) — losing access must not lose the data.

> **Implementation status:** SCIM user provisioning now exists — the `scim_tokens` table
> (+ RLS in `packages/db/src/rls/scim.sql`), token mint/list/revoke
> (`apps/api/src/features/settings/identityRoutes.ts`), and the `/scim/v2/Users` endpoints
> (`apps/api/src/features/scim/`). Still missing: **group-to-role mapping** (`/scim/v2/Groups`
> is TODO — gap **G-AUTH-4**, `docs/planning/28-enterprise-readiness-audit.md` §3.1). Keep the
> mandate for the remaining group mapping, and verify the deprovisioning path is fully wired.

---

## Roles Are Data, Not Hardcoded Enums

The original three-role enum (`customer|staff|admin`) baked into the token cannot
express what organisations need. Roles and permissions are **data**:

- **`customer|staff|admin` is the *surface* tier** (which app a user belongs to —
  see **truepoint-architecture** auth), not the authorization model. Within the
  customer surface, an **org defines its own roles** (e.g. Rep, Team Lead, Manager,
  RevOps Admin) with their own permission sets.
- **Permissions attach to roles as data**, so an org admin can define/adjust roles
  without a code change, and adding a permission doesn't mean touching a token enum.
- **Custom roles** per enterprise tenant are supported where their plan allows.
- The frontend permission helper and the server check read this model; the server
  check is the boundary (see `access-control.md`, **truepoint-architecture**
  shared-packages).

> **Implementation status:** data-driven granular tenant roles are the **target** and
> are currently **MISSING** (gap **G-AUTH-10**, Critical — `docs/planning/28-enterprise-readiness-audit.md`
> §3.1). The model today is only an `is_tenant_owner` **boolean**, not org-defined roles
> with permission sets. **Service accounts** are also missing (gap **G-AUTH-5**). Keep
> the mandate; do not weaken it to the boolean — build the data-driven role/permission
> model and machine identities.

---

## Field-Level Permissions

Beyond which *records* a user sees (ownership/sharing — **truepoint-data**) and which
*actions* they may take (roles), some fields are restricted within a record:

- A role may see a prospect but not its deal value; a rep may edit notes but not the
  owner field. **Field-level permissions** express this.
- Enforced server-side in both directions: **on read**, the response is shaped to
  omit fields the role can't see (see `data-protection.md`, `api-security.md`); **on
  write**, the allowlist excludes fields the role can't set (mass-assignment —
  `access-control.md`).
- Different roles therefore get different response shapes for the same record — by
  design.

---

## Sessions, MFA, and Org Policy

- **MFA** is supported (and enforceable by org policy) for tenants not relying on
  their IdP's MFA. Enterprise tenants often enforce it.
- **Session policy** (timeout, concurrent sessions, IP allowlisting) can be set per
  org where their plan/contract requires it.
- **Token/session invalidation** on deprovisioning, role change, or password reset is
  immediate — a stale session must not outlive the access it represents (token
  refresh discipline — **truepoint-architecture** auth).

---

## Audit of Identity Events

Identity changes are audited (feeding `compliance.md`'s access-review evidence):
logins (especially SSO), provisioning/deprovisioning, role changes, permission
grants, and privileged/cross-tenant access (see `access-control.md`). "Who could
access what, when, and who changed it" must be reconstructable.

---

## Checklist

- Is SSO (SAML/OIDC) supported and configured per-org, with validated assertions and
  optional JIT provisioning?
- Does SCIM provision and — critically — **deprovision** users promptly, invalidating
  access and reassigning owned records?
- Are roles and permissions data-driven (org-defined, custom roles), not a hardcoded
  token enum — with `customer|staff|admin` only the surface tier?
- Are field-level permissions enforced on both read (response shaping) and write
  (allowlist)?
- Are MFA, session policy, and immediate invalidation on deprovision/role-change
  supported where required?
- Are identity events audited for access review?
