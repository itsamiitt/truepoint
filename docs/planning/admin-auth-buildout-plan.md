# Platform Admin + Auth Admin Buildout — Plan

> Working plan for extending TruePoint's internal **Platform Admin** (`apps/admin`) and the
> **Authentication Admin** surfaces (`apps/web` tenant/workspace settings + `apps/auth` IdP), plus
> the role model both depend on. Grounded in the existing code and the truepoint-* skill mandates.

## Context & decisions

The prompt is a generic "Closo / Node-Express, build admin + auth pages, light+dark" template. Reality
in this repo differs; the user confirmed these resolutions:

- **Stack** = the real one: **Bun + Hono** API (`apps/api`, not Express), **Next.js App Router**
  frontends, **Drizzle + Postgres RLS**, **BullMQ/Redis** workers. Code identity stays `@leadwolf/*`.
- **Light theme only** — the design system has no dark mode and the design skill forbids it. The
  prompt's "light AND dark every surface" requirement is **explicitly overridden** by user decision.
- **Surfaces already exist** — we **extend**, not greenfield. Platform Admin has Tenants, System
  Health, Feature Flags (real, audited via `withPlatformTx`); auth has full multi-step login + most
  SSO/SCIM/MFA **schema** (enforcement largely stubbed).
- **Scope** = all four: Phase 0 security fixes → Auth Admin → Platform Admin expansion → Provider API.
- **Role model** = implement the designed granular roles now (ADR-0030 + staff RBAC) + a server-side
  `requireRole()` guard family.

## Two CRITICAL security gaps (Phase 0 — do first)

1. **Cross-tenant auth bypass (live vuln).** `apps/auth/.../org/actions.ts::selectOrg`,
   `workspace/actions.ts::selectWorkspace`, and `packages/auth/src/flow.ts::finalizeLogin` accept a
   client-supplied `tenantId`/`workspaceId` **without a membership check**. Since RLS trusts the JWT
   `tid`/`wid` via the GUC, a forged selection = full cross-tenant read/write. `switchWorkspace.ts`
   already does it right (`workspaceRepository.getRoleForUser` → `ForbiddenError`); copy that pattern.
2. **`platform_audit_log` is unprotected.** Created only in `bootstrapAdmin.ts` (no schema, no
   migration), **no RLS**, and the blanket grant in `applyMigrations.ts` gives `leadwolf_app`
   read/write — the customer app role can read & tamper the platform audit trail.

---

## The role model (the cross-cutting foundation)

Three **separate** tiers — never mixed into one enum (security/enterprise-iam mandate). Every check is
**server-side**, resolved from the DB (source of truth), scoped by the **session** (never client input).

| Tier | Where it lives | Roles | Gate |
|---|---|---|---|
| **Platform/staff** (cross-tenant) | new `platform_staff` table | `super_admin`, `support`, `billing_ops`, `compliance_officer`, `read_only` | `requireStaffRole()` in `apps/api` admin routes |
| **Tenant/org** (within a customer org) | `tenant_members.org_role` (new col, ADR-0030) | `owner`, `billing_admin`, `security_admin`, `compliance_admin`, `member` | `requireOrgRole()` |
| **Workspace** | `workspace_members.role` (exists) | `owner`, `admin`, `member`, `viewer` | `requireWorkspaceRole()` |

**`requireRole()` guard family** (new, `apps/api/src/middleware/`):
- `requireStaffRole(...roles)` — resolves the caller's `platform_staff.staff_role` (active) for `sub`;
  composes after the existing `platformAdmin` (`pa`) gate. Default-deny.
- `requireOrgRole(...roles)` — resolves `tenant_members.org_role` for `(session.tid, sub)` via a
  tenant-scoped read; `owner` implies all.
- `requireWorkspaceRole(...roles)` — resolves `workspace_members.role` for `(session.wid, sub)`.
- Each enforces **function-level authz**; object-level scope stays RLS + ownership (defence-in-depth).
- The `pa` claim stays the coarse "can reach the console" gate; `is_platform_admin` users are
  backfilled as `super_admin`. No JWT-claim change required (roles resolved per-request, so a
  revoked role takes effect immediately — no stale-claim window).

