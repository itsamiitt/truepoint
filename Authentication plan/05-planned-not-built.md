# Designed-but-Unbuilt Authentication Work

This document inventories every authentication capability that TruePoint has **designed or planned but not fully built**, grouped by theme, each with its source doc, current code-level status, and why it matters. It is scoped to the gap between the design (planning docs + `@leadwolf/types` contracts) and the live code in `packages/auth`, `packages/db`, `apps/auth`, `apps/api`, and `apps/web`. Status vocabulary is exact: **Implemented | Partial | Stub | Planned | Absent**.

> **Important accuracy note.** The two source plans most often cited below — `docs/planning/17-authentication.md` and `docs/planning/admin-auth-buildout-plan.md` — predate part of the current code. Several items those plans list as "to do" (the role-guard family, the `org_role`/`platform_staff` migrations, **both** Phase-0 security fixes, and most of the platform-admin API routes) are now **built**. Where the plan and the code disagree, this document reports the **code** as ground truth and flags the divergence. Conversely, the headline enterprise seams (real OIDC/SAML, SCIM 2.0 protocol, the user `/account/security` UI) remain genuinely unbuilt.

---

## A. Real OIDC / SAML adapter wiring

The SSO **flow** (handoff, callback routes, JIT provisioning, per-tenant config storage, mock IdP) is wired end-to-end; the two **real protocol adapters** are deliberate, clearly-marked seams that still throw.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| OIDC provider adapter (`arctic`) | `packages/auth/src/sso/providers.ts:16-26` | **Stub** | `oidcProvider.initiate()`/`validate()` both `throw new Error(oidcUnwired)`. `arctic` is named only in comments (line 4, 12) — never imported. |
| SAML provider adapter (`@node-saml/node-saml`) | `packages/auth/src/sso/providers.ts:28-38` | **Stub** | `samlProvider.initiate()`/`validate()` both `throw new Error(samlUnwired)`. `@node-saml/node-saml` is named in comments only — never imported. |
| Provider selection (mock vs real) | `packages/auth/src/sso/providers.ts:44-47` | **Partial** | `getSsoProvider` returns the working mock when `NODE_ENV !== "production"`; in production it returns the **throwing** real adapter. So SSO is exercisable in dev/test, broken in prod until the seams land. |
| SP- and IdP-initiated SAML; OIDC/OAuth 2.0 | `docs/planning/17-authentication.md:220` | **Planned** | Design calls for SAML SP- **and** IdP-initiated plus OIDC. Neither real protocol path exists yet. |
| Test-connection tool + SSO setup wizard | `docs/planning/17-authentication.md:228-230` | **Planned** | Guided wizard, metadata upload/URL, and a "test-connection" tool are designed for the tenant admin UI; not built. |
| Config storage + masked reads (the part that **is** built) | `packages/types/src/sso.ts:22-53` (`ssoConfigViewSchema`/`ssoConfigUpdateSchema`); tenant `tenant_sso_configs` config persists per ground-truth | **Implemented** | Config CRUD, masked reads (`hasClientSecret`, never the secret), JIT provisioning (`sso/jit.ts`), and the mock IdP are live. Only the **real** IdP validation is missing. |

**Why it matters.** Enterprise customers cannot use real SAML/OIDC SSO in production — the production code path raises immediately. The contract (`ssoConfigUpdateSchema`, fixed ACS/redirect URLs) and the JIT/attribute-mapping logic are ready, so this is adapter-implementation work behind a stable interface, not a redesign.

---

## B. SCIM 2.0 endpoints + group→role mapping + deprovisioning

