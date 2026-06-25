# Authentication Settings Inventory — Admin & User (Today)

This document inventories the **authentication-related settings surfaces that exist in the TruePoint codebase today**, separating what is wired end-to-end from what is UI-only or absent. It is a code review of the settings features in `apps/web` (customer org/workspace/user settings) and `apps/admin` (platform/staff console), cross-referenced against the repositories in `packages/db` and the shared contracts in `packages/types`. The governing rule throughout: a panel that renders a field is not the same as that field being persisted, and a field being persisted is not the same as it being **enforced on the login path** — those are tracked as separate columns. Status vocabulary is exact: **Implemented | Partial | Stub | Planned | Absent**.

Two structural facts frame everything below:

- **All user sign-in security (password, MFA, sessions, devices, login history) lives on the auth origin** (`auth.truepoint.in`), not in `apps/web`. The customer app deliberately holds no credentials (ADR-0016).
- The auth-origin **`/account/security` route that the user Security panel deep-links to does not exist yet** — there is no `apps/auth/src/app/account/` directory. This is the single most important caveat in the user-side table.

---

## 1. Admin-side settings (tenant / org)

These live in `apps/web/src/features/settings-tenant` and are gated to org `owner` / `security_admin` via `requireOrgRole` on the API, with RLS enforcing tenant isolation at the database. Every panel renders a "Security admin required" empty state when the API returns 403. "Status" reflects the **whole path** (UI + API + repo + table); "Login enforcement" is called out separately because several fields persist but are not yet read at login.

