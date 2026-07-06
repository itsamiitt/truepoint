# 06 — Login Methods

> Document 6 of 12 · TruePoint Centralized Authentication Platform. The configurable login-method matrix — every method,
> its per-method configuration, and how the platform admin enables/disables/restricts it without code. Builds on the method
> registry (doc 11 `auth_login_methods`) and the effective-policy engine (doc 03 §11).
>
> **Research note:** the 20-agent enterprise-platform research sweep (doc 02) was interrupted by an account-level block; the
> method-by-method guidance here is drawn from the standards (OAuth 2.1 / OIDC / WebAuthn / SCIM), the existing
> `Authentication plan/01-enterprise-benchmark.md`, and current platform patterns (Auth0/Clerk/Okta/WorkOS). Live-source
> citations are completed in doc 02 once the sweep re-runs.

## Executive summary

TruePoint today ships password, magic link, and TOTP MFA, with SSO/SCIM scaffolded but the real adapters throwing in
production. This document defines the **full method catalogue as configuration**: each method is a row in
`auth_login_methods`, resolved per-tenant with strictest-wins, and exposes a uniform contract — **enable/disable · priority ·
credentials · redirect URIs · scopes · branding · org restrictions · test tools · health**. That uniform contract is what
lets the platform admin (doc 04) turn methods on/off per environment and per org without a deploy, and is the reason to model
methods as data rather than hard-coded flows.

## 1. The uniform per-method contract

Every method, regardless of type, supports:

| Facet | Meaning |
|---|---|
| **Enable / disable** | Per scope (platform default → org), strictest-wins; a disabled method never renders and its endpoint 404/403s. |
| **Priority** | Ordering on the login screen (the identifier-first router picks the primary). |
| **Credentials** | Provider client id/secret (encrypted), or signing/verification material — write-only, shown-once. |
| **Redirect URIs** | Allow-listed callbacks (exact-match, doc 08). |
| **Scopes** | Requested provider scopes / issued token scopes. |
| **Branding** | Button label, icon, order (per-org, doc 04). |
| **Org restrictions** | Which orgs/domains may use it; SSO-only orgs disable local methods. |
| **Test tools** | A "test connection" that exercises the method against a real/mock provider before enablement (the no-lockout guard, AUTH-031). |
| **Health** | Live status + last-success; a failing provider is surfaced, not silently broken. |

This contract is the interface `auth_login_methods.config` (jsonb) fills per method type.

## 2. The catalogue

### A. Local credentials

- **Email & password** — *Implemented.* Argon2id, NIST 800-63B policy (12–128, no composition), HIBP k-anonymity breach
  screen (`password.ts`, `passwordPolicy.ts`, `breachCheck.ts`). Config: min-length, breach-check on/off (fail-open),
  reset-flow settings. **Fix in-flight:** the reset delivery (docs 01/05).

### B. Passwordless

- **Magic link** — *Implemented* (`magic/*`, `completeMagic`). Config: TTL, single-use, same-device expectation. **Harden
  (doc 09):** the corporate **link-scanner prefetch** problem — add a confirm-button landing page so a scanner GET doesn't
  consume the link; and the `/auth` basePath fix (AUTH-062).
- **Email OTP** — *Absent* (enum only). New: 6–8-digit code, short TTL, single-use, rate-limited; a passwordless primary or a
  step-up proof (fixes the passwordless-enrollment catch-22, AUTH-069).
- **SMS OTP** — *Absent.* New but **discouraged fallback only** (ASVS: not a primary authenticator; SIM-swap risk). Ships
  rate-limited + spend-capped + OTP-bombing-guarded (delivery risk register); metered-cost aware (AUTH-058).

### C. Passkeys / WebAuthn / FIDO2

- **Passkeys (WebAuthn)** — *Absent* (enum/policy strings only; no ceremony). The **primary MFA/passwordless target**
  (AUTH-024). Registration + assertion ceremony with **RP-ID** designed for the subdomain estate (doc 09), attestation policy
  (AAGUID allowlists for enterprise), discoverable credentials + conditional-UI autofill, `webauthn_credentials` table (doc
  11). Server lib: SimpleWebAuthn (Bun/TS-compatible). Sequenced after the now-existing `/account/security` surface.

### D. Social / consumer OAuth (as relying party)

- **Google, Microsoft, Apple, GitHub, LinkedIn, X, Facebook, Discord, Slack** — *Absent* (dead path; AUTH-015 decided:
  build in a later wave). Each is an OIDC/OAuth **inbound** connection: config = client id/secret, redirect URI, scopes,
  button branding. Modeled uniformly via the provider registry (`auth_providers`), so adding one is configuration + an
  adapter, not a new flow. Google/Microsoft/Apple are the B2B-relevant first three.

