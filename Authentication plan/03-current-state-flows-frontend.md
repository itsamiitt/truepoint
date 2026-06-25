# Current State — Auth Flows & Frontend Surfaces

This document is a code review of TruePoint's **as-built** user-facing authentication: the SSR flows on the dedicated auth origin (`apps/auth`, `auth.truepoint.in`), the tenant/workspace/user settings surfaces in the customer app (`apps/web`), and the platform-staff console (`apps/admin`). For every flow and panel it records what actually renders and whether each surface is wired to a real, implemented backend or is mock/placeholder/stub. Status uses exactly: **Implemented | Partial | Stub | Planned | Absent**. The source code is authoritative for this document; every status below is stated against the cited source files.

The single most important caveat for leadership: **real OIDC/SAML IdP validation is a Stub** (the adapters throw; only a dev mock works), and the **user self-service account-security route on the auth origin (`/account/security`) is Absent** — the customer-app Security panel only deep-links to a URL that does not yet exist.

---

## A. Auth-origin flows & screens (`apps/auth`)

All screens are SSR, form-post to a server action (work without JS), carry the app's PKCE/return context (`app_origin` / `code_challenge` / `state`) as hidden fields, and are wrapped in `AuthShell`. Security headers (HSTS, `X-Frame-Options: DENY`, nonce-CSP with no inline scripts, `Referrer-Policy: no-referrer`) are set on every response by middleware (`apps/auth/src/middleware.ts:7-33`).

### A.1 Flow inventory