| Setting | Surface (file) | What it controls | Backed by (repo / table) | Status |
|---|---|---|---|---|
| SSO protocol | `apps/web/src/features/settings-tenant/components/SsoConfigPanel.tsx:165` | `saml` \| `oidc` selector | `ssoConfigRepository` → `tenant_sso_configs` (`packages/db/src/repositories/ssoConfigRepository.ts:23`) | Implemented (config persists) |
| SSO provider label | `SsoConfigPanel.tsx:184` | Short IdP label (e.g. `okta`) | `ssoConfigRepository.upsert` (`ssoConfigRepository.ts:50`) | Implemented |
| SAML metadata URL | `SsoConfigPanel.tsx:198` | IdP metadata endpoint for SAML | `tenant_sso_configs.metadataUrl` (`ssoConfigRepository.ts:62`) | Implemented (stored); **SAML adapter Stub** |
| OIDC issuer / client ID | `SsoConfigPanel.tsx:213`, `:222` | OIDC issuer + client ID | `tenant_sso_configs.oidcIssuer` / `.oidcClientId` (`ssoConfigRepository.ts:64`) | Implemented (stored); **OIDC adapter Stub** |
| OIDC client secret (write-only) | `SsoConfigPanel.tsx:240` | Secret; blank = leave unchanged, returned only as `hasClientSecret` | `tenant_sso_configs.oidcClientSecretEnc` (`ssoConfigRepository.ts:66`, `:43`) | Implemented (write-only, masked read) |
| Attribute mapping | `SsoConfigPanel.tsx:257` | `key=value` IdP-claim → field map | `tenant_sso_configs.attributeMapping` (`ssoConfigRepository.ts:67`) | Implemented (stored) |
| JIT provisioning + default role | `SsoConfigPanel.tsx:271`, `:289` | Auto-create member on first SSO login; org role granted | `tenant_sso_configs.jitEnabled` / `.defaultRole` (`ssoConfigRepository.ts:68`) | Implemented (provisioning logic exists; gated on real SSO) |
| Enable / Enforce SSO | `SsoConfigPanel.tsx:301`, `:313` | Allow / require IdP sign-in | `tenant_sso_configs.enabled` / `.enforced` (`ssoConfigRepository.ts:70`) | Partial (flags persist; real SSO login is Stub) |
| MFA enforcement | `SecurityAccessPanel.tsx:135` | `off` \| `optional` \| `required` | `authPolicyRepository` → `tenant_auth_policies.mfaEnforcement` (`packages/db/src/repositories/authPolicyRepository.ts:48`) | Partial (persists; **`required` is checked at `finalizeLogin`**, see §3) |
| Allowed login methods | `SecurityAccessPanel.tsx:155` | `password`/`oauth`/`magic_link`/`sso`/`passkey` checkboxes | `tenant_auth_policies.allowedMethods` (`authPolicyRepository.ts:53`) | Partial (persists; **not gated at login**) |
| Require SSO | `SecurityAccessPanel.tsx:176` | Force members onto IdP | `tenant_auth_policies.requireSso` (`authPolicyRepository.ts:54`) | Partial (persists; enforcement gated on SSO adapters) |
| Disable social sign-in | `SecurityAccessPanel.tsx:188` | Block Google/Microsoft OAuth | `tenant_auth_policies.disableSocial` (`authPolicyRepository.ts:53`) | Partial (persists; enforcement not wired) |
| Session timeout (minutes) | `SecurityAccessPanel.tsx:200` | Idle session lifetime; 0 = platform default | `tenant_auth_policies.sessionTimeoutSeconds` (`authPolicyRepository.ts:57`) | Partial (persists; **not enforced at login/session layer**) |
| IP allowlist (CIDR/line) | `SecurityAccessPanel.tsx:217` | Restrict sign-in to CIDR ranges | `tenant_auth_policies.ipAllowlist` (`authPolicyRepository.ts:56`) | Partial (persists; **allowlist gate not wired**) |
| Recent security events | `SecurityAccessPanel.tsx:236` → `AuthAuditList.tsx:31` | Read-only org auth event feed (event/user/IP/origin/time) | `fetchAuthAudit` → audit log (`AuthAuditList.tsx:11`); shape `authAuditEntrySchema` (`packages/types/src/auth.ts:139`) | Partial (UI + contract exist; depends on audit read API) |
| Claim domain + DNS TXT | `IdentityPanel.tsx:73`, `:253` | Claim a DNS domain; generates verification token + TXT record | `domainRepository.claim` → `tenant_domains` (`packages/db/src/repositories/domainRepository.ts:65`) | Implemented (claim persists) |
| Verify domain | `IdentityPanel.tsx:88` | Flip domain to `verified` | `domainRepository.markVerified` (`domainRepository.ts:103`) | Partial — **DNS-TXT verification worker deferred**; `markVerified` only flips status (`domainRepository.ts:9`) |
| Domain join policy | `IdentityPanel.tsx:151` (display) | `sso_only` \| `auto_join` \| `request_access` | `tenant_domains.joinPolicy` (`domainRepository.ts:50`); enum `packages/types/src/identityProvisioning.ts:19` | Partial — value is **displayed read-only**; no edit control in the panel |
| Mint SCIM token (once) | `IdentityPanel.tsx:100`, `:277` | Create bearer token; plaintext shown once | `scimTokenRepository.create` → `scim_tokens` (`packages/db/src/repositories/scimTokenRepository.ts:49`) | Implemented (mint/show-once wired) |
| Revoke SCIM token | `IdentityPanel.tsx:115` | Soft-revoke a token | `scimTokenRepository.revoke` (`scimTokenRepository.ts:78`) | Implemented (soft revoke wired) |
| SCIM 2.0 provisioning endpoints | — | `/scim/v2/Users` etc.; group→role; deprovisioning | (none) | **Absent** — token store exists, the SCIM endpoints do not (see §4) |

### Notes on the admin/org table

- **SSO config persists but real SSO does not log anyone in.** The OIDC (`arctic`) and SAML (`@node-saml/node-saml`) adapters are unwired seams: `oidcProvider.initiate/validate` throw `"OIDC SSO is not configured: wire \`arctic\` into packages/auth/src/sso/providers.ts"` and `samlProvider` throws the matching `"SAML SSO is not configured: …@node-saml/node-saml…"` (`packages/auth/src/sso/providers.ts:17-39`). `getSsoProvider` returns the HMAC-signed mock IdP whenever `NODE_ENV !== "production"` and the throwing real adapter in production (`providers.ts:46-49`). So every SSO field above is **stored correctly** but the protocol it configures is **Stub** at the login boundary. Treat "Enable/Enforce SSO" as configuration that currently has no production effect.
- The OIDC client secret is genuinely write-only: `getForTenant` returns `hasClientSecret` and never the bytes (`ssoConfigRepository.ts:43`), and the panel's `toForm` always blanks the field (`SsoConfigPanel.tsx:81`). This is correct and worth preserving.
- `tenant_sso_configs` carries a `metadataXml` column (`ssoConfigRepository.ts:63`) that the panel does **not** expose — only `metadataUrl` has a field. SAML metadata-by-XML-paste is a latent capability with no UI.
- **Mass-assignment caveat (un-surfaced settable fields).** `metadataXml` is the canonical example of a column that is **settable on the write path but not rendered in the UI**: it is accepted by the SSO upsert contract (`packages/types/src/sso.ts:43`, up to 100 KB) and written by `ssoConfigRepository.upsert` (`ssoConfigRepository.ts:82`), yet `SsoConfigPanel.tsx` never offers a field for it. A naïve "spread the request body into the upsert" handler would let a caller set 100 KB of attacker-controlled SAML XML that no operator ever sees in the panel — a latent mass-assignment sink. The mirror case on the user side is `UserProfile.email`, which is **read-only by design** (changed only on the auth origin; `settings-user/types.ts:16`) yet is a real column: a profile `PATCH` that blindly accepts `email` would let a user rewrite their own sign-in identity. Both are exactly the kind of un-surfaced-but-settable fields a server-side write **allowlist** must exclude — the profile/SSO write paths must enumerate the columns they accept rather than echo the request body. See doc `09-threat-model.md` → **"Mass-assignment & field allowlisting"**.

