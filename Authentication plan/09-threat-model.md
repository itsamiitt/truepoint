# Threat Model & Security Acceptance Criteria

This document defines the adversarial acceptance criteria — the security ship gates — for the authentication deliverables the roadmap proposes ([`08-roadmap.md`](./08-roadmap.md)). It is anchored to the `truepoint-security` skill's threat checklist (untrusted input, tenant isolation, no secrets on the client, every outbound request guarded) and to the 2025–2026 benchmark assembled in [`01-enterprise-benchmark.md`](./01-enterprise-benchmark.md) (NIST SP 800-63B-4, OWASP ASVS 5.0, OIDC Core, SAML/XML-DSig, FIDO/CISA).

The starting position is genuinely strong at the primitive level: Argon2id hashing, EdDSA access tokens verified statelessly against a published JWKS with issuer + audience pinning (`packages/auth/src/token.ts:64-74`), rotating refresh tokens with reuse-detection and a 30 s rotation grace (`packages/auth/src/session.ts:99-116`), an in-memory access token (not an ambient cookie) for app-API calls, a nonce-based CSP with no inline scripts on the auth origin (`apps/auth/src/middleware.ts:10-21`), a server-side SSRF guard on outbound webhooks (`packages/core/src/webhooks/ssrfGuard.ts`), and a server-side app-origin allowlist on every existing redirecting surface (`apps/auth/src/lib/sessionGuard.ts:41-45`, `apps/auth/src/app/reset/actions.ts:54-64`).

The problem is not the primitives — it is that every *proposed* deliverable opens a new, externally-reachable trust boundary that the current code does not yet defend:

- **Real SAML / OIDC** (`packages/auth/src/sso/providers.ts:16-38` is a Stub that throws) introduces signature verification, XML parsing, and server-side fetches of tenant-admin-supplied URLs — the classic high-severity SSO attack surface.
- **SCIM + deprovisioning** (token-mint-only today; `apps/api/src/features/settings/identityRoutes.ts:107-130`) introduces a tenant-wide bearer credential and a deactivate-propagation race.
- **`/account/security`** (Absent) introduces new auth-origin client code and new write paths (MFA enrollment, passkeys) that must preserve the CSP and the allowlist invariants.
- **Policy enforcement** (Partial — knobs stored, not gated on login) and **passkeys** (Stub — `packages/auth/src/mfaVerify.ts:22` returns `false` for non-TOTP) introduce factor-downgrade and enrollment-trust questions.
- **Impersonation "login-as"** (Partial / WIRE-deferred) introduces a privileged token-mint path.

Each section below is the ship gate for one of those surfaces. A deliverable does not ship to any tenant until the negative tests named in its "acceptance criterion" column pass. Status vocabulary is exactly `Implemented | Partial | Stub | Planned | Absent`; every TruePoint claim carries a `file:line` anchor and every external claim a source URL.

---

## SAML validation

**Severity: Critical.** SAML assertion validation is the single most error-prone surface in enterprise auth — an accepted forged assertion is full account takeover for any user in the tenant, with no password and no MFA. The adapter is **Stub** today: `samlProvider.initiate`/`validate` throw `"SAML SSO is not configured…"` (`packages/auth/src/sso/providers.ts:28-38`), and `getSsoProvider` only returns a working (mock) provider off-production (`packages/auth/src/sso/providers.ts:44-47`). The named seam is `@node-saml/node-saml`, which has a CVE history that makes "use the library, configured correctly" a non-negotiable baseline rather than an assumption — e.g. CVE-2025-29774 / CVE-2025-29775 (signature-wrapping / DTD-comment-truncation bypasses in the xml-crypto stack node-saml builds on), and the earlier node-saml audience/in-response-to advisories. The gate before SAML is enabled for *any* tenant is a known-malicious-SAML negative-test suite that the validate path rejects every entry of.