---

## Schema changes (Drizzle + online-safe migrations)

All new tenant/workspace-scoped tables get `tenant_id NOT NULL` (+ `workspace_id` where applicable),
RLS `ENABLE`+`FORCE`+`USING`+`WITH CHECK` fail-closed via `NULLIF`, `tenant_id` leading index column.
Migrations are **additive-first** and idempotent (new nullable col → backfill → keep; `DROP/CREATE
POLICY IF EXISTS`; no `ALTER TYPE ADD VALUE` in a txn — use `varchar` + CHECK).

- **`tenant_members.org_role`** — new `varchar` + CHECK(enum) col, default `'member'`; backfill
  `is_tenant_owner = true → 'owner'`. Keep `is_tenant_owner` as legacy/derived during transition.
- **`platform_staff`** — `(id, user_id FK, staff_role, status, granted_by_user_id, granted_at,
  revoked_at)`. Platform-owned (no tenant scope). RLS `ENABLE`+`FORCE`, **no policy** (deny-all to
  `leadwolf_app`); managed only via `withPlatformTx`/`withPrivilegedTx`. Backfill from
  `is_platform_admin`.
- **`platform_audit_log`** — promote bootstrap table into `schema/platform.ts` + a migration; add
  `rls/platform.sql`: `ENABLE`+`FORCE ROW LEVEL SECURITY`, **no policy**, **append-only trigger**
  (reuse `audit_log_append_only`), and an explicit `REVOKE ALL ... FROM leadwolf_app` appended in the
  `applyMigrations` grants phase (so the blanket grant can't re-open it). Writer keeps running under
  the BYPASSRLS owner via `withPlatformTx`, so the append still works; `leadwolf_app` is denied.
- **`impersonation_sessions`** — `(id, staff_user_id, target_tenant_id, target_workspace_id?,
  target_user_id?, reason, consent_ref, expires_at, started_at, ended_at, ip)`. Time-boxed,
  consent-gated, every use audited. Platform-owned + FORCE-RLS deny-all to app role.
- **Reuse existing**: `tenant_sso_configs`, `tenant_auth_policies`, `tenant_domains`,
  `user_mfa_methods`, `trusted_devices`, `user_sessions`, `audit_log` (78-action enum),
  `feature_flags`. SCIM needs new `scim_tokens` (Auth Admin phase). Provider configs need a
  `provider_configs` table (Provider API phase).

---

## API endpoints (Hono `/api/v1`, RFC 9457, cursor pagination, idempotency, response-shaped)

**Platform (`/api/v1/admin/*`, `authn`→`platformAdmin`→`requireStaffRole`)** — new:
`GET /users` (global, cursor-paginated, shaped — never raw PII beyond what staff may see) ·
`POST /impersonate` (super_admin/support; creates a time-boxed consent-gated session, audited) +
`DELETE /impersonate/{id}` · `GET /audit-log` (compliance_officer/super_admin; cursor; export job) ·
`GET /billing/*` (billing_ops) · `GET|POST /staff` (super_admin; staff RBAC CRUD) ·
`GET|POST /provider-configs/*` (the missing API behind the built UI; masked keys, budgets, enable).

**Auth Admin — tenant (`/api/v1/settings/security/*`, `authn`→tenant ctx→`requireOrgRole('security_admin','owner')`)** — new/wired:
`GET|PUT /sso` (SAML/OIDC config, validated) · `GET|PUT /scim` (+ `scim_tokens` issue/revoke) ·
`GET|PUT /auth-policy` (MFA enforcement, allowed methods, session timeout, IP allowlist) ·
`GET|PUT /domains` (claim/verify) · `GET /auth-audit` (auth events, cursor).
**Auth Admin — workspace (`requireWorkspaceRole('owner','admin')`)**: `GET|PUT /workspace-auth`
(strictest-wins under tenant policy).

Every write: `Idempotency-Key` where it creates/costs; allowlisted fields (no self-set of
role/tenant/owner); one RFC 9457 envelope; `429` + shared Redis counters on sensitive routes.

---

## UI (light-only, `@leadwolf/ui`, four states, WCAG 2.2 AA, token-driven inline styles)

Mirror existing patterns: list = `apps/admin/.../tenants/TenantsPage.tsx` (`.tp-page` + `StateSwitch`
+ `DataTable`); settings = `apps/web/.../settings-user/ProfilePanel.tsx` (`FormSection`/`FieldGroup`/
`Tp*` + draft+dirty save + toast). Feature-folder structure, ≤150-line files, server-state via query
hooks + `keys.ts`, no Tailwind classes in app JSX.

- **Platform Admin** — add nav destinations + pages: Users, Impersonation (with a persistent banner
  while active), Billing, Audit Log viewer/export, Staff & Access (RBAC), and register the existing
  Provider Configs page. Detail via drawer, not navigate-away, where it fits.
- **Auth Admin** — under `apps/web` settings: **Tenant ▸ Security & Access** (SSO/SCIM/MFA policy/IP
  allowlist/domains) gated to `security_admin`/`owner`; **Workspace ▸ Authentication** gated to
  workspace `owner`/`admin`. Destructive actions (rotate SCIM token, disable SSO, revoke sessions)
  get confirm dialogs.

---

## Build order (smallest safe step first; report after each phase)

- **Phase 0 — Security (do first):** (0a) membership validation in `finalizeLogin` + `selectOrg`/
  `selectWorkspace` + a cross-tenant rejection test; (0b) `platform_audit_log` schema + `rls/platform.sql`
  + REVOKE + append-only + migration. *Ships independently; unblocks everything.*
- **Phase 1 — Role model:** `org_role` + `platform_staff` + backfills + `requireStaffRole/OrgRole/
  WorkspaceRole` guards + shared Zod role enums in `@leadwolf/types`. Apply guards to existing admin
  routes. *Foundation for all authz below.*
- **Phase 2 — Provider-Configs API:** finish the already-built UI (`provider_configs` table + endpoints
  + nav registration). Smallest vertical slice to validate the role-guarded admin write path.
- **Phase 3 — Auth Admin (tenant + workspace):** wire SSO/SCIM/MFA-policy/IP/domains UI + endpoints +
  **enforcement** on the login path (the policy stubs become real); auth-audit view.
- **Phase 4 — Platform Admin expansion:** Users, Impersonation-with-consent, Billing, Audit-log
  viewer/export, Staff RBAC admin UI.

Each phase: shared Zod schema first → migration → API + guard → UI → tests → typecheck/lint/boundaries.

## Security/tenancy invariants (every phase)

Server-side authz on every route (UI hiding ≠ security) · tenant/workspace context only from the
session · new tables `tenant_id NOT NULL` + FORCE-RLS + `WITH CHECK` · cross-tenant only via the
audited `withPlatformTx`/`withPrivilegedTx` (`leadwolf_admin`) · allowlist fields, never spread the
body · responses shaped to authorized fields, never raw rows · every sensitive admin/auth action
writes `platform_audit_log`/`audit_log` in the same transaction · impersonation = consent + time-box +
banner + audit; staff never silently read raw prospect PII.

## Verification

Per phase: `bun run typecheck`, `biome check`, `bun run lint:boundaries`; unit tests for guards +
membership validation; the **mandatory cross-tenant isolation test** extended per new endpoint
(seed two tenants, assert A can't reach B by ID/enum/filter, and `WITH CHECK` rejects a foreign
`tenant_id` write); migration applied against a scratch DB and confirmed reversible/online-safe;
manual run of the admin + settings surfaces (light-only, four states) via the `run`/Chrome tools.

## Out of scope (follow-ups)

Dedicated staff SSO app + mandatory staff MFA (ADR-0011 long-term) · tenant→cluster routing / data
residency · full field-level-permission engine · SCIM group→role mapping beyond default-role JIT ·
dark mode (explicitly declined).