---

## 2. Admin-side settings (platform / staff console)

These live in `apps/admin/src/features/*`. This console is **internal platform staff**, not tenant admins — `platform_staff` RBAC, gated by `requireStaffRole` after the `pa` JWT claim. It does **not** configure tenant auth policy or SSO (that is the org-side panels in §1). The directory surfaces (users, tenants, audit log) are read-only this phase, while staff RBAC, feature flags, and provider configs are write-capable.

| Surface | File | What it shows / controls | Backed by | Status |
|---|---|---|---|---|
| Staff RBAC (grant/revoke) | `apps/admin/src/features/staff/components/StaffPage.tsx:38` | List platform staff; grant/revoke role via `/admin/staff` | `grantStaff` / `revokeStaff` (`StaffPage.tsx:23`); `platform_staff` table | Partial — mutations are wired to audited endpoints; read path through the State Kit |
| Global users directory | `apps/admin/src/features/users/components/UsersPage.tsx:12` | Cross-tenant users; status + `isPlatformAdmin` flag | `/admin/users` (`useUsers`) → `platformAdminRepository.listUsers` (`apps/api/src/features/admin/routes.ts:51`) | Implemented (list) — the cross-tenant `GET /admin/users` read is built and audited via `withPlatformTx`. Search / filter / cursor pagination and remediation actions (impersonation, suspend) are still **Planned** (`UsersPage.tsx:2` — read-only this phase). |
| Tenants directory | `apps/admin/src/features/tenants/components/TenantsPage.tsx` | View plan / limits / members | `/admin/tenants` | Partial — read-only; **no tenant auth-config editing here** |
| Audit log viewer | `apps/admin/src/features/audit-log/components/AuditLogPage.tsx` | Platform audit feed | audit read API | Partial — viewer only |
| Feature flags | `apps/admin/src/features/feature-flags/components/FeatureFlagsPage.tsx` | Flags + overrides | flags API | Partial (not auth-specific) |
| Provider configs (enrichment providers) | `apps/admin/src/features/provider-configs/components/ProviderConfigsPage.tsx:38` | Enrichment-provider enable/disable + monthly budget; masked keys | `/admin/provider-configs` → `providerConfigRepository`; `provider_configs` table (`packages/db/src/schema/intel.ts:120`) | Implemented — API is mounted and **write-capable** (enable/disable + budget), gated `requireStaffRole("super_admin")` (`apps/api/src/features/admin/providerConfigs.ts:32`, `app.ts:67`/`routes.ts:248`). `keyHint`/`health` are deferred (masked / live-probe `null`), but the enable + budget controls work. |
| System health | `apps/admin/src/features/system-health/components/SystemHealthPage.tsx` | Operational health panel | health API | Partial (not a settings surface) |

### Notes on the platform console

- The "provider-configs" screen is about **enrichment data providers** (cost/rate/health), not social-OAuth IdP credentials. The IdP/social-provider config surface described in the buildout plan (Google/Microsoft OAuth client config) is **not** this screen and is not built; treat social-provider configuration as **Planned**.
- The platform console is **not** where a tenant's MFA/SSO/IP policy is set — that is exclusively the org-side `SecurityAccessPanel` / `SsoConfigPanel` / `IdentityPanel` in §1. Do not conflate the two.

---

## 3. User-side settings (own account)

These live in `apps/web/src/features/settings-user`. Critical: the only auth-security mutations a user could perform — password change, MFA enroll/disable, session/device revoke, login-history — are **served on the auth origin**, and the route that serves them **does not exist yet**.