| Threat | Required control / acceptance criterion | Anchor |
|---|---|---|
| XML External Entity (XXE) / billion-laughs via a crafted assertion | Parse with DTD/DOCTYPE processing fully disabled and external-entity resolution off; a `<!DOCTYPE>` or `<!ENTITY>` in the Response is rejected before any signature check. Negative test: an XXE payload returns a validation error, never a parsed value. | wires into `packages/auth/src/sso/providers.ts:34-37`; [OWASP XXE Prevention](https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html), [CWE-611](https://cwe.mitre.org/data/definitions/611.html) |
| XML signature wrapping (XSW) — signature is valid but covers a *different* element than the asserted Subject | The verified signature MUST cover the exact element supplying Subject + Conditions + AttributeStatement; validation operates on the *signed* node, never re-reads the document by id/XPath after verifying a detached signature. Negative test: a wrapped Response (valid signature on an injected dummy assertion, attacker assertion outside it) is rejected. | [SAML signature-wrapping research (Somorovsky et al.)](https://www.usenix.org/system/files/conference/usenixsecurity12/sec12-final91.pdf); [ASVS V14 / V51 federation](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x22-V14-Config.md) |
| Unsigned / Response-only-signed assertion accepted | Require the *assertion* itself to be signed (not just the enclosing Response); reject a Response with no signature and a Response whose signature covers only the Response wrapper while the assertion is unsigned. `wantAssertionsSigned` is on; `wantAuthnResponseSigned` does not substitute for it. | [@node-saml configuration](https://github.com/node-saml/node-saml#security-and-signatures); [OASIS SAML Core §5](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf) |
| Replay / cross-context reuse of a valid assertion | Enforce `Conditions/@NotOnOrAfter` (and `NotBefore`) within a tight skew, `AudienceRestriction` == our SP entity ID, `SubjectConfirmationData/@Recipient` == our ACS URL, and `@InResponseTo` == the AuthnRequest id we issued (SP-initiated); cache the assertion id in a single-use replay cache for the validity window. | [OASIS SAML Core §2.5](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf); see also [IdP-initiated SSO](#idp-initiated-sso) |
| Canonicalization / transform confusion (verify a different byte-stream than is consumed) | Apply the declared exclusive C14N transform and verify the canonicalized bytes; reject unknown/dangerous transforms and any `Reference` URI that does not resolve to the signed assertion element. | [W3C XML-DSig §6.5 (C14N)](https://www.w3.org/TR/xmldsig-core/#sec-c14nAlg); [CVE-2025-29775](https://github.com/advisories/GHSA-w275-fpwr-jp3f) |
| Algorithm downgrade (weak digest / weak signature alg) | Allowlist signature + digest algorithms (RSA-SHA256/ECDSA-SHA256 minimum); reject SHA-1 and any alg not on the list. | [W3C XML-DSig algorithm requirements](https://www.w3.org/TR/xmldsig-core/#sec-AlgID) |

**Gate:** a checked-in negative-test fixture set (each XSW variant, XXE, unsigned, Response-only-signed, stale `NotOnOrAfter`, wrong `Audience`/`Recipient`, replayed id) MUST all return a validation error before SAML is flagged on for the first real tenant. Until then `getSsoProvider` keeps failing closed in production (`packages/auth/src/sso/providers.ts:45-46`).

---

## OIDC id_token validation

The OIDC adapter is **Stub** today (`oidcProvider` throws — `packages/auth/src/sso/providers.ts:16-26`); the named seam is `arctic`. The acceptance bar is the OIDC Core ID Token validation rules, plus the same issuer/audience-pinning discipline TruePoint already applies to its *own* access tokens (`packages/auth/src/token.ts:68-72` pins `issuer: env.AUTH_ORIGIN`, `audience`, and `algorithms: ["EdDSA"]`). The id_token from the IdP is untrusted input and gets the identical treatment.

| Threat | Required control / acceptance criterion | Anchor |
|---|---|---|
| id_token replay | A single-use, session-bound `nonce` is generated at `initiate`, stored on the short-lived provider state, and the returned id_token's `nonce` MUST match and be consumed exactly once. | wires into `packages/auth/src/sso/providers.ts:19-24`; [OIDC Core §3.1.2.1 / §15.5.2](https://openid.net/specs/openid-connect-core-1_0.html#NonceNotes) |
| Callback CSRF (forged authorization response) | A `state` value is generated at `initiate`, bound to the flow, and verified on callback; mismatch rejects. Mirrors the `state`/`relayState` binding the existing auth flows already carry. | [OIDC Core §3.1.2.1](https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest); [CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) |
| Token from the wrong issuer | `iss` MUST equal the issuer published by the IdP's discovery document for this tenant's configured `oidc_issuer` (`packages/db/src/schema/auth.ts:234`); any mismatch rejects. | [OIDC Core §3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation) |
| Token minted for a different client (audience confusion) | `aud` MUST contain our configured `oidc_client_id` (`packages/db/src/schema/auth.ts:235`); if `aud` is multi-valued, `azp` MUST equal our client id. Mirrors `token.ts:70`'s `audience` pin. | [OIDC Core §3.1.3.7 (3-4)](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation) |
| `alg: none` / signature-algorithm confusion | Allowlist the signing algorithm to what the IdP advertises (RS256/ES256/EdDSA); reject `none` and reject an HS-signed token where an asymmetric key is expected. Mirrors `token.ts:72`'s explicit `algorithms` allowlist. | [OIDC Core §3.1.3.7 (6-8)](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation); [JWT alg confusion](https://portswigger.net/web-security/jwt/algorithm-confusion) |
| Stale / not-yet-valid token | `exp` not past and `nbf`/`iat` within a small clock skew (e.g. ≤120 s); reject otherwise. | [OIDC Core §3.1.3.7 (9-11)](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation) |
| Authorization-code replay | The code is exchanged exactly once over the back channel with PKCE; a replayed code or a replayed nonce is rejected. | [OAuth 2.0 Security BCP §2.1.1 / §4.5](https://datatracker.ietf.org/doc/html/rfc9700) |

**Gate:** the JWKS used to verify the id_token is fetched through the SSRF guard (see next section), and the negative tests (replayed nonce, mismatched state, wrong `iss`, wrong `aud`, `alg:none`, expired) pass before OIDC is enabled for any tenant.

---

## SSRF on metadata/JWKS fetch

Real SSO requires the server to fetch URLs that a *tenant admin* supplies: the SAML metadata URL (`tenant_sso_configs.metadata_url`, `packages/db/src/schema/auth.ts:232`), the OIDC discovery document for `oidc_issuer` (`:234`), and the IdP's JWKS endpoint. Each is a server-side fetch of an attacker-influenceable URL from inside our network — textbook SSRF (cloud metadata at `169.254.169.254`, loopback, RFC-1918 internal services). TruePoint already has a hardened guard for exactly this shape on outbound webhooks (`packages/core/src/webhooks/ssrfGuard.ts`): scheme allowlist (`:112-114`), unconditional metadata-host block (`:118`), and a resolve-then-reject-private check across **every** resolved address (`:141-143`). That guard is reused/extended here; it currently runs **only** on webhook targets.

| Threat | Required control / acceptance criterion | Anchor |
|---|---|---|
| `file://`, `gopher://`, `ftp://` scheme abuse | Only `http:`/`https:` permitted; everything else rejected. The webhook guard already does this (`assertSafeWebhookUrl`). | `packages/core/src/webhooks/ssrfGuard.ts:112-114`; [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) |
| Cloud metadata endpoint (`169.254.169.254`, `metadata.google.internal`) | Unconditional block, even where literal hostnames are otherwise allowed. | `packages/core/src/webhooks/ssrfGuard.ts:36,93,118` |
| Private / loopback / link-local target, incl. IPv4-mapped + NAT64-embedded | Resolve the host and reject if **any** resolved address is loopback/private/link-local/unspecified; re-check **after DNS resolution**, not just on the literal hostname. | `packages/core/src/webhooks/ssrfGuard.ts:38-98,133-143` |
| DNS-rebinding TOCTOU (public at check, internal at connect) | Re-validate at every fetch (the guard re-checks at create *and* fire); track connect-by-pinned-IP as the residual hardening (already noted as a follow-up in the guard). | `packages/core/src/webhooks/ssrfGuard.ts:11-14` |
| Untrusted IdP response body (huge body, slow-loris, redirect to internal) | Enforce a request timeout and a response body-size cap; do not auto-follow redirects to a re-validated-as-internal host; treat the parsed metadata/JWKS as untrusted (it feeds SAML/OIDC validation, it does not bypass it). | extends `packages/core/src/webhooks/ssrfGuard.ts`; [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) |

**Gate:** the SAML metadata fetch, the OIDC discovery fetch, and the JWKS fetch all route through the (extended) SSRF guard with timeout + body-size caps, and an isolation test proves a tenant-supplied `metadata_url` pointing at `169.254.169.254` / `127.0.0.1` / an RFC-1918 host is rejected before any fetch body is read.

---

## SCIM deprovisioning race & token abuse

SCIM is **Partial / token-mint-only**: the management surface creates, lists (masked), and revokes tokens (`apps/api/src/features/settings/identityRoutes.ts:107-130`), but the `/scim/v2/*` service endpoints and the deactivate-propagation are not built, and `scim_tokens.last_used_at` is explicitly `WIRE-deferred` (`packages/db/src/schema/scim.ts:28`). The two acceptance questions are (a) how fast does an IdP "deactivate" actually cut off access, and (b) how is the tenant-wide SCIM credential constrained.

The deprovisioning bound has to be reasoned about against the existing token model, not assumed to be instant. Two facts set the window: the access-token revocation deny-list **fails open** on a Redis error (`isRevoked` returns `false` — `packages/auth/src/revocation.ts:42-48`, relied on at `apps/api/src/middleware/authn.ts:21-24`), and the session-rotation reuse check carries a 30 s grace (`REUSE_GRACE_MS = 30_000` — `packages/auth/src/session.ts:99,116`). A deactivate that revokes sessions and deny-lists them therefore cuts a healthy path within seconds, but the worst-case stale window (deny-list unreachable) is the full ≤15 min access-token TTL.

| Threat | Required control / acceptance criterion | Anchor |
|---|---|---|
| Stale access after IdP deactivate (deny-list fail-open + rotation grace) | Document and **bound** the max stale-access window: best case seconds (revoke + deny-list), worst case ≤15 min access-token TTL when the deny-list is unreachable. A deactivate revokes all of the user's durable sessions (the source of truth — refresh then fails), not just deny-lists the token. | `packages/auth/src/revocation.ts:8-10,42-48`; `packages/auth/src/session.ts:99,113-116`; `apps/api/src/middleware/authn.ts:21-24` |
| Unproven cutoff bound | An isolation test: deactivate a user via SCIM, then prove a previously-valid token stops working within the documented bound, AND prove the durable session can no longer refresh at all. | new test against `apps/api/src/middleware/authn.ts:24` + `packages/auth/src/refresh.ts` |
| SCIM token = tenant-wide credential, theft = whole-org provisioning control | Least-scope (provisioning operations only, never a general API token); explicit rotation support; the token is shown once and only its SHA-256 hash is stored. | `apps/api/src/features/settings/identityRoutes.ts:114-118`; `packages/db/src/repositories/scimTokenRepository.ts:6-9` |
| Compromised SCIM token used unnoticed | Wire the deferred `last_used_at` so the management surface shows last-use, and audit SCIM auth so an anomalous source/IP is detectable; alert on use of a token after its expected idle window. | `packages/db/src/schema/scim.ts:28` (WIRE-deferred); `packages/db/src/repositories/scimTokenRepository.ts:60-68` (create already audited) |
| Cross-tenant token use | SCIM token resolves to exactly one tenant; every SCIM operation runs RLS-scoped under that tenant (the token table is `FORCE`-RLS tenant-scoped already). | `packages/db/src/repositories/scimTokenRepository.ts:2-4`; `packages/db/src/rls/scim.sql` |

**Gate:** the documented stale-access bound is backed by the isolation test above, and `last_used_at` monitoring is wired before SCIM provisioning is enabled for a tenant (a deprovisioning control with no observability is not auditable).

---

## MFA integrity (downgrade & enrollment trust)

Today only TOTP is live; `verifyMfaCode` routes every non-TOTP method to a `return false` fall-through (`packages/auth/src/mfaVerify.ts:16-22`), so SMS, Email OTP, and WebAuthn are **Stub** (a seam that returns a placeholder). A required-MFA tenant blocks an un-enrolled user with `mfa_required` (`packages/auth/src/flow.ts:152-159`) but cannot yet enroll them mid-login — the `/account/security` wizard and the forced in-login enrollment step are the deliverables (`packages/auth/src/flow.ts:150-151` flags the WIRE). As real factors and self-service land, the integrity rules below become the gate.

| Threat | Required control / acceptance criterion | Anchor |
|---|---|---|
| Silent factor downgrade (attacker chooses the weakest enrolled method below policy strength) | The verify step MUST enforce the policy-required strength: a tenant that requires a phishing-resistant or app-based factor cannot be satisfied by a weaker enrolled method; the *server* selects the allowed factor set, the client never does. | extends `packages/auth/src/mfaVerify.ts:9-22`; policy in `tenant_auth_policies.allowed_methods` (`packages/db/src/schema/auth.ts:251-253`); [SP 800-63B-4 §2 AAL](https://pages.nist.gov/800-63-4/sp800-63b.html) |
| Mid-login forced enrollment hijack (enrollment bound to the wrong/unauthenticated session) | Forced enrollment runs on the partially-authenticated login-transaction (primary factor already proven); re-prove the primary factor before the new method is trusted; the new factor only counts for *this* user's transaction. | wires the WIRE at `packages/auth/src/flow.ts:150-151`; [ASVS V6.5 (MFA lifecycle)](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| Forged / over-scoped trusted-device token (30-day MFA skip) | The trusted-device token is signed + scoped to (user, device fingerprint) so it cannot be forged or replayed cross-user; it is revoked on any password change or MFA-method change, and is independently revocable. The `trusted_devices` table exists but nothing in login consults it yet, so this is the gate when it is wired. | `packages/db/src/schema/auth.ts:208-224` (`trusted_devices`, `trusted_until`, `revoked_at`); force-logout path `packages/auth/src/session.ts:83-94`; [ASVS V6.4](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md) |
| Enrollment brute-force / unaudited factor changes | Rate-limit enrollment attempts (reuse the existing limiter posture) and audit every enrollment / removal (`mfa.success`/`mfa.failure` plus an enrollment event) so a stealth factor addition is detectable. | rate-limit pattern `packages/auth/src/rateLimit.ts`; audit enum `packages/types/src/billing.ts:117-119` |

**Gate:** an isolation test proves (a) a tenant requiring an app-based factor cannot complete login with a weaker enrolled method, (b) a trusted-device token from user A is rejected for user B and is invalidated by a password reset, and (c) enrollment events appear in the audit log.

---

## IdP-initiated SSO

IdP-initiated SSO (an unsolicited SAML Response delivered straight to our ACS without a prior AuthnRequest) is strictly riskier than SP-initiated because there is **no `InResponseTo` to bind** the Response to a request we issued — the primary anti-replay / anti-CSRF anchor from the [SAML validation](#saml-validation) section is gone. The safe default is to scope it out of the first release; if a tenant requires it, the controls below are mandatory.

| Threat | Required control / acceptance criterion | Anchor |
|---|---|---|
| Assertion replay (no `InResponseTo` to consume) | A single-use replay cache keyed on the assertion id for the full validity window; a second presentation of the same assertion is rejected. | wires into `packages/auth/src/sso/providers.ts:34-37`; [OASIS SAML Profiles §4.1.4 (Web Browser SSO)](https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf) |
| Wide acceptance window (long-lived stolen assertion) | Enforce a tight `NotOnOrAfter` (short skew) on the unsolicited assertion; reject anything outside it. | [OASIS SAML Core §2.5.1](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf) |
| Malformed/spec-violating unsolicited Response | Handle the unsolicited Response per the Web Browser SSO profile: no `InResponseTo` is *expected*, but its *presence* (pointing at a request we never issued) is rejected; `Recipient`/`Audience` still pinned to our ACS/SP. | [OASIS SAML Profiles §4.1.5](https://docs.oasis-open.org/security/saml/v2.0/saml-profiles-2.0-os.pdf) |
| Login CSRF (attacker logs the victim into the attacker's account) | A documented login-CSRF mitigation (e.g. a confirmation/landing step that does not auto-establish the session, or a RelayState-bound landing) before the IdP-initiated assertion silently creates a session. | [OWASP Login CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#login-csrf) |

**Gate:** either IdP-initiated SSO is explicitly out-of-scope for the first SSO release (documented), or all four controls plus the SP-initiated SAML negative suite pass before it is enabled.

---

## Open redirects

Every *new* redirecting surface inherits the existing invariant: a redirect target is honoured only if it is an allow-listed app origin, never an attacker-supplied absolute URL. The pattern is already proven — `redirectIfAuthenticated` honours `?app_origin` **only** when `isAllowedOrigin(appOriginHint)` and otherwise falls back to the default app origin (`apps/auth/src/lib/sessionGuard.ts:41-45`); the reset and magic flows do the same (`apps/auth/src/app/reset/actions.ts:54-64`, `apps/auth/src/lib/completeMagic.ts:34`). The new surfaces must not regress it.

| Threat | Required control / acceptance criterion | Anchor |
|---|---|---|
| SSO callback completion redirects to an attacker URL | After OIDC/SAML callback, the post-login bounce target is validated against the server-side `isAllowedOrigin` allowlist (as `completeSso` already structures its carry-context); a foreign origin falls back to the default, never redirects out. | `apps/auth/src/lib/completeSso.ts:34,72`; `apps/auth/src/lib/sessionGuard.ts:42` |
| RelayState (SAML) / `state` carrying an open-redirect payload | RelayState is treated as untrusted: it may only encode an allow-listed return origin (validated server-side), never a free-form absolute URL used verbatim for the redirect. | extends the allowlist pattern at `apps/auth/src/app/reset/actions.ts:54-64` |
| `/account/security` post-action redirects | Every post-action redirect on the new self-service surface validates its target the same way; no `next`/return param is used as an absolute URL without `isAllowedOrigin`. | pattern: `apps/auth/src/lib/sessionGuard.ts:41-45` |

**Gate:** a foreign-return-URL rejection test for each new redirecting surface (SSO callback completion + RelayState, `/account/security` post-action) — supplying `https://evil.example/...` results in a fallback to the default app origin, asserted, not assumed.

---

## Mass-assignment & field allowlisting

The existing write paths already practice server-side field allowlisting — e.g. the SSO config upsert pulls the write-only `oidcClientSecret` out of the validated body, encrypts it server-side, and passes only the remaining validated fields through (`apps/api/src/features/settings/ssoRoutes.ts:32-40`), and the SCIM create only ever takes `name` (`apps/api/src/features/settings/identityRoutes.ts:115-119`). This invariant must generalize to **all** new write paths: the server allowlists the settable fields, and the client can never set owner / role / tenant / security-sensitive columns.

| Threat | Required control / acceptance criterion | Anchor |
|---|---|---|
| Auth-policy upsert sets fields the client should not control | The auth-policy write accepts only the policy knobs via a Zod schema; `tenant_id` comes from the session claim, never the body; `mfa_enforcement`/`require_sso`/`allowed_methods` are server-validated enums/sets. | `tenant_auth_policies` (`packages/db/src/schema/auth.ts:246-259`); pattern: `apps/api/src/features/settings/ssoRoutes.ts:23-27` |
| SSO-config upsert injects a raw `metadata_xml` (latent settable column) | `tenant_sso_configs.metadata_xml` (`packages/db/src/schema/auth.ts:233`) is a free-text column an admin can set directly — if accepted, it must be parsed through the **same** XXE-safe, signature-validating path as a fetched metadata document ([SAML validation](#saml-validation)), never trusted as pre-validated; the upsert schema controls which fields are settable. | `packages/db/src/schema/auth.ts:233`; `apps/api/src/features/settings/ssoRoutes.ts:25,32` |
| Profile PATCH escalates role / changes tenant / changes email | A profile PATCH allowlists user-editable fields only; `role`, `tenant_id`, `org_role`, and security columns are never client-settable; **email is immutable via profile PATCH** — an email change is a separate, verified flow (it is the recovery anchor), not a silent field update. | pattern: `apps/api/src/features/settings/ssoRoutes.ts:32-40`; see [Account-recovery abuse](#account-recovery-abuse) |
| `/account/security` writes set protected state | Every `/account/security` mutation (MFA enroll, trusted-device, passkey) allowlists its fields server-side and binds to the authenticated user from the session, never a body-supplied user id. | pattern: `apps/api/src/features/settings/identityRoutes.ts:115-119` |

**Gate:** each new write path has a negative test proving a body that includes `role`/`tenant_id`/`org_role`/`email` (profile) or an unexpected column is rejected or silently dropped — never persisted.

---

## Session / CSRF / CSP / cookie invariants

These are **asserted, not assumed** — each is a property the new surfaces must preserve, with a test, because the auth model already depends on them.

| Invariant | Required control / acceptance criterion | Anchor |
|---|---|---|
| App-API mutations are not classic-CSRF-eligible | App→API calls carry the **in-memory bearer access token** (not an ambient cookie), so a cross-site form post cannot ride a session cookie into a mutation; assert no app-API mutation authenticates off a cookie alone. | `packages/auth/src/token.ts:1-3` (access token in memory); `apps/api/src/middleware/authn.ts:21-24` (bearer + deny-list) |
| Auth-origin cookie routes are CSRF-defended | The auth-origin flows that *do* use cookies rely on `SameSite` + `state`/`relayState` binding; new cookie-bearing auth routes preserve that binding. | `apps/auth/src/lib/cookies.ts`; reset/magic carry `state` (`apps/auth/src/app/reset/actions.ts:62`) |
| Strict CSP preserved on new auth-origin client code | `/account/security` (P1b) and WebAuthn (P3) ship with **no inline scripts** — the nonce-based CSP at `apps/auth/src/middleware.ts:10-21` (`script-src 'self' 'nonce-…'`, `frame-ancestors 'none'`, `form-action 'self'`) is not relaxed; the WebAuthn library is vetted and loaded under the nonce, not inline. | `apps/auth/src/middleware.ts:10-21` |
| Refresh cookie hardening | The refresh cookie stays `HttpOnly` + `Secure` + `SameSite` + host-scoped; new flows never widen its scope or drop a flag. | `apps/auth/src/lib/cookies.ts`; `apps/auth/src/lib/sessionGuard.ts:26-31` (refresh-cookie lookup) |
| Session-fixation resistance | The session id rotates on **every** auth-state change (login, refresh, MFA step-up, org/workspace switch) and is never client-settable; a presented-but-revoked session outside the 30 s grace is treated as reuse. | `packages/auth/src/session.ts:77-94` (rotate + revoke), `:99-118` (grace + reuse); `packages/auth/src/switchOrg.ts:49`, `packages/auth/src/switchWorkspace.ts:4` |

**Gate:** tests asserting (a) an app-API mutation with only a cookie and no bearer is rejected, (b) the CSP response header on a new `/account/security` page still contains the nonce directive and no `'unsafe-inline'` in `script-src`, and (c) the session id changes across an MFA step-up and an org switch.

---

## Account-recovery abuse

Recovery is the soft underbelly of any auth system: if recovery is weaker than the front door, the front door's strength is irrelevant. The recovery anchor today is email (password reset), with the audit enum `password.reset.request` / `password.reset.complete` (`packages/types/src/billing.ts:120-121`) — note the **request/complete** spelling; the past-tense `requested`/`completed` forms do not exist and would fail the Zod enum. As `/account/security` and stronger factors land, recovery must not become the bypass.

| Threat | Required control / acceptance criterion | Anchor |
|---|---|---|
| Recovery rests on a single weak factor | Account recovery cannot be satisfied by a single weak factor (e.g. email link alone) for an MFA-enrolled / SSO-enforced user; a high-assurance account requires a correspondingly strong recovery path. | `packages/auth/src/passwordReset.ts`; [SP 800-63B-4 §6.1.2.3 (recovery)](https://pages.nist.gov/800-63-4/sp800-63b.html) |
| Recovery enumeration / brute-force / token replay | Recovery actions are rate-limited (reuse the limiter posture) and the reset token is single-use and revokes all sessions on completion. | `packages/auth/src/rateLimit.ts`; `packages/auth/src/passwordReset.ts:69` (revoke sessions + deny-list on reset) |
| Recovery silently bypasses MFA | A password reset MUST NOT silently drop the MFA requirement: a required-MFA org still gates the next login on MFA after a reset (the `mfa_required` gate at `packages/auth/src/flow.ts:152-159` is not bypassed by a recovery flow). | `packages/auth/src/flow.ts:152-159` |
| Support-assisted recovery (lost MFA + lost email) = social-engineering surface | Model and document support-assisted recovery as a distinct, audited, multi-approver, identity-proofed path — never an unlogged "support resets it" capability; it ties to the staff impersonation governance (login-as is Partial / WIRE-deferred) and the append-only `platform_audit_log`. | `packages/db/src/rls/platform.sql:16-49` (append-only audit); [CISA / SP 800-63A identity proofing](https://pages.nist.gov/800-63-4/sp800-63a.html) |
| Recovery actions unaudited | Every recovery action (request, complete, support-assisted) is audited under the existing enum so a recovery-driven takeover leaves a trail. | `packages/types/src/billing.ts:120-121` (`password.reset.request`/`password.reset.complete`); `packages/db/src/repositories/auditRepository.ts:18-19` |

**Gate:** tests proving (a) a reset still hits the `mfa_required` gate for a required-MFA org on the next login, (b) recovery actions are rate-limited and emit the correct audit action (exact enum `password.reset.request` / `password.reset.complete`), and (c) support-assisted recovery has no unaudited path.

---

## How this maps to the rest of the plan

- The Critical/High severities here align with [`06-gap-analysis.md`](./06-gap-analysis.md): the real SSO adapters and their threat gates are Critical; policy enforcement, passkeys, and breach screening are High.
- The sequencing of these gates follows the **delivery wave** in [`08-roadmap.md`](./08-roadmap.md): SSO threat gates land with the P1 SSO adapters, the MFA-integrity and session/CSP gates land with the P1b `/account/security` wizard, and the passkey-specific gates land in the P3 wave (passkeys depend on that wizard).
- Every threat-driven gap surfaced here carries a stable `AUTH-###` id in [`11-gap-register.md`](./11-gap-register.md); the operational side (key rotation, incident response, breach notification, observability/SLIs for these surfaces) lives in [`10-operations-and-compliance.md`](./10-operations-and-compliance.md).

These are ship gates, not aspirations: a deliverable in this plan is "done" only when the negative tests named in its section pass.