SCIM **token lifecycle** (mint-once / hash-store / revoke) is built; the SCIM 2.0 **protocol surface** an IdP actually calls is not.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| SCIM 2.0 protocol endpoints (`/scim/v2/Users`, `/Groups`, `ServiceProviderConfig`) | `apps/api/src/features/settings/identityRoutes.ts:16` | **Absent** | Explicit `// WIRE:` comment — the provisioning protocol endpoints an IdP calls are not implemented. No `urn:ietf:params:scim` handlers exist. |
| SCIM **token** management (mint/list/revoke) | `apps/api/src/features/settings/identityRoutes.ts:103-131` | **Implemented** | `GET/POST/DELETE /scim/tokens`; plaintext shown once (`scim_` + 32 random bytes), SHA-256 hashed at rest, soft-revoke. Gated `requireOrgRole("security_admin","owner")` (line 38). Contract: `packages/types/src/identityProvisioning.ts:55-79`. |
| Group → role mapping | `docs/planning/17-authentication.md:226`; `docs/planning/admin-auth-buildout-plan.md:163` | **Planned** | Design mentions SCIM group→role beyond default-role JIT; explicitly listed "out of scope (follow-ups)" in the buildout plan — i.e. deferred, not started. |
| Deprovisioning automation (revoke sessions / reassign records on SCIM delete) | `docs/planning/17-authentication.md:226` ("provision / update / **deprovision**") | **Absent** | The deprovision half of the lifecycle has no implementation; depends on the missing protocol endpoints. |