| Setting | Surface (file) | What it controls | Backed by | Status |
|---|---|---|---|---|
| Display name | `ProfilePanel.tsx:81` | User's full name | `saveProfile` → `PATCH /settings/user/profile` (`ProfilePanel.tsx:48`) | Partial — wired to the app API; depends on that endpoint |
| Timezone | `ProfilePanel.tsx:109` | IANA timezone for formatting | `PATCH /settings/user/profile` (`ProfilePanel.tsx:48`) | Partial — wired |
| Locale | `ProfilePanel.tsx:127` | BCP-47 locale | `PATCH /settings/user/profile` (`ProfilePanel.tsx:48`) | Partial — wired |
| Email | `ProfilePanel.tsx:100` | Sign-in email | — (read-only here; **changed on auth origin**) | Read-only by design (`UserProfile.email`, `settings-user/types.ts:16`) |
| Password change | `SecurityPanel.tsx:58` | "Change password" button | **Deep-link only** → `AUTH_ORIGIN/account/security#password` (`SecurityPanel.tsx:15`) | **Absent** — target route does not exist (no `apps/auth/src/app/account/`) |
| Two-step / MFA factors | `SecurityPanel.tsx:77` (list), `:92` (link) | Status list: TOTP, passkey, SMS, email, recovery codes | **Hardcoded `enrolled: false`** (`SecurityPanel.tsx:20`); link to `#mfa` | **Absent** (this surface) — list is a static placeholder; no real enrollment read. (The *methods* themselves: TOTP **Implemented**, SMS / email / WebAuthn **Stub** — see §4.) |
| Sessions & devices | `SecurityPanel.tsx:117` | "Manage sessions" button | **Deep-link only** → `#sessions` (`SecurityPanel.tsx:119`) | **Absent** — target route does not exist |
| Login history | `SecurityPanel.tsx:143` | "View login history" button | **Deep-link only** → `#history` (`SecurityPanel.tsx:147`) | **Absent** — target route does not exist |

### Notes on the user table — read this before quoting any "user can…" claim

- **There is no real user self-service for password change, MFA enrollment/disable, active-session or trusted-device listing/revoke, or login history today.** `SecurityPanel.tsx` is, by its own header comment, "a read-only map of those surfaces with 'Manage on the sign-in site' deep links — it NEVER fakes a mutation" (`SecurityPanel.tsx:3`). The deep links point at `auth.truepoint.in/account/security#…` (`SecurityPanel.tsx:15-16`).
- **This is the per-user page, and it is distinct from workspace-admin session management.** A workspace owner/admin *can* today list, revoke, and force-reauth the sessions of the workspace's **members** (the Implemented `settings-workspace` Sessions surface in §4). That is an admin-over-members capability; it does **not** give a user self-service over their **own** password, MFA, sessions, devices, or login history. Both statements are true at once: workspace-admin session management exists; the per-user `/account/security` page does not.
- **That route is Absent.** A `Glob` of `apps/auth/src/app/account/**` returns no files — the `/account/security` screen the panel links to has not been built. A user who clicks "Change password" reaches a non-existent path.
- **The MFA factor list is cosmetic.** All five entries are hardcoded `enrolled: false` (`SecurityPanel.tsx:20-26`); the `MfaMethodStatus.enrolled` field exists in the type (`settings-user/types.ts:48`) but is never populated from real enrollment state, because no status-read API exists. Per the panel's own header comment, "the enrolled flags are placeholders until the auth origin exposes a status read" (`SecurityPanel.tsx:5`).
- `recovery_codes` appears in the panel's catalogue as a sixth factor label, but it is **not** a member of the shared `mfaMethodType` enum (`packages/types/src/auth.ts:10`, which is `totp|sms|email|webauthn`); the panel widens the type locally (`settings-user/types.ts:48`). This is a UI-label convenience, not a contract method.

---

## 4. Partially-wired / enforcement-gap subsection

Capabilities where a **schema, repository, or type contract exists** but there is **no working settings UI or no enforcement** behind it. These are the most common source of "but the table/column exists, so surely it works" mistakes. The one **Implemented** row below (workspace session management) is included as the contrasting case: it is the surface in this family that *is* fully wired end-to-end, so it is the reference for what "done" looks like here.

