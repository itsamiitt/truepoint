# Recommended Additional Settings to Plan

This document recommends **new** authentication settings — admin-side (tenant/workspace) and user-side (own account) — that TruePoint should add to the roadmap. Every recommendation is grounded in (a) what the codebase already does or merely scaffolds today, and (b) the enterprise IAM benchmark (Okta, Microsoft Entra, WorkOS) and the standards baseline (NIST SP 800-63B-4, OWASP ASVS 5.0, FIDO/CAEP). These are recommendations to **plan**, not claims that anything below is built — where a TruePoint surface already exists it is cited as `Implemented`/`Partial`/`Stub`, and each recommendation is mapped to its owning `truepoint-*` skill so the team knows who specs and enforces it.

> **Status vocabulary (used throughout):** `Implemented` (wired end-to-end) · `Partial` (some of the path wired, enforcement/UI incomplete) · `Stub` (code/seam exists but throws or returns a placeholder; never wired) · `Planned` (designed in docs/types, no code) · `Absent` (no code, no seam).

---

## 1. What exists today — the baseline these recommendations build on

This is the substrate. Recommendations in §3 and §4 either fill a gap here or harden one of these.

| Capability | Where | Status | Notes |
|---|---|---|---|
| Password hashing (Argon2id, 19 MiB / t=2 / p=1) | `packages/auth/src/password.ts:5` | Implemented | Fail-closed verify; no length/breach/reuse policy on top yet. |
| TOTP MFA verify | `packages/auth/src/mfa.ts:12`, `packages/auth/src/mfaVerify.ts:16` | Partial | TOTP live; `mfaVerify.ts:22` returns `false` for every non-TOTP method. |
| MFA method catalogue (totp/sms/email/webauthn) | `packages/types/src/auth.ts:10` | Partial | Type surface complete; only TOTP verifies. |
| Session lifecycle + refresh rotation + reuse detection | `packages/auth/src/session.ts:31-123` | Implemented | SHA-256 hash only; 30s reuse grace → family revocation. |
| Auth-policy resolution (strictest-wins tenant+workspace) | `packages/auth/src/policy.ts:33-48` | Partial | Resolution implemented; **only** `mfaEnforcement === "required"` is enforced on login (`packages/auth/src/flow.ts:152-160`). |
| Tenant auth-policy store (MFA, allowed methods, requireSso, disableSocial, IP allowlist, session timeout) | `packages/db/src/schema/auth.ts:246-259`; UI `apps/web/src/features/settings-tenant/components/SecurityAccessPanel.tsx` | Partial | Persists; allowed-methods / IP-allowlist / session-timeout gating is **not** wired on login. |
| SSO config store + masked reads + write-only secret | `packages/db/src/schema/auth.ts:226-244`; UI `apps/web/src/features/settings-tenant/components/SsoConfigPanel.tsx` | Partial | Config persists; real protocol validation does not run. |
| Real OIDC / SAML adapters | `packages/auth/src/sso/providers.ts:16-38` | Stub | Both `initiate`/`validate` **throw** "…SSO is not configured"; production returns the throwing adapter, non-prod returns the mock IdP (`providers.ts:44-47`). |
| SCIM token mint/revoke | `apps/web/src/features/settings-tenant/components/IdentityPanel.tsx:273-311` | Partial | Token lifecycle wired; **SCIM 2.0 endpoints + deprovisioning are Absent.** |
| Trusted-device table | `packages/db/src/schema/auth.ts:208-224` | Stub | Schema only (`trustedUntil` 30-day window column present); **not read by the login path.** |
| Rate limiting / lockout | `packages/auth/src/rateLimit.ts:20-44` | Implemented | IP 30/min, identifier 10/min, fail-open on Redis outage. |
| Workspace-admin session management (list members' sessions, revoke, force-reauth) | `apps/api/src/features/workspaces/sessionRoutes.ts` (mounted `app.ts:71`); core `packages/core/src/auth/adminSessions.ts`; UI `apps/web/src/features/settings-workspace/components/SessionsPanel.tsx` | Implemented | Wired end-to-end: live `GET /workspaces/security/sessions` + revoke + force-reauth, owner/admin-gated with `session.revoked` audit. The "Not available yet" toast (`SessionsPanel.tsx:63-67`) is a dead 501-only fallback the live route never returns. |
| Workspace members UI | `apps/web/src/features/settings-workspace/components/MembersPanel.tsx` | Partial | UI complete; backing members API Absent — mutations surface "Not available yet" (`MembersPanel.tsx:32-33`). |
| User self-service security UI | `apps/web/src/features/settings-user/components/SecurityPanel.tsx` | Stub | Read-only; deep-links to `AUTH_ORIGIN/account/security` (`SecurityPanel.tsx:15-17`) and the MFA list is hardcoded `enrolled:false` (`SecurityPanel.tsx:20-26`). |
| Auth-origin `/account/security` route | `apps/auth/src/app/account/` | Absent | Directory does not exist; the user panel above links to a route with no implementation. |

**Standards baseline that frames the gaps:** NIST SP 800-63B-4 (final, Jul 2025) mandates breach-list screening of passwords and removes forced rotation/composition rules ([NIST SP 800-63B-4 §3.1.1](https://pages.nist.gov/800-63-4/sp800-63b.html)); OWASP ASVS 5.0 V6 covers password, MFA, lifecycle, and session-management verification requirements ([ASVS 5.0 V6](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md)). Both are the floor these recommendations target.

---

## 2. How to read the recommendations

Each row gives: **Setting** | **Surface** (admin = tenant/workspace; user = own account) | **What it controls** | **Business priority** | **Delivery wave (08)** | **Skill owner** | **Enterprise precedent**. The detailed gap and TruePoint citation follow each table.

> **Two different axes — business priority ≠ delivery wave.** The **Business priority** column here ranks *how badly an enterprise needs the setting* (deal-blocking → nice-to-have). The **Delivery wave (08)** column maps each setting to the dependency-sequenced wave it lands in per [`08-roadmap.md`](./08-roadmap.md). They are independent: an item can be high business-priority yet sequenced into a late wave because it depends on earlier work. **Passkeys are the canonical example — P0 business priority but P3 delivery wave**, because self-service passkey enrollment depends on the P1b `/account/security` wizard existing first. Read the two columns together: the first says *how much it matters*, the second says *when it can realistically ship*.

Business priorities:

- **P0** — enterprise-blocking or closes a known security gap; needed before TruePoint can sell to a security-reviewed buyer.
- **P1** — strong enterprise expectation; differentiates on a competitive RFP.
- **P2** — valuable hardening / parity, not a deal-blocker.
- **P3** — nice-to-have / future.

Skill owners follow the precedence in `CLAUDE.md`: **security** owns whether a control is safe and where enforcement lives; **platform** owns the API/enforcement-path and scale; **data** owns the model and deprovisioning semantics; **architecture** owns the frontend feature; **design** owns what renders.

---

## 3. Recommended ADMIN-side settings (tenant / workspace)

### 3.1 Inventory

| Setting | Surface | What it controls | Business priority | Delivery wave (08) | Skill owner | Enterprise precedent |
|---|---|---|---|---|---|---|
| Full password policy (min length, breached-list screening, block reuse) | Admin (tenant) | Strength floor + HIBP-style breach screening + reuse block on set/reset | **P0** | **P0** | security (+platform enforce) | NIST 800-63B-4 §3.1.1 (breach screen, no composition rules) |
| Per-method MFA enforcement + phishing-resistant / passkey-first | Admin (tenant) | Require MFA *and* require a specific strength (e.g. WebAuthn) per app/role | **P0** | **P3** | security (+platform) | Entra authentication strengths; Okta per-app policy |
| Adaptive / risk rules (new-device, geo, impossible-travel → step-up) | Admin (tenant) | Conditional step-up or block on a risk signal | **P1** | **P3** | security (+platform) | Entra Conditional Access; Okta behavior detection |
| Concurrent-session cap + idle & absolute session timeout | Admin (tenant/workspace) | Max live sessions per user; idle and hard expiry | **P1** | **P1** | security (+platform) | Okta global session policy; ASVS 5.0 V6 session reqs |
| Trusted-device policy + admin revoke-all | Admin (tenant) + user | "Remember this device" window length; admin force-revoke | **P2** | **P3** | security (+data) | Entra "remember MFA"; Okta device trust |
| IP allowlist UX + named locations | Admin (tenant) | Reusable named CIDR sets; allowlist *enforced* on login | **P1** | **P1** | security (+platform) | Entra named locations; Okta network zones |
| Staff-app hardening (mandatory phishing-resistant MFA, IP/network allowlist, step-up before impersonation) | Admin (platform) | Locks down `apps/admin` + `platform_staff` access and re-auth before "login-as" | **P0** | **P3** | security (+platform) | Google BeyondCorp admin-tier; privileged-access workstation guidance |
| SCIM deprovisioning behavior (revoke sessions / reassign records) | Admin (tenant) | What happens to sessions + owned data when an IdP deactivates a user | **P0** | **P2** | data (+security) | WorkOS Directory Sync; SCIM 2.0 deprovisioning |
| CAEP / Shared-Signals inbound + outbound | Admin (tenant) | Real-time session revocation across IdP↔SP | **P2** | **P3** | security (+platform) | OpenID CAEP/SSF (final 2025) |
| Sign-in / security alerts (admin) | Admin (tenant) | Notify admins of new-device, SSO failures, policy changes | **P1** | **P3** | platform (+design) | Entra/Okta sign-in alerting |
| SSO test-connection + enforced-with-break-glass | Admin (tenant) | Validate IdP before enabling; emergency local-login bypass | **P0** | **P2** | security (+platform) | WorkOS Admin Portal test; Okta/Entra break-glass guidance |
| OAuth-app & service-account / PAT management | Admin (tenant) | Issue/scope/revoke machine credentials, see last-used | **P1** | **P3** | platform (+security) | GitHub/Okta API tokens; least-privilege service accounts |
| Workspace-level policy tightening | Admin (workspace) | Workspace may only *strengthen* tenant policy | **P2** | **P1** | security (+platform) | Okta nested policy; existing `resolveEffectivePolicy` |
| Session-revocation & access-review exports | Admin (tenant) | Bulk revoke; export who-can-access for audit / SOC 2 | **P1** | **P1** (bulk revoke) / **P3** (export) | data (+platform) | SOC 2 access review; WorkOS audit logs |

### 3.2 Detail and TruePoint gap

**Full password policy** — `password.ts:7` hashes with Argon2id but applies **no** strength floor beyond the Zod `min(8)` on signup (`packages/types/src/auth.ts:104`), no breach screening, and no reuse history. NIST 800-63B-4 now *requires* screening new passwords against a known-breached list and *forbids* composition/rotation rules ([NIST 800-63B-4 §3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html)). **Plan:** add tenant-configurable min length (≥8, default 12), HIBP k-anonymity breach check, and a reuse block, enforced on the auth origin's password set/reset path. *Owner: security defines the rule; platform enforces it in `apps/auth`.*

**Per-method MFA enforcement + phishing-resistant / passkey-first** — today only `mfaEnforcement === "required"` is honored, and only as a binary at `flow.ts:152-160`; the `allowedMethods` and method *strength* are not enforced. Entra models this as **authentication strengths** (e.g. "phishing-resistant MFA") that a policy can demand ([Entra passkey/FIDO2](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-passkeys-fido2)); CISA names phishing-resistant MFA the strongest tier ([FIDO passkeys](https://fidoalliance.org/passkeys/)). **Plan:** a per-tenant (and optionally per-role) control to require MFA *and* require a minimum strength — e.g. "passkey or hardware key only" for `security_admin`/`owner`. The `mfaMethodType` enum already includes `webauthn` (`auth.ts:10`), so the type surface exists. *Owner: security; platform wires the gate at `flow.ts` finalize.*

**Adaptive / risk rules** — the planning doc already designs new-device / new-geo / impossible-travel → step-up (`docs/planning/17-authentication.md:201-202`), and `trusted_devices` carries `lastIp`/`lastGeo` (`schema/auth.ts:217-218`), but no risk engine exists. This is the Entra Conditional Access if-then model ([Entra CA overview](https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview)) and Okta behavior detection ([Okta sign-on policies](https://help.okta.com/oie/en-us/content/topics/identity-engine/policies/about-okta-sign-on-policies.htm)). **Plan:** a rules surface (new device → require MFA; impossible travel → block + alert). *Owner: security defines signals/decisions; platform builds the evaluation in the login flow and at refresh.* **Consent / lawful basis:** device-, IP-, and geo-based risk profiling processes personal data, so a lawful basis under GDPR Art. 6 (and a DPDP consent/legitimate-use ground) must be established and documented **before** profiling ships — captured in the consent/lawful-basis register, not assumed. See [`10-operations-and-compliance.md` → "Consent & lawful basis"](./10-operations-and-compliance.md).

**Concurrent-session cap + idle & absolute timeout** — `sessionTimeoutSeconds` exists in the policy schema (`auth.ts:156`) and store (`schema/auth.ts:257`) and is collected in the UI (`SecurityAccessPanel.tsx:195-210`), but it is **not enforced** on the session, and there is no concurrent-session cap or absolute (non-idle) lifetime. Okta's global session policy exposes idle + max lifetime ([Okta sign-on policies](https://help.okta.com/oie/en-us/content/topics/identity-engine/policies/about-okta-sign-on-policies.htm)); ASVS 5.0 V6 requires re-authentication and session-timeout controls ([ASVS 5.0 V6](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md)). **Plan:** enforce idle + absolute timeout against the session row, and add a per-user concurrent-session cap (oldest evicted). *Owner: security policy; platform enforces at refresh (`refresh.ts`) and session create.*

**Trusted-device policy + admin revoke-all** — the table is a stub (`schema/auth.ts:208-224`) not read by login, and there is no admin control over the trust window or a revoke-all. Entra's "remember MFA on trusted device" and Okta device trust are the precedents. **Plan:** admin-set window length (default 30 days, matching the `trustedUntil` column intent), per-device naming, and an org-wide "revoke all trusted devices" (e.g. after an incident). *Owner: security; data owns the device model + revoke semantics.* **Consent / lawful basis:** trusted-device tracking persists device/IP/geo signals (`schema/auth.ts:217-218`) tied to an identifiable user, so it requires the same documented GDPR/DPDP lawful basis as risk profiling above — recorded before the feature ships. See [`10-operations-and-compliance.md` → "Consent & lawful basis"](./10-operations-and-compliance.md).

**IP allowlist UX + named locations** — the allowlist is collected as raw CIDR text (`SecurityAccessPanel.tsx:212-224`) and resolved strictest-wins (`policy.ts:42`) but **not enforced** on login, and there is no reusable "named location" concept. Entra **named locations** make CIDR sets reusable and auditable ([Entra CA overview](https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview)). **Plan:** named-location objects, CIDR validation in the UI, and actual enforcement at the token gate. *Owner: security; platform enforces.*

**Staff-app hardening** — the platform-staff RBAC path is built: `requireStaffRole` resolves the active role per-request from `platform_staff` (`apps/api/src/middleware/requireStaffRole.ts:15-28`), the provider-config sub-router is gated `requireStaffRole("super_admin")` (`apps/api/src/features/admin/providerConfigs.ts:32`), and writes are audited via `withPlatformTx`. What is missing is **hardening of the staff surface itself**: there is no mandatory-MFA requirement on `platform_staff` members, no IP/network allowlist on `apps/admin`, and the impersonation flow records a consent session + banner but is WIRE-deferred before minting a login-as token (`apps/api/src/features/admin/impersonation.ts:83-86`) — so there is no step-up re-auth gate in front of it yet. Cross-tenant staff access is the highest-blast-radius credential in the system and should sit behind privileged-access controls ([Google BeyondCorp](https://cloud.google.com/beyondcorp); [Microsoft privileged-access guidance](https://learn.microsoft.com/en-us/security/privileged-access-workstations/privileged-access-strategy)). **Plan:** require phishing-resistant MFA (passkey/hardware key) for **every** `platform_staff` grant; put `apps/admin` behind an IP allowlist / corporate-network requirement; and require a fresh step-up re-authentication immediately before any impersonation "login-as" is minted, recorded in `platform_audit_log`. *Owner: security defines the privileged-access policy; platform enforces it at the admin edge and at the impersonation mint.*

**SCIM deprovisioning behavior** — SCIM **tokens** mint/revoke (`IdentityPanel.tsx:273-311`) but the SCIM 2.0 endpoints and the deprovisioning *behavior* are Absent. This is the enterprise-critical half: when the IdP deactivates a user, TruePoint must revoke their sessions and decide what happens to records they own (reassign vs. lock). WorkOS Directory Sync treats deprovisioning as a first-class event ([WorkOS Directory Sync](https://workos.com/docs/directory-sync)). **Plan:** a tenant setting for deprovisioning behavior — revoke sessions immediately (reuse `revokeAllSessionsForUser`, `session.ts:84`) and choose a record-reassignment target. *Owner: data (record ownership/reassignment) + security (session revocation).*

**CAEP / Shared-Signals (inbound + outbound)** — Absent. OpenID CAEP/SSF was finalized in 2025 and is adopted by Google/Apple/Okta for real-time, cross-domain session revocation ([OpenID CAEP final](https://openid.net/specs/openid-caep-1_0-final.html); [FIDO + SSF](https://fidoalliance.org/white-paper-fido-and-the-shared-signals-framework/)). **Plan (later phase):** consume IdP session-revoked / credential-change signals to kill TruePoint sessions, and emit our own on revocation. *Owner: security defines the trust model; platform builds the receiver/transmitter.*

**Sign-in / security alerts (admin)** — no admin alerting on new-device sign-in, repeated SSO failures, or policy changes; the audit feed exists (`AuthAuditList` in `SecurityAccessPanel.tsx:236`) but is pull-only. **Plan:** opt-in admin notifications for security-relevant events. *Owner: platform (event → notification); design for the preference UI.*

**SSO test-connection + enforced-with-break-glass** — `enforced` persists (`SsoConfigPanel.tsx:308-318`) but there is no way to *validate* the IdP before enabling, and no break-glass path if enforced SSO + a broken IdP locks everyone out. Worse, the real adapters throw (`providers.ts:16-38`), so enforcing SSO in production today is a lockout. WorkOS's Admin Portal includes a connection test ([WorkOS Directory Sync](https://workos.com/directory-sync)). **Plan:** a test-connection tool (depends on real adapters landing) and a documented, audited break-glass local-login for `owner`. *Owner: security (break-glass policy) + platform (test tool).*

**OAuth-app & service-account / PAT management** — Absent for tenants. Enterprises expect to issue scoped machine credentials, see last-used, and revoke. **Plan:** tenant-scoped API tokens/service accounts with least-privilege scopes and last-used tracking. *Owner: platform (token issuance/scoping) + security (scope review).*

**Workspace-level policy tightening** — the resolution engine already supports workspace-only tightening (`policy.ts:16-48`), but no workspace UI exposes it (the workspace settings surface today has the Implemented session-management panel plus an unwired members panel — neither is a policy surface). **Plan:** a small workspace policy surface that can *only* strengthen the tenant policy, reusing `resolveEffectivePolicy`. *Owner: security; platform enforces the "never relax" invariant.*

**Session-revocation & access-review exports** — `revokeAllSessionsForUser` exists (`session.ts:84`) but no admin bulk-revoke UI or access-review export. SOC 2 access reviews need a "who can access what" export. **Plan:** admin bulk session revocation + a periodic access-review export. *Owner: data (the access snapshot) + platform (the API).*

---

## 4. Recommended USER-side settings (own account)

> **Hard dependency:** every user-side recommendation requires the auth-origin route `apps/auth/src/app/account/security` to exist. It is **Absent** today — `SecurityPanel.tsx:15-17` deep-links to it, but there is no `apps/auth/src/app/account/` directory, and the MFA list there is hardcoded `enrolled:false` (`SecurityPanel.tsx:20-26`). All of §4 is therefore `Planned`/`Absent` until that route is built. The customer app (`apps/web`) holds no credentials by design, so these must live on `auth.truepoint.in`, not `apps/web`.

### 4.1 Inventory

| Setting | Surface | What it controls | Business priority | Delivery wave (08) | Skill owner | Enterprise precedent |
|---|---|---|---|---|---|---|
| Passkey enrollment / management | User | Add/name/remove passkeys; passkey-first sign-in | **P0** | **P3** | security (+platform) | FIDO passkeys; B2B SaaS self-service norm |
| MFA method management + recovery-code regeneration | User | Enroll/disable TOTP/SMS/email/WebAuthn; regenerate recovery codes | **P0** | **P1** (TOTP/recovery) / **P3** (SMS·email·WebAuthn) | security (+platform) | NIST 800-63B recovery; Okta/Entra self-service MFA |
| Self-service sessions + device list + revoke (own account) | User | See *your own* live sessions/devices; sign out one or all | **P0** | **P1** | security (+platform) | B2B SaaS norm; Okta/Entra "my sessions" |
| Secure email-change flow | User | Change the account email with dual verification + step-up + revert window | **P1** | **P1** | security (+platform) | Okta/Entra verified email change; account-takeover hardening norm |
| Trusted devices (user view) | User | See/forget remembered devices | **P2** | **P3** | security (+data) | Entra "remember MFA" device list |
| Login / security history | User | Recent sign-ins: time, device, location, origin | **P1** | **P1** | platform (+design) | Okta/Entra activity log |
| Sign-in alert preferences | User | Email me on new-device / new-location sign-in | **P2** | **P3** | platform (+design) | Consumer + B2B SaaS norm |
| Connected SSO / social accounts | User | View/unlink linked Google/Microsoft/SSO identities | **P2** | **P3** | security (+data) | OAuth account-linking norm |
| Account-recovery setup | User | Recovery email/codes; recovery without locking out | **P1** | **P1** | security (+platform) | NIST 800-63B recovery; B2B SaaS norm |

### 4.2 Detail and TruePoint gap

**Passkey enrollment / management** — `authMethod` includes `passkey` and `mfaMethodType` includes `webauthn` (`auth.ts:7,10`), and the planning doc designs WebAuthn/passkey/hardware-key (`17-authentication.md:209`), but **nothing is built** — `mfaVerify.ts:22` returns `false` for `webauthn`. FIDO recommends synced passkeys for the workforce with hardware keys for privileged users ([FIDO passkeys](https://fidoalliance.org/passkeys/); device-bound vs synced: [arXiv 2501.07380](https://arxiv.org/abs/2501.07380)). **Plan:** a passkey enroll/name/remove UI on the auth origin, with WebAuthn registration + verification. *Owner: security (WebAuthn ceremony correctness) + platform.*

**MFA method management + recovery-code regeneration** — `matchRecoveryCode` exists (`mfa.ts:24`) but there is no regeneration UI, and the user catalogue is a hardcoded placeholder (`SecurityPanel.tsx:20-26`). NIST 800-63B treats recovery codes as a recognized recovery mechanism ([NIST 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)). **Plan:** real enroll/disable for each method that reflects `user_mfa_methods`, plus recovery-code view/regenerate. *Owner: security + platform.*

**Self-service sessions + device list + revoke (own account)** — the *workspace-admin* session surface is already **Implemented** (a workspace owner/admin can list members' active sessions and revoke one or force-reauth — `apps/api/src/features/workspaces/sessionRoutes.ts`, core `adminSessions.ts`, `SessionsPanel.tsx`; §1 baseline). What is **Absent** is the *per-user* self-service equivalent: a user managing their **own** sessions/devices on the auth-origin `/account/security` page. The primitives are there (`revokeSession` / `revokeAllSessionsForUser`, `session.ts:78,84`), but there is no end-user "where you're signed in" view. This is a baseline B2B SaaS self-service expectation ([WorkOS B2B user management](https://workos.com/blog/user-management-for-b2b-saas)). **Plan:** an own-account "where you're signed in" list + revoke one / sign out everywhere on the auth origin, reusing the existing revoke primitives — do **not** rebuild the admin surface, which already ships. Pair it with the advanced controls that are still missing org-wide (idle + absolute session timeout, concurrent-session cap, trusted-device management UI, and CAEP/Shared-Signals) from §3. *Owner: security + platform.*

**Secure email-change flow** — the account email is the primary recovery channel, yet there is no self-service change path today (the only email-touching auth flow is password reset, `packages/auth/src/passwordReset.ts`, which force-revokes sessions on completion). An unverified or single-confirmation email change is a classic account-takeover vector. **Plan:** on `/account/security`, gate an email change behind (1) **step-up re-authentication** (re-enter password / pass MFA) before the change is accepted; (2) **verification of both addresses** — a confirmation link/code to the **new** address *and* a notice to the **old** address; (3) a **notify-and-revert window** — email the old address with a one-click revert link valid for a defined window so a hijack is recoverable; and (4) an **audit event** for request and completion (reuse the `recordAuthEvent` sink and the existing `password.reset.request` / `password.reset.complete` precedent at `packages/types/src/billing.ts:120-121` as the model for a paired `email.change.request` / `email.change.complete`). **SSO/SCIM-provisioned users:** when the email is mastered by the IdP/directory, the field is **non-editable** in TruePoint — surface it read-only with a "managed by your identity provider" affordance rather than a change form, so a directory sync never silently overwrites a user-set value. *Owner: security (re-auth + revert-window design) + platform (the verified-change state machine).*

**Trusted devices (user view)** — depends on the trusted-device feature (§3, currently a stub at `schema/auth.ts:208-224`); it carries **business priority P2** but maps to **delivery wave P3** because the user-facing list cannot ship until the backend trusted-device feature (itself P3 in the roadmap) lands — a high-enough-priority view that is correctly sequenced late behind its dependency. **Plan:** let users see and forget their own remembered devices. *Owner: security + data.*

**Login / security history** — the audit vocabulary and `recordAuthEvent` exist (`auditEvent.ts`), but no user-facing history view. **Plan:** a paginated recent-activity list (time, device, location, origin). *Owner: platform (the query) + design.*

**Sign-in alert preferences** — the planning doc designs a new-device email alert (`17-authentication.md:202`); no preference control exists. **Plan:** per-user toggle for new-device/new-location alerts. *Owner: platform + design.*

**Connected SSO / social accounts** — `oauth`/`sso` are auth methods (`auth.ts:7`) and JIT provisioning exists (`sso/jit.ts`), but users cannot see or unlink their linked identities. **Plan:** a connected-accounts list with safe unlink (never unlink the last credential). *Owner: security (don't strand the account) + data.*

**Account-recovery setup** — no recovery configuration today beyond reset (`passwordReset.ts`, which force-logs-out on completion). **Plan:** recovery email + recovery codes setup so a user with a lost factor can recover without an admin, without weakening the primary path. *Owner: security + platform.*

---

## 5. Sequencing recommendation (planning, not commitment)

> This list is a **delivery-order** view, so it tracks the **Delivery wave (08)** column above (and the waves in [`08-roadmap.md`](./08-roadmap.md)), **not** the business-priority labels in the §3/§4 inventories. A setting can be P0 business-priority yet appear late here when it sits behind a dependency — e.g. passkeys (P0 priority) wait on the `/account/security` route below.

1. **Unblock the foundations (P0 prerequisites):** build the auth-origin `/account/security` route (Absent today) and land the real OIDC/SAML adapters (Stub today). Nothing user-facing in §4 and no real SSO enforcement in §3 can ship until these exist.
2. **Close the enforcement gaps (P0):** wire allowed-methods, IP-allowlist, and session-timeout enforcement onto the login path (the policy *resolves* but does not *enforce*); add password breach screening; define SCIM deprovisioning behavior.
3. **Self-service P0s:** passkey + MFA management + own-account sessions/devices, all on the auth origin (the workspace-admin session surface already ships — this is the per-user equivalent, not a rebuild).
4. **Enterprise differentiators (P1):** adaptive risk rules, named locations, access-review exports, SSO test-connection + break-glass, admin alerts.
5. **Parity / future (P2–P3):** trusted-device policy UX, CAEP/SSF, connected-accounts, sign-in alert preferences.

**Cross-cutting note (security has final say):** one Phase-0 item flagged elsewhere is still a **prerequisite**, not a new setting — confirming the org/workspace *selector* endpoints (not just `finalizeLogin`) enforce membership-checking via `scopeGuard.authorizeTenantSelection` (`flow.ts:145`) — and it gates the access-review/export and CAEP recommendations above. The related `platform_audit_log` lockdown is **no longer an open gap**: it is already `Implemented` (created idempotently with deny-all RLS + an append-only `BEFORE UPDATE OR DELETE` trigger in `packages/db/src/rls/platform.sql:16-49`, with the blanket `leadwolf_app` GRANT additionally `REVOKE`d in `applyMigrations.ts`), so it warrants only a regression test, not a migration.

---

## 6. Sources

- NIST SP 800-63B-4 (final, Jul 2025): https://csrc.nist.gov/pubs/sp/800/63/b/4/final · HTML: https://pages.nist.gov/800-63-4/sp800-63b.html
- OWASP ASVS 5.0 V6 Authentication: https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md
- Okta sign-on / global session policies: https://help.okta.com/oie/en-us/content/topics/identity-engine/policies/about-okta-sign-on-policies.htm
- Microsoft Entra Conditional Access: https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview
- Microsoft Entra passkeys (FIDO2): https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-passkeys-fido2
- WorkOS Directory Sync / SCIM: https://workos.com/docs/directory-sync · https://workos.com/directory-sync
- WorkOS B2B user management: https://workos.com/blog/user-management-for-b2b-saas
- OpenID CAEP (final 2025): https://openid.net/specs/openid-caep-1_0-final.html · FIDO + Shared Signals: https://fidoalliance.org/white-paper-fido-and-the-shared-signals-framework/
- FIDO passkeys: https://fidoalliance.org/passkeys/ · device-bound vs synced study: https://arxiv.org/abs/2501.07380
- Google BeyondCorp (zero-trust admin access): https://cloud.google.com/beyondcorp · Microsoft privileged-access strategy / workstations: https://learn.microsoft.com/en-us/security/privileged-access-workstations/privileged-access-strategy
- Companion docs: delivery-wave sequencing — [`08-roadmap.md`](./08-roadmap.md); consent & lawful basis, key management — [`10-operations-and-compliance.md`](./10-operations-and-compliance.md)