**Why it matters.** SCIM is enterprise-critical for automated user lifecycle (joiner/mover/leaver). Today an admin can mint a SCIM token, but no IdP can call a SCIM endpoint with it — so there is no automated provisioning or, more importantly, **deprovisioning**, which is the security-sensitive half (a departed employee's access is not auto-revoked).

---

## C. Auth-policy enforcement on the login path

Policy **resolution** is implemented (strictest-wins across tenant + workspace); **enforcement** on login is only partial — one gate (MFA-required) is live, the rest are resolved-but-not-applied.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| Strictest-wins policy resolution | `packages/auth/src/policy.ts:39-54` (`resolveEffectivePolicy`, `intersectMethods`, `tighten`, `isMethodAllowed`, `minDefined`) | **Implemented** | Pure resolution of `mfaEnforcement`, `allowedMethods`, `ipAllowlist`, `sessionTimeoutSeconds` across scopes. Contract `authPolicySchema` at `packages/types/src/auth.ts:150-158`. |
| MFA-required enforcement at finalize | `packages/auth/src/flow.ts:152-160` | **Partial** | A tenant on `mfaEnforcement: "required"` cannot complete login un-MFA'd — `finalizeLogin` throws `ForbiddenError("mfa_required")`. Enrolled users are already challenged earlier (`flow.ts:74-77`). |
| Forced in-login TOTP enrollment | `packages/auth/src/flow.ts:150-151` (inline `WIRE:` comment) | **Planned** | Required-MFA users with **no** method are currently **errored**, not routed to an enrollment screen. The forced-enrollment step is designed (`admin-auth-buildout-plan.md:137`) but the `apps/auth` screen does not exist. |
| Allowed-methods gate on login | `packages/auth/src/policy.ts:51-54` defines `isMethodAllowed`; **not called** from `flow.ts`/`login.ts`/`finishLogin.ts` | **Absent** | The predicate exists but is not invoked anywhere on the login path. A method disallowed by policy is still accepted. |
| IP-allowlist (CIDR) gate on login | resolved at `policy.ts:42`; **no enforcement** in `flow.ts`/`login.ts`/`apps/auth` | **Absent** | The allowlist is resolved into the effective policy but never checked against `clientIp` during login. |
| Session-timeout enforcement | resolved at `policy.ts:43-46`; not applied to session TTL | **Absent** | `sessionTimeoutSeconds` is resolved but does not drive session/refresh lifetime. |
| Admin UI to set these policies | `SecurityAccessPanel.tsx` → `authPolicyRepository` (per ground-truth) | **Implemented** | The policy is editable and persists; the login path simply does not honour most of it yet. |

**Why it matters.** A tenant security admin can configure an IP allowlist, restrict methods, or set a session timeout and the UI will accept it, but the login flow does not enforce three of the four — a **false sense of control**. This is the highest-leverage gap because the contract, storage, resolution, and admin UI are all done; only the enforcement call-sites on the login path are missing.

---

## D. Role guards + org_role / platform_staff migrations

**Now built.** The buildout plan (`admin-auth-buildout-plan.md`, Phase 1) lists these as to-do, but the code has them. Reported here to correct the record.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| `requireOrgRole(...)` guard | `apps/api/src/middleware/requireOrgRole.ts`; applied e.g. `apps/api/src/features/settings/identityRoutes.ts:38`, `ssoRoutes.ts`, `settings/routes.ts` | **Implemented** | Was "Planned" in `admin-auth-buildout-plan.md:44,131`. |
| `requireStaffRole(...)` guard | `apps/api/src/middleware/requireStaffRole.ts`; applied e.g. `apps/api/src/features/admin/impersonation.ts` (`super_admin`/`support`) | **Implemented** | Was "Planned" in `admin-auth-buildout-plan.md:43,131`. |
| Workspace-role guard | `apps/api/src/middleware/requireRole.ts:14-28` (`requireRole`) | **Implemented** | Resolves `workspace_members.role` via `workspaceRepository.getRoleForUser` (RLS-scoped) after authn+tenancy; rejects when no workspace is selected or the role is not allowed. This is the `requireWorkspaceRole` of the plan. |
| `tenant_members.org_role` migration + backfill | `packages/db/src/rls/platform.sql:60-69` (CHECK + `is_tenant_owner → 'owner'` backfill) | **Implemented** | Contract `orgRole` at `packages/types/src/auth.ts:23-30`. |
| `platform_staff` table + RLS + backfill | `packages/db/src/rls/platform.sql:51-72` (ENABLE RLS, no policy = deny-all to `leadwolf_app`, CHECK, `is_platform_admin → super_admin` backfill) | **Implemented** | Contract `staffRole` at `packages/types/src/auth.ts:35-42`; repo `packages/db/src/repositories/platformStaffRepository.ts`. |
| Shared Zod role enums in `@leadwolf/types` | `packages/types/src/auth.ts:16-42` (`workspaceRole`, `orgRole`, `staffRole`) | **Implemented** | Three separate tiers, never one enum (per the IAM mandate). |

**Why it matters.** This was the cross-cutting foundation the buildout plan sequenced first; it is in place, so the dependent admin/auth-admin work is unblocked. The remaining gap is purely **coverage** — confirming every sensitive route composes the right guard (a review task, not new infrastructure).

---

## E. Additional MFA methods + trusted devices

TOTP is live; the other three method types and the trusted-device skip are not.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| SMS OTP | `packages/auth/src/mfaVerify.ts:16-22`; type `"sms"` in `mfaMethodType` (`packages/types/src/auth.ts:10`) | **Stub** | The seam exists: `verifyMfaCode` routes by `input.method`, and a `"sms"` challenge falls through to `return false` (`mfaVerify.ts:22`) — a placeholder, not an absent path. Needs an OTP store + sender (M11). |
| Email OTP | `packages/auth/src/mfaVerify.ts:16-22`; type `"email"` in `mfaMethodType` (`auth.ts:10`) | **Stub** | Same routing seam returns `false` for `"email"` (`mfaVerify.ts:22`). A real email-OTP primitive already exists — `emailVerification.ts` can mint/verify an `email_otp`-purpose code (`packages/auth/src/emailVerification.ts:9`; `purpose` column `packages/db/src/schema/auth.ts:283`) — but it is not yet wired into the MFA challenge step, so the method is still Stub. |
| WebAuthn / passkey | `packages/auth/src/mfaVerify.ts:16-22`; contract `mfaMethodType` at `packages/types/src/auth.ts:10` includes `webauthn`; `identifierRoute` includes `passkey` (`auth.ts:51`) | **Stub** | The login path routes the type (`mfaVerify.ts:22` returns `false` for `"webauthn"`), but there is no WebAuthn ceremony and no `webauthn_credentials` wiring — a placeholder seam, not yet built. |
| TOTP (the part that **is** built) | `packages/auth/src/mfaVerify.ts:16-20` | **Implemented** | Loads enrolled method, decrypts AES-256-GCM secret, verifies via `@oslojs/otp`. |
| Trusted devices — "trust this device 30 days" skip | `trusted_devices` table is schema-only (per ground-truth); not read by login (`flow.ts` does no trusted-device check) | **Stub** | Schema exists; the 30-day MFA-skip is designed (`docs/planning/17-authentication.md:179,214`) but not wired into the challenge step. `mfaVerifySchema.trustDevice` (`auth.ts:77`) is accepted but unused. |
| Recovery-code **regeneration** UI | `docs/planning/17-authentication.md:209,254` | **Planned** | `matchRecoveryCode` verify exists per ground-truth; regenerate/view UI lives on the (absent) `/account/security` screen. |

**Why it matters.** TOTP-only MFA blocks customers who standardize on passkeys/WebAuthn or need SMS/email fallback, and without trusted-device skip the MFA UX is heavier than designed. Enrollment for these methods also depends on the missing user account-security UI (section G).

---

## F. Workspace member-management API (sessions are built)

The workspace-admin **session** management API is built end-to-end; only the **member-management** (invite / role / remove) API is still unbuilt.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| `GET /workspaces/security/sessions` | `apps/api/src/features/workspaces/sessionRoutes.ts:29-57`; mounted `apps/api/src/app.ts:71`; consumed at `apps/web/src/features/settings-workspace/api.ts:83-89` | **Implemented** | Lists a workspace's members' active sessions. Gated `authn` + `tenancy` + `requireRole("owner","admin")` (`sessionRoutes.ts:23-26`); core read `listMemberSessions` (`packages/core/src/auth/adminSessions.ts`). Contract `adminSessionListSchema` at `packages/types/src/auth.ts:181-184`. (The client's 404/501 → `available:false` branch is now a dead fallback — the route exists.) |
| `POST /security/sessions/:sessionId/revoke` | `sessionRoutes.ts:60-76`; consumed `apps/web/.../settings-workspace/api.ts:93-101` | **Implemented** | Ends one member's session (owner/admin only; the core re-checks and writes the `session.revoked` audit). Contract `sessionRevokeResultSchema` at `auth.ts:199-202`. |
| `POST /security/members/:userId/force-reauth` | `sessionRoutes.ts:79-95`; consumed `apps/web/.../settings-workspace/api.ts:103-111` | **Implemented** | Revoke-all-sessions-for-member via core `forceReauthMember` (built on `revokeAllSessionsForUser`); the endpoint that exposes it now exists. |
| Members invite / role / remove | `apps/web/.../settings-workspace/api.ts:43-80` (`/workspaces/current/members*`) | **Absent** | No member route exists in `apps/api` — only `sessionRoutes.ts` and the workspace-CRUD `routes.ts`. All four client calls still return `ok:false` on 404/501. UI (`MembersPanel.tsx`) is fully designed. |
| The graceful "not built" client seam (built) | `apps/web/.../settings-workspace/api.ts:21-23` (`notBuilt(status)`) | **Implemented** | Deliberately surfaces disabled/empty states instead of errors — no fabricated members, no fake saves. (Now only the members path actually hits it; the sessions path resolves against a live route.) |

**Why it matters.** Workspace admins **can** now see, revoke, and force-reauth their members' sessions from the product (sessions API + UI are wired). The remaining gap is **membership management** — invite / change-role / remove a member — which still has no `apps/api` endpoint, so those actions dead-end in the UI. The contract and `MembersPanel` UI are complete, so this is endpoint work in `apps/api`.

---

## G. User account-security UI (auth origin)

The customer-app panel is a read-only map of deep links to an auth-origin route **that does not exist**.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| `auth.truepoint.in/account/security` route | No `apps/auth/src/app/account/` directory exists (verified — `apps/auth/src/app/**/page.tsx` lists login, password, magic, sso, mfa, signup, verify, forgot, reset, org, workspace, sso/mock; **no** account) | **Absent** | The deep-link target is unbuilt. |
| `SecurityPanel` deep-links | `apps/web/src/features/settings-user/components/SecurityPanel.tsx:14-17,58-152` | **Stub** | `authLink()` builds `${AUTH_ORIGIN}/account/security#{password\|mfa\|sessions\|history}` — links to the absent route. Never fakes a mutation (correct), but every link dead-ends today. |
| MFA factor catalogue (enrollment status) | `SecurityPanel.tsx:20-26` | **Stub** | `MFA_METHODS` is hardcoded `enrolled:false` for TOTP/passkey/SMS/email/recovery — it does **not** reflect real enrollment (no status read exists). |
| Password change + strength meter | `docs/planning/17-authentication.md:254`; `SecurityPanel.tsx:44-69` (link only) | **Absent** | No self-service password change on the auth origin. |
| Sign-in **email change** | Sign-in email is read-only in `apps/web` (`ProfilePanel.tsx:100`; `settings-user/types.ts:16`) and "changed on the auth origin" by design (per 04 §profile) — but no `apps/auth/src/app/account/` route serves it | **Absent** | The mutation belongs on the auth origin (it changes the sign-in identifier and an SSO/SCIM-relevant attribute), and that route does not exist. The secure flow must: verify the **new** address (mint/confirm an `email_otp`-purpose code via `emailVerification.ts:9`), re-confirm ownership of the **old** address or require **step-up** (recent-auth / MFA) before committing, then **notify the old address** of the change. **SSO/SCIM interaction:** for IdP-provisioned users the email is owned by the IdP/SCIM source, so this surface must either suppress self-service email edit for provisioned identities or treat the SCIM-pushed value as authoritative — i.e. decide explicitly whether email is even user-editable when the account is externally managed. |
| MFA enrollment wizard (TOTP QR / SMS / WebAuthn) | `docs/planning/17-authentication.md:254` | **Absent** | Enrollment screen is the prerequisite for forced in-login enrollment (section C) and the new methods (section E). |
| Active sessions + device list + revoke (self-service) | `docs/planning/17-authentication.md:253-254`; `SecurityPanel.tsx:105-128` (link only) | **Absent** | Distinct from the workspace-admin sessions API (section F); this is the user's own self-service view. |
| Login history view | `docs/planning/17-authentication.md:254`; `SecurityPanel.tsx:130-153` (link only) | **Absent** | `authAuditEntrySchema` (`auth.ts:139-147`) shapes the data, but no screen renders it. |

**Why it matters.** There is **no real user self-service** for password change, MFA enroll/disable, session/device review, or login history. A user who wants to add MFA or sign out a lost device has nowhere to go. This blocks several other items (forced MFA enrollment, the new MFA methods, recovery-code regeneration) that depend on this screen existing.

---

## H. Platform-admin expansion

Substantially **more built than the plan docs imply**. Several endpoints exist; the gaps are specific (notably the impersonation login-as token).

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| Impersonation session start/end + banner info | `apps/api/src/features/admin/impersonation.ts:26` (`requireStaffRole("super_admin","support")`), `:58-87` (POST start, `withPlatformTx`, time-boxed via `expiresAt`, `reason` min 5 chars, audited `admin.impersonate.start`); mounted `routes.ts:252` | **Partial** | Creates the consent-gated, audited session record and returns banner info, but **does not mint a "login-as" token** — the scoped, time-boxed impersonation access token is explicitly `WIRE-deferred` (file header `:8-9`; `WIRE:` at `:83-85`). So the staff member cannot yet actually enter the tenant's session. |
| Platform audit-log viewer / export | `apps/api/src/features/admin/auditLog.ts`; mounted `apps/api/src/features/admin/routes.ts:250` (`super_admin`/`compliance_officer`) | **Partial** | Viewer route exists; the **export job** (`docs/planning/13-platform-admin.md:53-54,64`) is the remaining piece — confirm whether the async export is wired. |
| Staff RBAC admin (CRUD) | `apps/api/src/features/admin/staff.ts`; mounted `routes.ts:251` | **Implemented** | `super_admin` staff RBAC CRUD over `platform_staff`. |
| Provider-configs API (behind the built UI) | `apps/api/src/features/admin/providerConfigs.ts` (GET list + POST `:provider/enabled` + POST `:provider/budget`, `requireStaffRole("super_admin")`); mounted `routes.ts:248`; schema `packages/db/src/schema/intel.ts:116-120` (`providerConfigs` pgTable), RLS `packages/db/src/rls/providerConfigs.sql` | **Implemented** | The plan listed the provider_configs API as missing (`admin-auth-buildout-plan.md:134`); it now exists, and the enable/budget writes are wired through `withPlatformTx`. `keyHint`/`health` are still `null`/`"unknown"` placeholders (`WIRE:` at `providerConfigs.ts:59,63`). Ground-truth describes the `apps/admin` UI as read-only this phase — confirm whether the admin-side write surface is wired end-to-end. |
| Global users **list** (cross-tenant) | `apps/api/src/features/admin/routes.ts:51-56` (`GET /admin/users` → `platformAdminRepository.listUsers`, audited `withPlatformTx`, bounded `PLATFORM_READ_LIMIT`); shape `packages/db/src/repositories/platformAdminReads.ts:117-128` (id/email/fullName/status/isPlatformAdmin only) | **Implemented** | The plan listed `GET /users` as a new endpoint (`admin-auth-buildout-plan.md:91`; `13-platform-admin.md:36`); the bounded, shaped cross-tenant list now exists (never raw PII beyond what staff may see). The **search/filter/cursor** refinement and `deactivate` are not yet wired. |
| Global-user **remediation** actions (staff) | `docs/planning/13-platform-admin.md:36` (reset MFA / force password reset / revoke sessions) | **Planned** | The per-user remediation actions are designed but absent from the admin routes (`routes.ts` has no reset-MFA / force-reset / revoke-sessions endpoint). |
| Impersonation persistent banner (UI) | `docs/planning/13-platform-admin.md:28`; `admin-auth-buildout-plan.md:117` | **Planned** | API returns banner info; the persistent in-session banner UI is the deferred front-end piece tied to the missing login-as token. |

**Why it matters.** The platform console can already manage staff RBAC, provider configs, view audit, and **list users cross-tenant**; the operationally critical **impersonation login-as** (support entering a tenant to debug) and **global-user remediation** (reset MFA / force-reset / revoke sessions) are the remaining staff-tooling gaps, plus the search/filter refinement over the existing users list. Impersonation specifically stops one step short of useful — the consent/audit scaffolding is there, the actual scoped session token is not.

---

## I. Phase-0 security items

**Both Phase-0 items in `admin-auth-buildout-plan.md` have been remediated in the current code.** The plan describes them as open (one as a "live vuln"); the code shows fixes. The plan's Phase-0 section is historical — the bypass it describes is closed in source.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| Cross-tenant selector bypass — `finalizeLogin` membership check | `packages/auth/src/flow.ts:144-145` (`authorizeTenantSelection(orgs, txn.tenantId)`), `flow.ts:162-166` (workspace `getRoleForUser` → `ForbiddenError`) | **Implemented** | `finalizeLogin` is the authoritative gate; a forged `tenantId`/`workspaceId` is rejected before the token is minted. |
| Cross-tenant selector bypass — `selectOrg` early check | `apps/auth/src/app/org/actions.ts:26` (`if (!(await isActiveTenantMember(...))) redirect("/org?error=1")`) | **Implemented** | The org selector now membership-checks the client-supplied `tenantId` (defence-in-depth + graceful redirect). |
| Cross-tenant selector bypass — `selectWorkspace` early check | `apps/auth/src/app/workspace/actions.ts:28-33` (`isActiveWorkspaceMember(...)`) | **Implemented** | The workspace selector now membership-checks the client-supplied `workspaceId` within the tenant. The plan's "live vuln" (`admin-auth-buildout-plan.md:24-30`) is **closed**. |
| `platform_audit_log` — schema + migration | `packages/db/src/rls/platform.sql:16-27` (idempotent `CREATE TABLE`) + `packages/db/src/schema/platformOps.ts` | **Implemented** | Promoted out of `bootstrapAdmin.ts`; `bootstrapAdmin.ts` no longer creates it (verified — no `platform_audit_log` reference there). |
| `platform_audit_log` — RLS + REVOKE + append-only | `packages/db/src/rls/platform.sql:39-49` (ENABLE RLS, no policy = deny-all to `leadwolf_app`; append-only trigger blocks UPDATE/DELETE for **every** role) | **Implemented** | The blanket grant is additionally REVOKED in the `applyMigrations` grants phase (`platform.sql:13`). The plan's tamper risk (`admin-auth-buildout-plan.md:31-33`) is **closed**. |

**Why it matters.** These were the two highest-severity gaps in the plan. Both are now closed in code, which materially changes the risk posture — but anyone reading only the plan doc would believe a live cross-tenant bypass still exists. The runtime fixes are in place; what remains is to confirm the cross-tenant isolation **test** is present per `admin-auth-buildout-plan.md:152-158` and to re-baseline the Phase-0 section of that plan.

---

## J. Machine / API authentication

Every authentication path in the current code is **human-interactive** (password / magic-link / SSO / MFA, all minting a session cookie). There is **no non-interactive credential** a script, integration, or partner system can present — so customers cannot build automation against TruePoint without driving a user session. None of the following exist in `apps/api`, `packages/auth`, or `@leadwolf/types` today.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| Scoped personal-access tokens (PATs) / service accounts | No PAT or service-account schema in `packages/db/src/schema/auth.ts` (it holds `sessions`, `mfa_methods`, `email_verifications`, `trusted_devices` and the like — no machine-credential table); no mint/verify in `packages/auth`. The nearest existing primitive is the **SCIM token** (`apps/api/src/features/settings/identityRoutes.ts:103-131`), which authenticates the SCIM protocol only, not the general API. | **Absent** | A scoped, revocable token tied to a service identity (not a human session), carrying a least-privilege scope set and a recorded **last-used** timestamp for review/expiry. Mint-once / hash-at-rest / soft-revoke can follow the SCIM-token shape already proven at `identityRoutes.ts:103-131`. |
| OAuth2 client-credentials grant | No token endpoint or client registry in `apps/api`; the SSO `oidcProvider` is an inbound-IdP stub (`packages/auth/src/sso/providers.ts:16-26`), not an outbound issuer | **Absent** | The server-to-server grant ([RFC 6749 §4.4](https://datatracker.ietf.org/doc/html/rfc6749#section-4.4)) for confidential clients that hold no user context — distinct from the inbound OIDC adapter (section A). Needs a client registry, secret hashing, a scope model, and a token endpoint. |
| Outbound-webhook HMAC signing + replay protection | No webhook signer/dispatcher for auth events in `apps/api`/`apps/workers` | **Absent** | Signed delivery so a receiver can verify authenticity: a per-endpoint signing secret, an `HMAC-SHA256` signature over the raw body, a signed **timestamp**, and a receiver-side tolerance window + nonce/idempotency check to defeat replay. Signing-secret rotation must be supported. |
| Mutual TLS (mTLS) for partner/API callers — **explicit decision** | Not present; no client-cert termination policy documented | **Planned** | A deliberate **decision point**, not an assumed build: whether enterprise/partner API callers authenticate with client certificates (mTLS) **in addition to** bearer tokens, or whether bearer PATs + IP allowlisting suffice. The recommendation is to **not** build mTLS speculatively — gate it on a concrete enterprise requirement, since it adds certificate-lifecycle and edge-termination operational cost — but the decision must be recorded either way. |

**Why it matters.** Programmatic access is table-stakes for an enterprise platform: integrations, data pipelines, and partner systems need a credential that is **not** a human's session. Without scoped PATs/service accounts there is no safe, revocable, auditable machine identity; without signed + replay-protected webhooks, outbound events cannot be trusted by receivers. These are **net-new** auth surfaces (no seam exists yet) and are sequenced as their own delivery wave in `08-roadmap.md` — see that doc for where they fall relative to the user-self-service and SSO/SCIM waves.

---

## K. Account-lifecycle & recovery edge cases (user-facing)

Admin-side remediation is already **Planned** in section H (staff reset-MFA / force-password-reset / revoke-sessions). The items below are the **user-facing** and **lost-both-factors** parts of the lifecycle that section H does not cover — the situations a user hits on their own, with no admin in the loop.

| Item | Where (file:line or doc) | Status | Notes |
|---|---|---|---|
| Lost-MFA **and** lost-email recovery | Self-service recovery assumes email control (`passwordReset.ts` → `emailVerification.ts`); `matchRecoveryCode` covers lost-MFA-but-has-email; **neither** covers losing both | **Planned** | When a user loses their MFA device **and** their recovery codes **and** their email is also inaccessible, there is no self-service path — by design, since one would be an account-takeover vector. This must thread into the **staff remediation tooling** (section H): an identity-verified, audited, consent-gated admin action, never a self-service reset. The scope of this item is the **hand-off** — how the user requests recovery and how their identity is verified — with the remediation action itself owned by section H. |
| Self-service deactivation / deletion of auth artifacts | No `/account` route exists (section G); deletion of the broader record is the data-skill deletion path, not built here | **Planned** | A user-initiated deactivate/close-account flow that revokes sessions, disables sign-in, and tears down **auth** artifacts (MFA methods, trusted devices, SCIM linkage, PATs from section J). Must be **coordinated with the data-skill deletion/retention path**: auth owns invalidating credentials and sessions; the data path owns deleting the underlying record, so this auth teardown is one input to record deletion/DSAR, not a substitute for it. |
| Username change | `usernameSchema` exists and a username can alias the email at login (`packages/types/src/auth.ts:89-103`; `identifier` resolves email-or-username at `auth.ts:96`), but there is no change-username surface (no `apps/auth/src/app/account/` route) | **Absent** | Changing the optional username alias. Lower-risk than the email change (it is not the primary sign-in identifier of record), but it still belongs on the auth origin and must enforce uniqueness and re-validate the alias format against `usernameSchema`. |
| Post-lockout self-service unlock UX | Rate-limit / lockout is enforced on the login path, but no user-facing unlock/cooldown screen exists in `apps/auth` (no `account`/unlock route) | **Planned** | After repeated failed attempts a user needs a clear, abuse-resistant way back in: a communicated cooldown or an email-verified unlock, distinct from password reset. The UX must not become an enumeration or lockout-bypass oracle — it tells the legitimate user what to do without confirming to an attacker that the account exists. |

**Why it matters.** These are the lifecycle "unhappy paths" enterprises probe in security review. The lost-both-factors case is the highest-stakes: it must exist (users do lose everything) yet must route to identity-verified staff remediation, never to a self-service reset an attacker could drive. Deactivation/deletion is a compliance touch-point (it feeds DSAR/retention on the data side). All four depend on the absent `/account` surface (section G) and are sequenced in `08-roadmap.md`.

---

## Summary of true remaining gaps (highest impact first)

1. **Auth-policy enforcement on login** (section C) — IP allowlist, allowed-methods, and session-timeout are resolved but not enforced; admin UI accepts settings the login path ignores. Highest leverage (everything but the call-site is done).
2. **User account-security UI on the auth origin** (section G) — the `/account/security` route is Absent; no real self-service for password/MFA/sessions/history. Blocks sections C (forced enrollment) and E (new methods).
3. **Real OIDC/SAML adapters** (section A) — Stub; production SSO throws.
4. **SCIM 2.0 protocol + deprovisioning** (section B) — Absent; no automated joiner/leaver lifecycle.
5. **Workspace member-management API** (section F) — Absent; invite/role/remove have no endpoint. (The workspace **sessions** API — list/revoke/force-reauth — is already built and wired.)
6. **Additional MFA methods + trusted devices** (section E) — Stub; only TOTP fully verifies. SMS, email-OTP, and WebAuthn are routed seams (`mfaVerify.ts:22` returns `false`) plus the trusted-device 30-day skip is schema-only.
7. **Impersonation login-as token + global-user remediation** (section H) — Partial/Planned; staff tooling stops one step short. The bounded cross-tenant users **list** (`GET /admin/users`) and the provider-configs API are already built; the search/filter refinement and reset-MFA / force-reset / revoke-sessions remediation are the gaps.
8. **Machine / API authentication** (section J) — Absent; no scoped PATs/service accounts, no client-credentials grant, no signed+replay-protected outbound webhooks, and an open mTLS decision. The whole non-interactive credential surface is net-new.
9. **Account-lifecycle & recovery edge cases** (section K) — Planned/Absent; lost-both-factors recovery (routes to staff remediation), self-service deactivation/deletion of auth artifacts, username change, and post-lockout unlock UX — all depend on the absent `/account` surface (section G).

Sections **D** (role guards + migrations) and **I** (Phase-0 security) are **already built** and are documented here only to correct the planning docs, which still list them as outstanding.

### Uncertain / to-verify

- **Audit-log export job** and the **provider-configs admin-side write surface** (section H) — the provider-configs API writes (enable/budget) are built and audited; what was not confirmed at file:line is the async audit **export** job and whether the `apps/admin` UI write controls are wired end-to-end. Verify before sign-off.
- **Cross-tenant isolation test coverage** for the new admin/auth-admin endpoints (`admin-auth-buildout-plan.md:152-158`) — the runtime fixes are in; the mandated test was not located in this pass.