### E. Enterprise SSO (federated — see doc 07 for depth)

- **SAML 2.0** — *Stub that throws in production* (`@node-saml` unwired). The **AUTH-001 Critical** long-pole: real
  signed-assertion validation with anti-XXE / anti-signature-wrapping / reject-unsigned gates.
- **OpenID Connect / OIDC** — *Stub* (`arctic` unwired). Real code-flow + id_token validation (AUTH-008).
- **Azure AD (Entra) / Okta** — configured as OIDC/SAML provider instances via the registry; no bespoke code per IdP.
- **LDAP / Active Directory** — *Absent.* For on-prem directories, prefer an **agent/bridge** (LDAP → SCIM/OIDC) over direct
  LDAP bind from the IdP; scope as a later wave. (Ory Polis / a SAML-bridge pattern is a build-vs-buy option — doc 02.)

### F. Multi-factor (layered on the above — see doc 09)

- **TOTP** — *Implemented.* **WebAuthn as 2FA** — target (C). **Recovery codes** — *Implemented* (hashed, shown once).
  **Push** — out of scope (AUTH-044). **Adaptive/risk step-up** — target (doc 09).

## 3. The identifier-first router (existing, extended)

Login is identifier-first (ADR-0017): the user enters an identifier, the router resolves by **verified email domain**
(`tenant_domains`) to decide SSO vs local, and offers the enabled methods in priority order. This deliberately reveals
account existence (ADR-0020), throttled by Turnstile + rate limits — **do not re-litigate anti-enumeration** (it's a recorded
decision), but ensure the *email-delivery* timing oracle (AUTH-064) is fixed so the reveal is intentional, not accidental.

## 4. Functional requirements

- Methods are **data**; enabling/disabling/reordering/restricting is a config write (doc 04), effective immediately via the
  resolver + cache invalidation.
- **Strictest-wins:** an org can disable a platform-enabled method or require SSO-only; it cannot enable a
  platform-disabled one.
- **No-lockout guard (AUTH-031):** a method (esp. SSO) cannot be made mandatory until its **test-connection** passes against
  a real adapter; break-glass owner local-login always remains.
- Every method emits **auth events** (method used, success/failure) for observability + risk.

## 5. UI/UX recommendations

- **One login screen** that renders enabled methods in priority order, org-branded (doc 04); the primary method is
  identifier-first-resolved.
- **Progressive disclosure:** passwordless/passkey first where enabled; password as fallback; SSO auto-redirect for SSO-only
  domains.
- **Accessible + i18n** (AUTH-020) as a ship gate; four states on every async action.
- **Admin method manager** (doc 04): a table of methods with enable toggles, priority drag, per-method config drawer, test
  button, and health badge.

## 6. API specification (representative)

```
GET  /api/v1/auth-admin/methods                       → list (effective, per scope)      (Management API)
PUT  /api/v1/auth-admin/methods/{method}              → enable/disable/priority/config    (staff-RBAC, audited)
POST /api/v1/auth-admin/methods/{method}/test         → test-connection (no-lockout gate)
GET  /api/v1/auth-admin/methods/{method}/health       → live status
# runtime (IdP):
GET  /auth/login (identifier-first)  → renders enabled methods in priority order
POST /auth/login/{method}            → per-method step (password/magic/otp/passkey/sso)
```

## 7. Security considerations

- Provider **secrets encrypted, write-only, shown-once**; never in a read model or `NEXT_PUBLIC_*`.
- **Redirect URIs exact-match allow-listed** per method (doc 08).
- **SSRF-guard** provider metadata/discovery/JWKS fetches (AUTH-009).
- **SMS/email OTP** rate-limited + spend-capped + bombing-guarded.
- **Passkey RP-ID** scoped correctly for the subdomain estate (doc 09) — a wrong RP-ID breaks or over-scopes credentials.
- **Method changes are audited** (`withPlatformTx`, staff-RBAC); a disabled method is enforced server-side, not just hidden.

## 8. Testing, migration, risks, future

- **Testing:** per-method enable/disable takes effect via the resolver; disabled method endpoint denies; test-connection
  gates mandatory SSO; strictest-wins holds; OTP rate/ spend caps trip.
- **Migration:** seed the registry from today's hard-coded methods (password/magic/TOTP) → then add OTP, passkeys, social,
  SSO per doc 12 waves.
- **Risks:** mandatory-method lockout (mitigated by the no-lockout guard + break-glass); SMS cost/abuse; passkey recovery for
  passkey-only accounts (doc 05/09).
- **Future:** WebAuthn as primary with password deprecation, LDAP/AD bridge, per-org method A/B, risk-driven method
  selection.
