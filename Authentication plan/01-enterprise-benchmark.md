# Enterprise Authentication Reference (2025–2026)

This document is the external **benchmark** for TruePoint's authentication: what a modern, enterprise-grade identity system is expected to provide in 2025–2026, drawn from the current standards (NIST SP 800-63B-4, OWASP ASVS 5.0), the FIDO/CISA passkey guidance, the OpenID CAEP/Shared Signals Framework, and the published admin/end-user surfaces of leading IdPs (Okta, Microsoft Entra, WorkOS, Auth0). It is deliberately **not** a code review — it sets the yardstick that docs 06 (gap analysis), 07 (recommended settings) and 08 (roadmap) measure TruePoint against. Each subsection ends with the concrete **settings / knobs** an enterprise expects to find, so the catalogs are reusable downstream. Where TruePoint is referenced, it is only to anchor where a benchmark item maps; the authoritative TruePoint inventory lives in the other documents.

A note on the **Status** column where it appears against TruePoint touchpoints: the vocabulary is exactly `Implemented | Partial | Stub | Planned | Absent`. Two facts are load-bearing throughout and stated once here:

- The real OIDC and SAML adapters are **Stub** — `oidcProvider`/`samlProvider` throw `"OIDC SSO is not configured…"` / `"SAML SSO is not configured…"` and `getSsoProvider` only returns a working (mock) provider when `NODE_ENV !== "production"` (`packages/auth/src/sso/providers.ts:16-47`).
- The end-user account-security surface is **Absent** — `SecurityPanel` only deep-links to `AUTH_ORIGIN + /account/security#…`, and that route does not exist on the auth origin; its MFA catalogue is hardcoded `enrolled: false` (`apps/web/src/features/settings-user/components/SecurityPanel.tsx:15-26`).

**Scope — client surface (AUTH-043, DECIDED).** No native/mobile client is in scope for this plan. *Rationale:* the cross-domain authorization-code + HttpOnly refresh-cookie model assumes a browser origin; if a native client is ever added, it must use the system-browser OAuth/PKCE pattern (`ASWebAuthenticationSession`), secure token storage (Keychain/Keystore), biometric unlock, and passkeys on mobile — none of which the browser model covers, so a native client is a separate, later workstream rather than an omission here.

---

## (a) Standards & assurance

### NIST SP 800-63B-4 — Authentication Assurance Levels (AALs)

SP 800-63B-4 (final, July 2025) defines three Authenticator Assurance Levels. The level chosen drives which authenticator types are acceptable and how often a user must re-authenticate.