| Flow / screen | Where (file:line) | Status | Notes |
|---|---|---|---|
| Identifier step (email/username) | `apps/auth/src/app/login/page.tsx:23`; action `apps/auth/src/app/login/actions.ts:12` | Implemented | Turnstile + `checkIdentifierRate` gate, then `lookupIdentifier` routes to `register`/`sso`/`magic`/`password` (`actions.ts:32-42`). Reveals existence by design. |
| "Continue with Google" (social OAuth start) | `apps/auth/src/app/login/page.tsx:34,52-54` | Absent | The button links to `/oauth/google`, but **no `apps/auth/src/app/oauth/` route exists** (verified: directory absent). Clicking it 404s today. This is a **loose end** documented as current state: the dead button should either be wired or removed, and that **build-or-remove decision is owned by docs 06 (gap register) and 08 (delivery wave)** — not resolved here. |
| Password step | `apps/auth/src/app/password/page.tsx`; action `apps/auth/src/app/password/actions.ts:25` | Implemented | `authenticatePassword` → `createLoginTransaction` → `resolveNextStep` (mfa/org/workspace) → `finishLogin`. Uniform credential failure; distinct `unavailable` on infra outage (`actions.ts:56-97`). Brute-force lockout via `assertCredentialNotLocked` (`actions.ts:48-52`). |
| Magic-link request screen | `apps/auth/src/app/magic/page.tsx:17`; action `apps/auth/src/app/magic/actions.ts:17` | Implemented | Validates allow-listed `app_origin` + PKCE before issuing; mints `magic_link` code, stashes carry in `MAGIC_TXN_COOKIE`, mails one-click link (`actions.ts:36-54`). Resend is rate-limited. |
| Magic-link confirm (one-click callback) | `apps/auth/src/app/magic/confirm/route.ts:13` | Implemented | Consumes single-use code (`verifyEmailCode` purpose `magic_link`), recovers carry, `completeMagic` finalizes (`route.ts:32-39`). Bad/expired bounces to `/login?error=magic`. |
| SSO handoff screen | `apps/auth/src/app/sso/page.tsx:11`; action `apps/auth/src/app/sso/actions.ts:15` | Partial | Screen + transaction threading are Implemented (`createSsoTransaction`, audit `sso.initiated`); the actual IdP redirect is produced by the provider seam, which is mock in dev and **throws in production** (see A.2). |
| SSO OIDC callback | `apps/auth/src/app/sso/oidc/callback/route.ts:6` | Partial | Route + `completeSso` wiring Implemented; the `validate()` it calls is mock in dev, Stub (throws) in prod. |
| SSO SAML callback / ACS (GET+POST) | `apps/auth/src/app/sso/saml/callback/route.ts:6-22` | Partial | Same as OIDC; merges POST form + GET query into one param bag (`route.ts:8-12`). |
| Mock IdP screen + action (dev only) | `apps/auth/src/app/sso/mock/page.tsx:13`; action `apps/auth/src/app/sso/mock/actions.ts:12` | Implemented | Signs an HMAC mock assertion bound to the transaction relay state and posts to the protocol callback. Hard-disabled when `NODE_ENV === "production"` (`page.tsx:14`, `actions.ts:13`). |
| MFA challenge (TOTP) | `apps/auth/src/app/mfa/page.tsx:15`; action `apps/auth/src/app/mfa/actions.ts:21` | Partial | TOTP verify (`verifyMfaCode method:"totp"`) + per-user lockout is Implemented. The **"Trust this device for 30 days" checkbox renders** (`page.tsx:38-40`) but the action never reads `trust_device` — trusted-device skip is not wired. The footer links to `/mfa/recovery`, which is **Absent** (only `actions.ts`+`page.tsx` exist under `/mfa`). |
| Signup step 1 (claim email) | `apps/auth/src/app/signup/actions.ts:43` (`startSignup`) | Implemented | Known email → bounced to `/password`; unknown → signup transaction + 6-digit code mailed → `/verify`. |
| Email verification (code entry + resend) | `apps/auth/src/app/verify/page.tsx:15`; actions `apps/auth/src/app/verify/actions.ts:25,34` | Implemented | `verifyEmailCode` marks the transaction email-proven → `/signup/profile`; resend mints a fresh code. Auto-submits on the 6th digit. |
| Signup step 3 (profile + provision) | `apps/auth/src/app/signup/profile/page.tsx:19`; action `apps/auth/src/app/signup/actions.ts:81` (`completeSignup`) | Implemented | Validates `signupSchema`, `provisionIdentity` (3-way org placement), audits `signup`, opens login txn, completes. Handles `username_taken`/`email_taken` conflicts (`actions.ts:103-114`). |
| Forgot-password request | `apps/auth/src/app/forgot/actions.ts:15` | Implemented | Enumeration-safe: `requestPasswordReset` returns a code ONLY when the account exists; the user-facing `?sent=1` outcome is identical either way (`actions.ts:38-44`). |
| Reset-password completion | `apps/auth/src/app/reset/actions.ts:18` | Implemented | Server-side match check, `completePasswordReset` (single-use code), per-email/IP lockout, then `/login?reset=1` with only an allow-listed `app_origin` forwarded (`actions.ts:54-64`). |
| Org selector | `apps/auth/src/app/org/page.tsx:15`; action `apps/auth/src/app/org/actions.ts:16` (`selectOrg`) | Implemented | Lists `tenantMemberRepository.listForUser`; the action **membership-checks the client-supplied `tenantId` via `isActiveTenantMember` before proceeding** (`actions.ts:26`). |
| Workspace selector | `apps/auth/src/app/workspace/page.tsx:15`; action `apps/auth/src/app/workspace/actions.ts:16` (`selectWorkspace`) | Implemented | Lists RLS-scoped `workspaceRepository.listForUser`; the action **membership-checks the client-supplied `workspaceId` via `isActiveWorkspaceMember` within the txn tenant** (`actions.ts:28-33`). |
| Org switch (authenticated re-pin) | `apps/auth/src/app/org/switch/route.ts:28` | Implemented | Reads refresh cookie, `switchOrg` authorizes target tenant, rotates session, mints fresh JWT. 401 clears cookie; 403 leaves session intact (`route.ts:57-65`). |
| Workspace switch (authenticated re-pin) | `apps/auth/src/app/workspace/switch/route.ts:26` | Implemented | Mirror of org switch via `switchWorkspace` (`route.ts:43-54`). |
| Orgs list (for app switcher) | `apps/auth/src/app/orgs/route.ts:28` | Implemented | Cross-tenant read of the caller's own memberships, served from the auth origin's privileged connection; authenticated by refresh cookie (`route.ts:40-46`). |
| Token exchange (code → access JWT) | `apps/auth/src/app/token/exchange/route.ts:32` | Implemented | `exchangeCode` (single-use, IP/PKCE/origin-bound) → `mintAccessToken`. Distinct `invalid_auth_code` (400) vs `auth_unavailable` (503); audit emitted off the response path (`route.ts:48-117`). |
| Silent refresh | `apps/auth/src/app/token/refresh/route.ts:23` | Implemented | `refreshAccessToken` rotates + re-mints; any failure clears the cookie and 401s (`route.ts:35-50`). |
| Logout | `apps/auth/src/app/logout/route.ts:25` | Implemented | Always clears cookie + 204 (idempotent); best-effort `revokeSession` (`route.ts:32-47`). |
| JWKS publication | `apps/auth/src/app/.well-known/jwks.json/route.ts:5` | Implemented | `getJwks()`, `Cache-Control: public, max-age=300`. The **published URL is `/auth/.well-known/jwks.json`** — the auth app's Next `basePath` is `/auth` (`apps/auth/next.config.mjs:8`), so every route (the JWKS endpoint included) lives under `/auth/*`. The `/auth` prefix is **load-bearing for `apps/api` stateless verification**: `apps/api` fetches the key set from `new URL("/auth/.well-known/jwks.json", …)` (`packages/auth/src/token.ts:17-28`); a bare `/.well-known/jwks.json` 404s and **every access token fails verification** (401 `invalid_token`). |
| Security headers / nonce-CSP middleware | `apps/auth/src/middleware.ts:7` | Implemented | Per-request nonce, Turnstile origin allow-listed, `frame-ancestors 'none'` (`middleware.ts:9-21`). |
| Entry-page "already signed in" guard | `apps/auth/src/lib/sessionGuard.ts:25` | Implemented | Validates via `sessionRepository.findByRefreshTokenHash`; fails OPEN; only redirects to allow-listed origins. Mid-flow steps deliberately unguarded (`sessionGuard.ts:8-10`). |