| Item | Where | Status | Why it's listed here |
|---|---|---|---|
| Trusted devices (30-day MFA skip) | `trusted_devices` table, `packages/db/src/schema/auth.ts` | **Stub** (schema-only) | Table exists but is **not wired into the login flow**; the `mfaVerify` `trustDevice` flag (`packages/types/src/auth.ts:77`) has no consuming logic. No UI. |
| Per-method MFA beyond TOTP | `mfaVerify.ts` routes by `mfaMethodType` | **Stub** | Only TOTP is live; SMS / email / WebAuthn branches **return `false`** (M11). The contract enumerates them (`auth.ts:10`); the runtime does not implement them. |
| Session-timeout enforcement | `tenant_auth_policies.sessionTimeoutSeconds` | **Partial** | Value persists (`authPolicyRepository.ts:57`) and the panel edits it (`SecurityAccessPanel.tsx:200`), but **nothing reads it to expire sessions**. |
| IP-allowlist enforcement | `tenant_auth_policies.ipAllowlist` | **Partial** | Persists + edited in UI; the **login-path gate is not wired**. |
| Allowed-methods enforcement | `tenant_auth_policies.allowedMethods` | **Partial** | Persists + edited; **not used to reject a disallowed method at login**. |
| MFA-required enforcement | `flow.ts` `finalizeLogin` | **Partial** | This is the one policy that **is** checked on the login path — `mfaEnforcement: required` is honored at `finalizeLogin`. Forced **in-login TOTP enrollment** (when a user has no factor yet) is **Planned**. |
| Workspace session management (admin over members) | `apps/api/src/features/workspaces/sessionRoutes.ts` (API); `apps/web/src/features/settings-workspace/components/SessionsPanel.tsx:56` (UI) | **Implemented** | The API is built and mounted (`apps/api/src/app.ts:71`): `GET /security/sessions`, `POST /security/sessions/:sessionId/revoke`, `POST /security/members/:userId/force-reauth`, guarded `authn` + `tenancy` + `requireRole("owner","admin")`, backed by core `listMemberSessions` / `revokeMemberSession` / `forceReauthMember` (`packages/core/src/auth/adminSessions.ts`). The UI (`SessionsPanel.tsx` / `useSessions.ts` / `api.ts`) is wired to those endpoints. A workspace owner/admin can today list members' active sessions, revoke one, and force a member to re-authenticate. The "Not available yet" toast + `feed.available:false` are **defensive 404/501 dead-fallback** branches that the live endpoints do not trigger. |
| Workspace Members UI | `apps/web/src/features/settings-workspace/components/MembersPanel.tsx:24` | **Absent** (API) / **Partial** (UI) | Invite/role/remove UI present, but there is **no member-management route** in `apps/api/src/features/workspaces` (only the session routes and the `GET /` workspace-switcher list). The panel's `/current/members` calls 404, so every mutation falls back to "Not available yet" (`MembersPanel.tsx:32`). Invite/role/remove endpoints are **Absent**. |
| Domain DNS-TXT verification | `domainRepository.markVerified` | **Partial** | The verification **worker** that resolves the TXT record is deferred (`domainRepository.ts:8`); `markVerified` flips status without proving control. |
| Domain join-policy editing | `IdentityPanel.tsx:151` | **Partial** | `joinPolicy` is **displayed** but there is no control to change it; the column/enum exist (`identityProvisioning.ts:19`). |
| SCIM 2.0 endpoints + deprovisioning | (none) | **Absent** | The token store is wired (§1) but the SCIM Users/Groups endpoints, group→role mapping, and deprovisioning (revoke sessions / reassign records) are unbuilt. |

---

## 5. Designed-but-unbuilt (settings-relevant)

For completeness, the settings-facing items called out in the planning docs (`docs/planning/17-authentication.md`, `admin-auth-buildout-plan.md`, `13-platform-admin.md`) and the type contracts that have **no implemented settings surface**:

| Item | Source | Status |
|---|---|---|
| User `/account/security` screen on the auth origin (password + strength, MFA enroll wizard, recovery codes, active sessions, trusted devices, login history) | `docs/planning/17-authentication.md §10`; `SecurityPanel.tsx:1` deep-links to it | **Absent** |
| Auth-policy **enforcement** at login (allowed-methods, IP allowlist, session timeout, forced in-login TOTP enrollment) | `admin-auth-buildout-plan.md`; ADR-0018 | **Planned** |
| Real OIDC/SAML adapters + SP/IdP-initiated + test-connection + SSO setup wizard | `sso/providers.ts` (throwing seams); ADR-0017/0018 | **Stub / Planned** |
| Workspace **members** API (invite/role/remove, to back the existing `MembersPanel`) | `MembersPanel.tsx`; `apps/api/src/features/workspaces` (no members route) | **Absent** (the sessions API that backs `SessionsPanel` is already Implemented — `sessionRoutes.ts`) |
| `requireOrgRole` / `requireStaffRole` guards + `org_role`/`platform_staff` migrations | ADR-0030; `apps/api/src/middleware/requireOrgRole.ts`, `requireStaffRole.ts` (+ `roleGuards.test.ts`); `org_role` in `packages/db/src/schema/auth.ts:79`; `platform_staff` in `0006_kind_tomorrow_man.sql` + `platformStaffRepository.ts` | **Implemented** — the org/staff guards and the `org_role`/`platform_staff` migrations are built and tested in `apps/api` / `packages/db`; the older "guards Planned" note was a `packages/auth`-scoping artifact |
| `requireWorkspaceRole` coverage review + workspace **members** API (the remaining RBAC gap) | ADR-0030; `apps/api/src/features/workspaces` (no members route) | **Absent** — `requireRole("owner","admin")` already guards the workspace **sessions** routes, but a dedicated `requireWorkspaceRole` audit and the invite/role/remove members endpoints (to back `MembersPanel`) are not built (see §4 / line above) |
| Platform admin expansion: global user search/filter, impersonation-with-consent, staff RBAC admin UI, platform audit export | `docs/planning/13-platform-admin.md` | **Planned** (the base cross-tenant Users + Tenants lists are Implemented but read-only; search/filter, impersonation, and remediation are the planned expansion) |
| Social-provider (Google/Microsoft OAuth) IdP config surface | `admin-auth-buildout-plan.md` | **Planned** (the admin "provider-configs" screen is enrichment providers, not IdPs) |

---

## Caveats and enforcement boundaries

- **MFA-required enforcement location:** `finalizeLogin` resolves and authorizes the active org via `authorizeTenantSelection(orgs, txn.tenantId)` (`packages/auth/src/flow.ts:145`), then — only when `!txn.mfaVerified` — fail-closes for a `required`-policy tenant: `if (policy.mfaEnforcement === "required") throw new ForbiddenError("mfa_required", …)` (`flow.ts:152-159`). So MFA-required **is** gated on the login path, but **IP allowlist, allowed-methods, and session-timeout are not checked anywhere in `finalizeLogin`**. The settings panel that *sets* the value (`SecurityAccessPanel.tsx:135`) and the repo that *persists* it (`authPolicyRepository.ts:48`) are wired; the enforcement gap is in the login flow, not the settings surface.
- **Cross-tenant selector coverage (not a live bug):** the client-supplied org/workspace selection is membership-checked at **both** the selector step and the finalize gate. The org selector action calls `isActiveTenantMember(txn.userId, tenantId)` and redirects on failure (`apps/auth/src/app/org/actions.ts:26`); the workspace selector action calls `isActiveWorkspaceMember(txn.userId, txn.tenantId, …)` (`apps/auth/src/app/workspace/actions.ts:30`); and `finalizeLogin` re-checks via `authorizeTenantSelection` plus a `workspaceRepository.getRoleForUser` membership check (`flow.ts:145`, `:165`). The "cross-tenant selector bypass" concern is therefore **covered in the current source**, not an open vulnerability.
- **StaffPage write status:** `apps/admin/src/features/staff/components/StaffPage.tsx` contains wired `grantStaff`/`revokeStaff` calls to `/admin/staff` (mounted at `apps/api/src/features/admin/routes.ts:251`), so it is classified **Partial** (mutations wired to audited endpoints) rather than read-only.
- **`/settings/user/profile` and `fetchAuthAudit` endpoints:** the panels call them; the backing `apps/api` route mounts are not independently confirmed in this inventory, so Profile fields and the auth-audit feed are kept **Partial** (UI + client wired; backend mount unconfirmed) rather than Implemented.
- Some admin-console internals (TenantDetailPage, AuditLogPage) are not read line-by-line here; their statuses are inferred from file headers. Note this read-only characterization applies only to the **directory/viewer** surfaces (users, tenants, audit-log viewer) — the console as a whole is **not** read-only: staff RBAC (grant/revoke), feature flags, and provider-configs (enable/disable + budget) are write-capable (see §2).