| AAL | Authenticator requirement | Phishing-resistance | Reauth (overall / inactivity) | Source |
|---|---|---|---|---|
| AAL1 | Single- or multi-factor (password, OTP, OOB, crypto key) | Not required | ≤ 30 days | [SP 800-63B §2](https://pages.nist.gov/800-63-4/sp800-63b.html) |
| AAL2 | Two distinct factors; **at least one phishing-resistant option offered** | Offered | ≤ 24 h / 1 h inactivity | [SP 800-63B §2](https://pages.nist.gov/800-63-4/sp800-63b.html) |
| AAL3 | Public-key crypto with **non-exportable private key** (hardware) | Mandatory | ≤ 12 h / 15 min inactivity | [SP 800-63B §2](https://pages.nist.gov/800-63-4/sp800-63b.html) |

Two consequences matter for a B2B SaaS: (1) AAL2 is the realistic enterprise floor, and it requires that a phishing-resistant option (a passkey/FIDO authenticator) be *available*, even if not forced for every user; (2) **syncable authenticators SHALL NOT be used at AAL3** because their keys are exportable ([SP 800-63B §3.1.7 / Appendix B](https://pages.nist.gov/800-63-4/sp800-63b.html)) — so an org that genuinely needs AAL3 for privileged staff must issue hardware security keys, not synced passkeys.

### Password / memorized-secret guidance (the modern inversion)

The current guidance reverses the legacy "complexity + 90-day rotation" model. A verifier:

| Rule | Requirement | Source |
|---|---|---|
| Minimum length | ≥ 8 chars (MFA context); **15 chars** for single-factor passwords | [SP 800-63B §3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html); [ASVS V6.2.1, V6.2.9](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| Maximum length | SHOULD allow ≥ 64 chars | [SP 800-63B §3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html); [ASVS V6.2.9](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| Composition rules | SHALL NOT impose mixed-character-class rules | [SP 800-63B §3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html); [ASVS V6.2.5](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| Periodic rotation | SHALL NOT force periodic change (rotate only on evidence of compromise) | [SP 800-63B §3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html); [ASVS V6.2.10](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| Breach screening | Compare new password against a blocklist of known/compromised/common passwords | [SP 800-63B §3.1.1.2](https://pages.nist.gov/800-63-4/sp800-63b.html); [ASVS V6.2.4 (top-3000), V6.2.12 (breach DB)](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| Process as submitted | No truncation, no case-folding before hashing | [ASVS V6.2.8](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |

TruePoint touchpoint: the hash primitive is in place — Argon2id at 19 MiB / t=2 / p=1, fail-closed verify, no enumeration on bad-format digests (`packages/auth/src/password.ts:5-26`). What the benchmark additionally expects (breached-list screening, a strength meter, a documented min-length policy) is not visible at the library level and belongs to the gap analysis.

### OWASP ASVS 5.0 — V6 Authentication (anti-automation, adaptive response)

ASVS 5.0 (May 2025) reframes V6 around **documented, testable** controls rather than a single password rule:

- **V6.1.1 / V6.3.1** — the application must *document* and then *implement* "rate limiting, anti-automation, and adaptive response" against credential stuffing and brute force, and must avoid letting that protection cause malicious account lockout ([ASVS V6.1, V6.3](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md)). "Adaptive response" means the system escalates friction (CAPTCHA, step-up, delay) under attack rather than only counting failures.
- **V6.5** — single-use OOB/lookup secrets; **TOTP ≤ 30 s**, OOB code lifetime ≤ 10 min ([ASVS V6.5.1, V6.5.5](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md)).
- **V6.6 — SMS-OTP caveat**: phone/SMS OTP is permitted at L2 *only* when the number was previously validated, a stronger method is offered, and the risk is disclosed; **L3 prohibits phone/SMS entirely**, and **email is explicitly prohibited as an authenticator** (V6.3.6) ([ASVS V6.6.1, V6.3.6](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md)). Push factors need anti-push-bombing rate limiting and number-matching (V6.6.4) — but **push-as-a-factor is out of scope (AUTH-044, DECIDED)**. *Rationale:* TruePoint has no push-notification infrastructure, and the MFA direction is TOTP today and WebAuthn/passkeys (phishing-resistant) next; push — with number-matching and anti-push-bombing — is revisited only if a push channel is ever built. So this control is noted for completeness rather than carried forward as a gap.

**Expected settings / knobs:** configurable minimum password length; mandatory breached-password screening (toggle + provider); strength-meter display; per-IP and per-identifier rate-limit thresholds with progressive backoff; adaptive-challenge (CAPTCHA/step-up) trigger thresholds; account-lockout policy that resists malicious lockout; an AAL target per role (e.g., AAL2 for members, AAL3-capable for privileged staff).

---

## (b) Federation & provisioning

Enterprise buyers expect to bring their own IdP (SSO) and their own directory (automated provisioning). The benchmark surface is three protocols plus the operational glue around them.

| Capability | What "enterprise-grade" means | Reference IdP behaviour |
|---|---|---|
| **SAML 2.0** | SP- and IdP-initiated; signed assertions validated against IdP metadata; RelayState; attribute statements | WorkOS exposes a self-serve admin portal where the *customer's* IT admin configures SAML without vendor tickets ([WorkOS SSO](https://workos.com/docs/directory-sync)) |
| **OIDC / OAuth2** | Authorize → code → token; `id_token` signature + nonce verification; PKCE; attribute mapping | Standard across Okta/Entra/Auth0; arctic-style adapters on the OIDC side |
| **SCIM 2.0** | `/Users` + `/Groups` CRUD; **provision, update, and DEPROVISION**; group→role mapping | WorkOS "Directory Sync" and Entra/Okta provisioning push lifecycle events; deprovision must revoke access promptly ([WorkOS Directory Sync](https://workos.com/directory-sync)) |
| **JIT provisioning** | First successful federated login creates the local identity + membership with a default role | Okta/Entra/Auth0 JIT; WorkOS profile sync |
| **Attribute / group → role mapping** | IdP group or attribute maps to an app role; deterministic, auditable | Entra "claims mapping"; Okta group rules; WorkOS directory groups |
| **Domain verification** | Prove control of an email domain (DNS TXT) before auto-join / SSO enforcement | Standard gating for "everyone @acme.com signs in via SSO" |

The asymmetry that defines enterprise readiness is **deprovisioning**: SSO alone only controls *login*; without SCIM-driven deprovisioning, a terminated employee whose IdP account is disabled may still hold live app sessions and owned records. The benchmark therefore treats SCIM deprovisioning (revoke sessions + reassign/transfer owned data) as **enterprise-critical**, not optional.

TruePoint touchpoints (anchors only; full status in docs 06): SSO scaffolding, JIT, mock IdP and config repository exist, but the **real OIDC/SAML adapters are Stub** (`packages/auth/src/sso/providers.ts:16-47`); SCIM **token minting** exists while the **SCIM 2.0 endpoints and deprovisioning automation are Planned/Absent**.

**Expected settings / knobs:** per-tenant SSO config (protocol SAML/OIDC, IdP metadata URL/XML or issuer + client ID/secret, ACS/callback URLs, attribute mapping); JIT on/off + default role; "require SSO" enforcement (block password login once SSO is set); a **test-connection** tool; SCIM enable + bearer-token mint/rotate/revoke; group→role mapping table; domain add → DNS-TXT verify → join policy (`sso_only` / `auto_join` / `request_access`); deprovision behaviour (suspend vs. delete, reassign owned records).

---

## (c) Credentials & MFA

The benchmark expects a *ladder* of factors, with the system steering users up it and reserving the weakest rungs for fallback only.

| Factor | Phishing-resistant? | Enterprise positioning | Source / caveat |
|---|---|---|---|
| Password | No | Baseline; never sole factor for sensitive access | NIST/ASVS password rules above |
| Magic link (email) | No | Passwordless convenience; email is **not** an MFA factor | [ASVS V6.3.6 prohibits email as authenticator](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| TOTP (authenticator app) | No (replayable if phished) | Solid, cheap second factor; ≤ 30 s, single-use | [ASVS V6.5.1, V6.5.5](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| SMS OTP | No | **Discouraged**; SIM-swap/port risk; restricted at AAL; banned at ASVS L3 | [SP 800-63B §3.1.3.3 restricted](https://pages.nist.gov/800-63-4/sp800-63b.html); [ASVS V6.6.1](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| Email OTP | No | Same standing as magic link; not a true second factor | [ASVS V6.3.6](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| **WebAuthn / passkey** | **Yes** | The strongest, recommended MFA — origin-bound, no shared secret | [FIDO passkeys](https://fidoalliance.org/passkeys/); [CISA phishing-resistant MFA](https://www.cisa.gov/sites/default/files/publications/fact-sheet-implementing-phishing-resistant-mfa-508c.pdf) |
| Recovery codes | N/A (fallback) | One-time backup; single-use, regenerable, hashed at rest | [ASVS V6.5.1](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |

**Passkeys — the model an enterprise must understand.** A passkey is a FIDO credential whose private key never leaves the authenticator and is **origin-bound**, so a phished page on a look-alike domain cannot use it; the server stores only a public key, so a database breach yields nothing replayable ([FIDO passkeys](https://fidoalliance.org/passkeys/)). Two shapes:

- **Device-bound passkeys** stay on one device (often a hardware security key) and never sync — used where exactly one copy of the key must exist (privileged/admin, AAL3-style requirements).
- **Synced passkeys** replicate across a user's devices via an end-to-end-encrypted credential manager (iCloud Keychain, Google Password Manager, 1Password) — the convenient default for the general workforce ([FIDO passkeys](https://fidoalliance.org/passkeys/)).
- **Hybrid / cross-device (CDA)** lets a user sign in on device A using a passkey on phone B via QR + CTAP 2.2 hybrid transport over BLE proximity, with an extra cryptographic layer beyond Bluetooth's own ([FIDO passkeys](https://fidoalliance.org/passkeys/)).

CISA's standing guidance is that **phishing-resistant MFA (FIDO/WebAuthn) is the strongest tier** and should be the target for privileged accounts ([CISA phishing-resistant MFA](https://www.cisa.gov/sites/default/files/publications/fact-sheet-implementing-phishing-resistant-mfa-508c.pdf)); the pragmatic enterprise pattern is **synced passkeys for staff, hardware keys for privileged/admin** roles.

TruePoint touchpoints: **TOTP is live** (`packages/auth/src/mfa.ts`, verified in `packages/auth/src/mfaVerify.ts:16-22`); SMS/email/WebAuthn are routed-but-not-built — `verifyMfaCode` returns `false` for any non-TOTP method (`packages/auth/src/mfaVerify.ts:22`). The type contract already names the full ladder (`mfaMethodType[totp,sms,email,webauthn]`), so passkeys are **Planned**, not designed-out.

**Expected settings / knobs:** per-tenant **allowed methods** list; per-tenant **MFA enforcement** (`off` / `optional` / `required`, with forced in-login enrollment when required); passkey registration + management (multiple credentials, naming, attestation policy for "require hardware key" on privileged roles); recovery-code generation + regeneration; SMS/email OTP as opt-in fallback with the disclosure ASVS demands; a per-role/per-app **authentication strength** target (e.g., "passkey or hardware key only" for admin).

---

## (d) Sessions

The modern session model separates a **short-lived access token** (stateless, fast to verify, cheap to expire) from a **durable, rotating refresh credential** (long-lived, revocable, family-tracked).

| Mechanism | Benchmark expectation | Reference |
|---|---|---|
| Short access token | Minutes-scale TTL, verified statelessly (JWT/JWKS), kept off durable storage | Common across modern IdPs |
| Rotating refresh token | Each use mints a new token and invalidates the prior one | [OAuth 2.0 Security BCP (RFC 9700 §4.14)](https://datatracker.ietf.org/doc/html/rfc9700#section-4.14) |
| **Reuse detection** | A replayed (already-rotated) refresh token revokes the whole family | [OAuth 2.0 Security BCP (RFC 9700 §4.14.2)](https://datatracker.ietf.org/doc/html/rfc9700#section-4.14.2) |
| Idle + absolute timeout | Both an inactivity window and a hard cap (cf. AAL2 ≤ 24 h / 1 h idle) | [SP 800-63B §2](https://pages.nist.gov/800-63-4/sp800-63b.html) |
| Concurrent-session limits | Cap or list simultaneous sessions; admin policy | Okta/Entra session controls |
| Immediate revocation | Logout / admin action kills the session within seconds, not at token expiry | Okta/Entra "revoke sessions" |
| **CAEP / Shared Signals** | Cross-service, real-time session revocation on a risk event | [OpenID CAEP 1.0 final](https://openid.net/specs/openid-caep-1_0-final.html); [FIDO SSF white paper](https://fidoalliance.org/white-paper-fido-and-the-shared-signals-framework/) |

**CAEP / Shared Signals Framework (SSF)** — finalized in 2025 and adopted by Google, Apple, and Okta — is the part most products lack. It lets an IdP and a relying app exchange real-time security-event tokens (session revoked, credential changed, device compromised) so that revocation propagates *across services* in seconds rather than waiting for the access token to expire ([OpenID CAEP 1.0 final](https://openid.net/specs/openid-caep-1_0-final.html)). For an enterprise, this is the difference between "we disabled them in the IdP" and "they were actually out of every connected app immediately."

TruePoint touchpoints (anchors): the access/refresh split is implemented — EdDSA JWT, 15-min TTL, JWKS-verified remotely (`packages/auth/src/token.ts:9,43-74`); rotation with **reuse detection and family revocation** plus a 30 s race-grace and an access-token deny-list for near-instant logout (`packages/auth/src/session.ts:50-123`). Idle/absolute timeout *policy* and CAEP/SSF are not present and belong to the gap analysis.

**Expected settings / knobs:** access-token TTL; refresh-token TTL / absolute session lifetime; idle-timeout window; concurrent-session limit; "sign out everywhere"; admin "revoke this user's sessions"; force-reauth on password/MFA change; (advanced) CAEP/SSF transmitter+receiver config for cross-app revocation.

---

## (e) Adaptive / risk-based & step-up authentication

Beyond static policy, leading IdPs score each sign-in on signals and *escalate* only when risk warrants — minimizing friction for normal logins while blocking anomalous ones.

| Signal | How it's used | Reference IdP |
|---|---|---|
| New device / browser | Step-up challenge + "new device" email alert | Okta behavior detection; Entra sign-in risk |
| Geo / IP / named location | Allow trusted locations, challenge or block others | [Entra named locations & Conditional Access](https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview) |
| **Impossible travel** | Two logins too far apart in time/distance → high risk | [Okta behavior detection](https://help.okta.com/oie/en-us/content/topics/identity-engine/policies/about-okta-sign-on-policies.htm); Entra risk |
| Velocity / behavior | Unusual frequency or pattern raises risk score | Okta behavior; Entra user-risk |
| Sign-in / user risk score | Aggregate risk drives the policy decision (allow / step-up / block) | [Entra Conditional Access](https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview) |

The dominant model is Microsoft Entra **Conditional Access** — explicit *if-then* rules ("if user is in this group AND sign-in risk is high AND location is untrusted, THEN require passkey") combined with **authentication strengths** (a named bar like "phishing-resistant MFA") and named locations ([Entra CA](https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview)). Okta's equivalent splits a **global session policy** from **per-app authentication policies** and adds **behavior detection** for new-device/location/velocity anomalies ([Okta sign-on policies](https://help.okta.com/oie/en-us/content/topics/identity-engine/policies/about-okta-sign-on-policies.htm)).

**Expected settings / knobs:** trusted/named locations (CIDR/geo allowlists); per-condition policy rules (group × risk × location × device → require factor / block); new-device email alerts; impossible-travel toggle + sensitivity; step-up triggers per action (e.g., re-auth before changing security settings or exporting data); risk-level thresholds that map to allow / challenge / deny.

---

## (f) Admin governance — settings catalogs of leading IdPs

This is the catalog that feeds docs 06 and 07 directly. It is the union of what Okta, Entra, WorkOS, and Auth0 expose to a tenant administrator.

| Domain | Knobs an enterprise admin expects | Reference |
|---|---|---|
| **Global session policy** | Idle + max session lifetime; persistent-cookie policy; concurrent sessions; sign-out-everywhere | [Okta sign-on policies](https://help.okta.com/oie/en-us/content/topics/identity-engine/policies/about-okta-sign-on-policies.htm) |
| **Per-app / per-resource policy** | Different auth requirements per application or sensitive action | [Okta per-app auth policies](https://developer.okta.com/docs/guides/configure-signon-policy/main/) |
| **Conditional Access (if-then)** | Rule builder over user/group × risk × location × device → grant/block/require-factor | [Entra CA](https://learn.microsoft.com/en-us/entra/identity/conditional-access/overview) |
| **Authentication strengths** | Named bars (e.g., "phishing-resistant MFA") referenced by policies | [Entra passkey/FIDO2 profiles](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-passkeys-fido2) |
| **Authentication methods policy** | Which factors are enabled tenant-wide and for whom; passkey/FIDO2 profiles | [Entra auth methods](https://learn.microsoft.com/en-us/entra/identity/authentication/concept-authentication-passkeys-fido2) |
| **Self-serve SSO + SCIM portal** | Customer IT admin configures their own SSO/Directory Sync without vendor tickets | [WorkOS Directory Sync](https://workos.com/docs/directory-sync) |
| **Password / MFA policy** | Min length, breach screening, MFA enforcement mode, allowed methods | NIST/ASVS (above) |
| **Audit / sign-in logs** | Tenant-scoped, exportable security event log | Standard across Okta/Entra/Auth0 |

TruePoint touchpoints (anchors only): a tenant admin policy surface exists — `SecurityAccessPanel` → `tenant_auth_policies` (mfaEnforcement, allowedMethods, requireSso, disableSocial, sessionTimeout, ipAllowlist) and `SsoConfigPanel`/`IdentityPanel` for SSO/domains/SCIM. The benchmark gaps are conditional-access-style rule building, named locations, authentication-strengths, and — critically — **enforcement on the login path** (the policy is stored; full gating is partial).

**Expected settings / knobs (consolidated catalog):** password policy; MFA enforcement + allowed methods + authentication-strength targets; SSO config + require-SSO + test-connection; SCIM enable + group→role mapping + deprovision behaviour; domain verification + join policy; session lifetime/idle/concurrency; conditional-access rules + named locations + risk thresholds; step-up triggers; tenant audit-log view/export.

---

## (g) End-user self-service norms

B2B SaaS users expect to manage their own account security without a support ticket. The 2025 norm ([WorkOS user-management for B2B SaaS](https://workos.com/blog/user-management-for-b2b-saas); [Descope SaaS auth](https://www.descope.com/blog/post/saas-auth)):

| Self-service capability | What the user can do | Reference |
|---|---|---|
| Password | Change password (current + new), with strength meter | [WorkOS B2B](https://workos.com/blog/user-management-for-b2b-saas) |
| MFA enrollment | Add/remove TOTP, **register passkeys**, manage methods | [WorkOS B2B](https://workos.com/blog/user-management-for-b2b-saas); [FIDO passkeys](https://fidoalliance.org/passkeys/) |
| Recovery codes | View / regenerate one-time backup codes | [ASVS V6.5.1](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| Active sessions | See where signed in (device, location, last-seen); revoke one or all | [WorkOS B2B](https://workos.com/blog/user-management-for-b2b-saas) |
| Trusted devices | List and remove "remember this device" entries | [Descope](https://www.descope.com/blog/post/saas-auth) |
| Login history | Recent sign-in events (time, device, IP, location) | [WorkOS B2B](https://workos.com/blog/user-management-for-b2b-saas) |
| Sign-in alerts | Email on new-device / new-location sign-in | [Descope](https://www.descope.com/blog/post/saas-auth) |

TruePoint touchpoint: this entire surface is **Absent** today — `SecurityPanel` is a read-only map that deep-links to `AUTH_ORIGIN + /account/security#{password|mfa|sessions|history}`, a route that does not exist on the auth origin, and its factor list is hardcoded `enrolled: false` rather than reflecting real enrollment (`apps/web/src/features/settings-user/components/SecurityPanel.tsx:15-26,77-90`). So there is no live self-service for password change, MFA enroll/disable, session/device listing, or login history yet.

**Expected settings / knobs:** change-password form (with breach + strength check); MFA method manager (TOTP add/remove, passkey register/rename/remove, recovery-code regenerate); active-session list with per-session and "everywhere" revoke; trusted-device list + remove; login-history view; new-device sign-in alert preference.

---

## How this benchmark is used

Docs 06 (gap analysis), 07 (recommended settings) and 08 (roadmap) take the **Expected settings / knobs** lists above as the target surface and score TruePoint's `Implemented | Partial | Stub | Planned | Absent` state against them. The three items most likely to be misread — and therefore restated for emphasis — are: real OIDC/SAML is **Stub** (throws, mock-only), SCIM **deprovisioning** is **Absent** (only token minting exists), and the end-user `/account/security` surface is **Absent** (deep-link target route does not exist). Everything else in this document is the external standard, not a claim about TruePoint code.