### A.2 SSO provider seam — the load-bearing stub

`getSsoProvider` returns the dev mock for any non-production environment and the real adapter in production (`packages/auth/src/sso/providers.ts:44-47`). The real adapters are deliberate, unwired seams whose every method throws:

| Adapter | Where (file:line) | Status | Behaviour |
|---|---|---|---|
| `oidcProvider.initiate` / `.validate` | `packages/auth/src/sso/providers.ts:16-26` | Stub | Both throw `"OIDC SSO is not configured: wire arctic into …"` |
| `samlProvider.initiate` / `.validate` | `packages/auth/src/sso/providers.ts:28-38` | Stub | Both throw `"SAML SSO is not configured: wire @node-saml/node-saml into …"` |
| `mockProvider` | `packages/auth/src/sso/mockIdp.ts` (selected at `providers.ts:45`) | Implemented | HMAC-signed assertion; exercises handoff → callback → JIT locally. |

Net effect: the **entire SSO round-trip is exercisable end-to-end in dev** (handoff → mock IdP → callback → `provisionSsoIdentity` → finalize), but **no real SAML/OIDC login is possible in production** — a production SSO attempt throws inside `provider.initiate`, caught by `initiateSso` and surfaced as the screen's "Single sign-on isn't available right now" error (`apps/auth/src/app/sso/actions.ts:41-44`, `apps/auth/src/app/sso/page.tsx:50-55`).

### A.3 Cross-tenant selector hardening

The org/workspace **selector** endpoints (not just `finalizeLogin`) membership-check the client-supplied `tenantId`/`workspaceId`. Code review confirms **they do**:

- `selectOrg` rejects a forged tenant via `isActiveTenantMember(txn.userId, tenantId)` before patching the transaction (`apps/auth/src/app/org/actions.ts:26`).
- `selectWorkspace` rejects a forged workspace via `isActiveWorkspaceMember(txn.userId, txn.tenantId, workspaceId)` (`apps/auth/src/app/workspace/actions.ts:28-33`).

Both note that `finalizeLogin` re-checks authoritatively before minting the token. This is defence-in-depth, not a live bypass. (A formal isolation test asserting the selector path rejects a non-member tenant/workspace is the remaining gap to confirm; the guards themselves are present.)

### A.4 Accessibility (WCAG 2.2 AA) & i18n — UNASSESSED

The project mandates **WCAG 2.2 AA** and localizable copy for everything that renders (the `truepoint-design` skill in `CLAUDE.md`; standard at https://www.w3.org/TR/WCAG22/). The `apps/auth` SSR flows inventoried in A.1 — login/identifier, password, the auto-submit-on-6th-digit OTP/verify input, MFA challenge, the Turnstile challenge and its no-JS fallback, email verification, and reset — have **not been assessed** against that bar in this review. Status against the AA + i18n mandate is therefore **Absent (no assessment on record)**, not a pass. Specific risks to evaluate before sign-off:

- **Label / error association** — every input needs a programmatically associated `<label>` and each validation/credential error must be wired to its field via `aria-describedby` and announced (an `aria-live` region), not conveyed by colour or position alone (WCAG 1.3.1, 3.3.1, 4.1.3). The uniform-failure and `unavailable` error paths on the password and reset actions especially need a verified accessible announcement.
- **Focus management** — on each SSR step transition and on every server-action error re-render, focus must move predictably to the error summary or the first invalid field, and visible focus must meet **2.4.7 / 2.4.11 (focus appearance & not-obscured, new in 2.2)**.
- **The auto-submitting OTP input** — `/verify` auto-submits on the 6th digit (`apps/auth/src/app/verify/page.tsx`); auto-advancing/auto-submitting code inputs are a known AA hazard for screen-reader, switch-control, and paste-from-password-manager users. It must remain operable without the auto-submit (a real submit control), tolerate paste, and not trap or surprise focus (WCAG 2.1.1, 3.2.2 On Input, 3.3.x).
- **Turnstile challenge + fallback** — the interactive Cloudflare Turnstile widget and its no-JS / failure fallback must both be keyboard-operable and labelled, and the fallback path must not strand a non-JS or AT user (WCAG 2.1.1, 4.1.2).
- **Contrast** — `AuthShell` and `var(--tp-*)` token usage on these screens must clear **1.4.3 (text)** and **1.4.11 (non-text/UI component & state)** contrast, including error and disabled states.
- **Localizable auth copy & emails** — all in-screen strings and the auth transactional emails (magic-link, verification code, password-reset) are currently English literals; they must be externalised to the i18n layer with correct `lang`/`dir` so copy and emails localise (WCAG 3.1.1 Language of Page).

**WCAG 2.2 AA + i18n must be an explicit acceptance criterion on the new P1b `/account/security` build** (and applied retroactively to the existing auth screens). This gap is carried as a **new row in doc 06 (gap register)** and sequenced in **doc 08 (delivery wave)**.

---

## B. Customer-app settings surfaces (`apps/web`)

The web slices use `fetchWithAuth` (in-memory access token) against `api.truepoint.in/api/v1/...`, and uniformly treat HTTP **404/501 as "endpoint not built yet"** (degrade to `null` / `available:false`) and **403 as "insufficient role"** (quiet empty state). This is why several panels render fully even when a backend is missing — the render is real, the live wiring may not be.

> **How the backend wiring actually stands.** Code review of `apps/api` shows the **tenant auth-policy, auth-audit, SSO-config, domains, and SCIM-token endpoints are implemented and mounted** (`apps/api/src/features/settings/{routes,ssoRoutes,identityRoutes}.ts`, mounted at `apps/api/src/app.ts:99`), gated by a **real `requireOrgRole` guard** (`apps/api/src/middleware/requireOrgRole.ts:14`). The **workspace session-admin endpoints are also implemented and mounted** (`apps/api/src/features/workspaces/sessionRoutes.ts`, mounted at `apps/api/src/app.ts:71`). The **workspace members endpoints remain Absent** (no members route in `apps/api/src/features/workspaces/` — only `sessionRoutes.ts` and the workspace-CRUD `routes.ts`). Status below reflects the code.

### B.1 Tenant settings (`settings-tenant`) — gated owner / security_admin

| Panel | Renders (file:line) | Client seam (file:line) | Backend (file:line) | Status | Notes |
|---|---|---|---|---|---|
| SSO config | `components/SsoConfigPanel.tsx:124` | `ssoApi.ts:23,35` (`/settings/security/sso`) | `apps/api/.../settings/ssoRoutes.ts:18,23` | Implemented | Protocol/provider, SAML metadata or OIDC issuer/clientId, **write-only client secret** (encrypted server-side, never returned; `ssoRoutes.ts:32-34`), attribute mapping, default role, JIT, enable/enforce. Config persists. *Enforcing real SSO at login is still blocked on the A.2 adapters.* |
| Security & access (auth policy) | `components/SecurityAccessPanel.tsx:90` | `api.ts:62,73` (`/settings/security/auth-policy`) | `apps/api/.../settings/routes.ts:72,81` | Implemented (store) / Partial (enforcement) | MFA enforcement, allowed methods, require-SSO, disable-social, session timeout, IP allowlist (CIDR) all persist via `authPolicyRepository.upsert`. The panel itself notes resolution/enforcement lives in the API; **full login-path enforcement (allowed-methods gate, IP allowlist, session timeout) is not yet wired** — see the Implemented-vs-Designed split below. |
| — Recent security events (`AuthAuditList`) | `components/AuthAuditList.tsx:31` | `api.ts:87` (`/settings/security/auth-audit`) | `apps/api/.../settings/routes.ts:95` | Implemented | Self-loads the org's last 100 auth events (security_admin/owner-gated, non-PII fields). |
| Identity (domains + SCIM tokens) | `components/IdentityPanel.tsx:49` | `identityApi.ts:31,44,56,69,83,95` | `apps/api/.../settings/identityRoutes.ts:58-133` | Implemented (token/domain mgmt) / Partial (verification) | Claim domain, mint SCIM token (plaintext shown **once** in a dialog, `IdentityPanel.tsx:316-340`), revoke — all live. **DNS-TXT domain verification is wire-deferred**: `markVerified` flips status without an actual DNS check (`identityRoutes.ts:75-78`). The **SCIM 2.0 provisioning protocol endpoints an IdP would call remain Absent** (`identityRoutes.ts:16-18` says deferred). |

### B.2 Workspace settings (`settings-workspace`)

| Panel | Renders (file:line) | Client seam (file:line) | Backend (file:line) | Status | Notes |
|---|---|---|---|---|---|
| Sessions (admin) | `components/SessionsPanel.tsx:56` | `api.ts:83,93,103` (`/workspaces/security/...`) | `apps/api/.../workspaces/sessionRoutes.ts:29,60,79` | Implemented | API is wired end-to-end: a workspace owner/admin can list members' active sessions, revoke one, and force-reauth a member. The HTTP routes (`GET /security/sessions`, `POST /security/sessions/:sessionId/revoke`, `POST /security/members/:userId/force-reauth`) are guarded `authn` + `tenancy` + `requireRole("owner","admin")` and call core `listMemberSessions`/`revokeMemberSession`/`forceReauthMember` (`packages/core/src/auth/adminSessions.ts`), which re-verify the caller is an active owner/admin. The panel's `available:false` / "Sessions API not connected" branch (`SessionsPanel.tsx:168-174`) is a **defensive dead-fallback that only fires on 404/501** (`api.ts:84-88`); against the live API the list returns `available:true`, so it is not the live state. |
| Members | `components/MembersPanel.tsx:24` | `api.ts:43,51,62,73` (`/workspaces/current/members`) | — | Absent (backend) / Partial (UI) | UI is fully designed (invite row, role dropdowns, remove dialog). **No members route exists in `apps/api/src/features/workspaces/`**, so every call hits 404/501 → `notWired()` toast "Not available yet" (`MembersPanel.tsx:32-33`) and the empty state shows "Members API not connected" (`MembersPanel.tsx:155`). |
| Workspace general | `components/WorkspaceGeneralPanel.tsx`; seam `api.ts:25` (`/workspaces/current`) | — | Partial | Degrades to `null` ("not built") when the `/workspaces/current` GET/PATCH is absent. |

### B.3 User settings (`settings-user`) — own account

| Panel | Renders (file:line) | Client seam (file:line) | Status | Notes |
|---|---|---|---|---|
| Profile | `components/ProfilePanel.tsx:25` | `api.ts:19,26` (`/settings/user/profile`) | Partial | Name / timezone / locale editable; **email is read-only** ("change it on the sign-in site", `ProfilePanel.tsx:96-101`). Wired to PATCH; a missing backend surfaces a first-class error state, never a fake save. |
| Notifications | `components/NotificationsPanel.tsx`; seam `api.ts:38,45` | Partial | Per-channel prefs via `/settings/user/notifications`. |
| **Security** | `components/SecurityPanel.tsx:28` | none (deep-links only) | **Stub / deep-links to an Absent route** | Renders Password / Two-step / Sessions & devices / Login history sections as **read-only status with "Manage on the sign-in site" links**. It **never fakes a mutation** and there is **no app-API seam** (`api.ts:1-4`). |

**Critical detail on the User ▸ Security panel:**
- Every link targets `AUTH_ORIGIN + /account/security#{password|mfa|sessions|history}` via `authLink()` (`SecurityPanel.tsx:14-17`). That route is **Absent** — `apps/auth/src/app/account/` does not exist (verified). The links 404.
- The MFA factor catalogue is **hardcoded `enrolled:false`** for all five factors (TOTP, passkey/webauthn, SMS, email, recovery_codes) (`SecurityPanel.tsx:20-26`). It is a documented placeholder, **not real enrolment state** — the comment says so explicitly (`SecurityPanel.tsx:4-5`).
- Consequence: there is **no real user self-service** for password change, MFA enroll/disable, session/device list/revoke, or login history anywhere in the product today. This is distinct from the workspace-**admin** session surface (B.2 Sessions), which **is** Implemented: an owner/admin can list and revoke *members'* sessions and force a member to re-authenticate. What is Absent is the *per-user* self-service equivalent — a signed-in user managing their own sessions/devices, password, and MFA on the auth origin's `/account/security` page.

---

## C. Platform-staff console (`apps/admin`)

The admin app calls the internal `/api/v1/admin/*` surface (some slices via `fetchWithAuth`, some via cookie `credentials:"include"`). The backing admin endpoints exist and are mounted (`apps/api/src/features/admin/routes.ts`; `provider-configs`, `audit-log`, `staff`, `impersonation` sub-routers mounted at `routes.ts:248-252`).

| Console feature | Renders (file:line) | Client seam (file:line) | Status | Notes |
|---|---|---|---|---|
| Tenants (directory + detail) | `features/tenants/components/{TenantsPage,TenantDetailPage}.tsx` | `tenants/api.ts:15,23` (`/admin/tenants`, `/:id`) | Implemented (read) | Cross-tenant directory + one org's workspaces/members. Read-only views. |
| Users (cross-tenant) | `features/users/components/UsersPage.tsx` | `users/api.ts:15` (`/admin/users`) | Implemented (read) | `GET /admin/users` is implemented — a cross-tenant user directory backed by `platformAdminRepository.listUsers` through the audited `withPlatformTx` (`apps/api/.../admin/routes.ts:51`). Server-side **search / filter / cursor pagination** and any **remediation actions** (suspend, force-reauth, etc.) are still **Planned** — the current endpoint returns the bounded list only. |
| Staff RBAC | `features/staff/components/StaffPage.tsx` | `staff/api.ts:16,24,35` (`/admin/staff`) | Implemented | List + **grant** + **revoke** staff roles (super_admin-gated, audited). Write-capable — not read-only. |
| Provider configs (Google/Microsoft OAuth, enrichment) | `features/provider-configs/components/ProviderConfigsPage.tsx` | `provider-configs/api.ts:25,36,45` (`/admin/provider-configs`) | Implemented (write) | List masked configs, enable/disable, set monthly budget — all write-capable. Backend `providerConfigs.ts` exists and is mounted (`apps/api/.../admin/routes.ts:248`), and the whole sub-router is gated `requireStaffRole("super_admin")` (`providerConfigs.ts:32`) — provider spend/data-source posture is super-admin only. The slice carries a graceful "endpoint not available" path (`api.ts:27-29`) that does not trigger against the live API. |
| Audit log | `features/audit-log/components/AuditLogPage.tsx` | `audit-log/api.ts` (`/admin/audit-log`) | Implemented (read) | Platform audit viewer (super_admin/compliance_officer-gated). |
| Feature flags | `features/feature-flags/components/FeatureFlagsPage.tsx` | `feature-flags/api.ts:29,37,43,52` (`/admin/feature-flags`) | Implemented | List + upsert + global toggle + per-tenant override. Write-capable. |
| System health | `features/system-health/components/SystemHealthPage.tsx` | `system-health/api.ts` (`/admin/system-health`) | Implemented (read) | Read-only health view. |
| Impersonation-with-consent | (no dedicated admin slice yet) | backend `apps/api/.../admin/impersonation.ts` | Partial | Start/end/list-active sessions + audit (`admin.impersonate.start`/`.end`) are Implemented server-side, but the **scoped, time-boxed impersonation access token is explicitly deferred** (`impersonation.ts:83-84`). No admin-app UI surface found for it in this review. |

> **Note (out of primary scope).** The `platform_audit_log` now has schema, RLS, and reads: `packages/db/src/schema/platformOps.ts`, `packages/db/src/rls/platformOps.sql`, and `packages/db/src/repositories/platformAuditReads.ts` all exist. This document did not deep-review those SQL files; their exact RLS/append-only posture belongs to the platform/security data-layer review and is not asserted here.

---

## Implemented vs. Designed-but-unbuilt (frontend & flows)

### Implemented and wired today
- The full identifier-first login flow: identifier → password/magic/sso → MFA(TOTP) → org → workspace → finalize → cross-domain code → token exchange (`apps/auth/src/app/{login,password,magic,mfa,org,workspace}/...`, `token/exchange/route.ts`).
- Passwordless magic link, registration (email-code verify + profile provision), forgot/reset, org/workspace switch, orgs list, silent refresh, logout, JWKS, security-header middleware, "already signed in" guard.
- Cross-tenant selector membership checks on `selectOrg`/`selectWorkspace`.
- Tenant SSO config, auth policy, auth audit, domains, SCIM token mint/revoke — UI **and** API, behind a real `requireOrgRole` guard.
- Workspace session admin (list/revoke/force-reauth) — UI **and** API, behind `requireRole("owner","admin")`.
- Admin console: tenants/users (read), staff RBAC (write), provider configs (write), audit log (read), feature flags (write), system health (read).

### Stub (renders/threads, but the real boundary is not implemented)
- Real OIDC (`arctic`) and SAML (`@node-saml/node-saml`) IdP adapters — throw; only the dev mock works (`packages/auth/src/sso/providers.ts:16-38`). No production SSO login.
- User ▸ Security panel — read-only deep-links + hardcoded `enrolled:false` catalogue; no seam, no mutation (`apps/web/.../settings-user/components/SecurityPanel.tsx`).

### Absent
- `apps/auth/src/app/oauth/google` — "Continue with Google" target route does not exist.
- `apps/auth/src/app/mfa/recovery` — "Use a recovery code instead" target does not exist.
- `apps/auth/src/app/account/security` — the entire user account-security surface the web app deep-links to does not exist.
- Workspace **members** API (invite/role/remove) — no route in `apps/api/src/features/workspaces/`.
- SCIM 2.0 provisioning protocol endpoints (`/scim/v2/Users` etc.) — token management exists; the IdP-facing protocol does not.

### Partial (works, with a named gap)
- MFA: TOTP live; "trust this device" checkbox renders but is not read by the action; SMS/email/WebAuthn route to `false` in the verifier (`mfaVerify.ts`).
- Auth-policy **enforcement on login**: the policy stores and resolves, MFA-required is enforced at finalize, but allowed-methods gate, IP-allowlist gate, and session-timeout enforcement on the login path are not fully wired.
- Domain verification: the API flips status without a real DNS-TXT check (`identityRoutes.ts:75-78`).
- Impersonation: start/end/audit exist server-side; the scoped token is deferred; no admin UI found.

---

## Backend wiring confirmed in source

The following backends are sometimes assumed to be unbuilt or merely UI-only. Code review confirms each is implemented, mounted, and role-gated — so the status table above reflects the running system, not a placeholder:

1. **`requireOrgRole` / `requireRole` / `requireStaffRole` guards** — present at `apps/api/src/middleware/{requireOrgRole,requireRole,requireStaffRole}.ts` and used by the settings / workspace / admin routers.
2. **Tenant SSO config / auth-policy / auth-audit / domains / SCIM-token APIs** — implemented and mounted (`apps/api/src/features/settings/...`, `app.ts:99`), behind `requireOrgRole`.
3. **Workspace session-admin API** — implemented and mounted (`sessionRoutes.ts`, `app.ts:71`), behind `requireRole("owner","admin")`. A workspace owner/admin can list members' active sessions, revoke one, and force-reauth a member today.
4. **Admin provider-configs / staff RBAC / impersonation backends** — provider-configs (write, `requireStaffRole("super_admin")`), staff RBAC (write), and impersonation (start/end/audit) all exist and are mounted (`apps/api/src/features/admin/routes.ts:248-252`).

**Not deep-reviewed in this pass:** whether automated isolation tests cover the selector membership checks; the exact RLS/append-only posture of the `platform_audit_log` SQL; and whether any admin-app route renders the impersonation surface (none found, but the admin route tree was not exhaustively walked).

---

*Standards references:* PKCE — RFC 7636 (https://www.rfc-editor.org/rfc/rfc7636); OAuth 2.0 — RFC 6749 (https://www.rfc-editor.org/rfc/rfc6749); JWKS / JSON Web Key Set — RFC 7517 (https://www.rfc-editor.org/rfc/rfc7517); RFC 9457 Problem Details — (https://www.rfc-editor.org/rfc/rfc9457); SCIM 2.0 — RFC 7644 (https://www.rfc-editor.org/rfc/rfc7644); WCAG 2.2 — (https://www.w3.org/TR/WCAG22/).
