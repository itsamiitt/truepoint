# 09 — Security Policies

> Document 9 of 12 · TruePoint Centralized Authentication Platform. Enterprise-grade security controls: MFA, adaptive/risk
> authentication, device fingerprinting, IP/country restrictions, CAPTCHA, brute-force defense, anomaly detection, lockout,
> notifications, and recovery workflows. Extends `Authentication plan/09-threat-model.md` (the threat-model ACs are ship
> gates, not aspirations) and the delivery-risk register (Part 2).

## Executive summary

TruePoint has the foundations — TOTP MFA, NIST/HIBP password policy, brute-force lockout, Turnstile bot-check, IP-allowlist,
and strictest-wins per-org policy (mostly behind a default-OFF enforcement flag). The gaps are **passkeys/adaptive MFA**,
**risk-based/anomaly signals**, **security-notification emails** (absent, `AUTH-067`), **concurrent-session caps**
(`AUTH-042`), and the **observability** required before any lockout-capable control is flipped (`AUTH-012/022`). This
document specifies the target policy set and — critically — the **lockout-safe rollout discipline** every control must ship
under: default-OFF, staged (observe → soft-fail → enforce), with audited break-glass. Each policy carries an abuse-case
**"Must FAIL"** acceptance criterion.

## 1. Policy model

All controls are effective-policy rows (doc 03 §11, doc 11 `auth_policies`): platform default → org override → workspace
override, **strictest-wins for security keys** (an org can tighten, never loosen a platform minimum). Enforcement flips are
**per-tenant, default-OFF**, staged, and reversible without a deploy (break-glass owner local-login always exists). This is
the binding rule from the delivery-risk register — a stored knob suddenly enforced (a too-tight IP-allowlist, a misread CIDR,
forced-MFA with no enrollment) is the top way this program locks tenants out.

## 2. Multi-factor authentication

- **Factors:** TOTP (*Implemented*), **WebAuthn/passkeys** (target primary, `AUTH-024`), email OTP (target), recovery codes
  (*Implemented*, hashed shown-once); SMS discouraged fallback only; push out of scope (`AUTH-044`).
- **Enforcement:** org can require MFA (strictest-wins, `policy.ts`), **but only with the in-login forced-enrollment step
  shipped first** (done) plus the passwordless-safe enrollment path (`AUTH-069`, doc 05 §5) — otherwise forced-MFA locks
  factor-less members out.
- **MFA integrity (AUTH-011):** guard against downgrade (can't drop to a weaker factor to bypass) and untrusted
  self-enrollment (bind enrollment to the authenticating user; step-up before adding/removing a factor).
- **Must FAIL:** a user without an enrolled factor in a required-MFA org is **routed to enrollment**, never thrown out; a
  factor-removal without step-up is rejected and audited (`mfa.disable`, `AUTH-075`).

## 3. Passkeys / WebAuthn specifics

- **RP-ID design (critical):** choose the registrable domain `truepoint.in` as RP-ID so a passkey works across `app.` /
  `auth.` subdomains — but understand the cross-subdomain scope this grants; document it. The extension and future mobile
  need their own consideration (doc 08 §5).
- **Attestation:** optional for consumers; **AAGUID allowlist** available as an enterprise policy (restrict authenticator
  types).
- **Ceremony correctness:** origin + RP-ID + challenge binding, user-verification required, sign-count/replay checks;
  discoverable credentials + conditional-UI autofill.
- **Recovery:** passkey-only accounts need recovery codes + admin-assisted reset with verification (avoid lockout).
- **Must FAIL:** an assertion with a mismatched origin/RP-ID, a replayed challenge, or a stale sign-count is rejected.

## 4. Adaptive / risk-based authentication

- **Signals:** new device, impossible travel, IP reputation, VPN/Tor/proxy detection, device fingerprint novelty, velocity.
  Store in `auth_risk_signals` / `device_fingerprints` (doc 11), **consent-gated** (`AUTH-060`; profiling has a lawful-basis
  obligation under GDPR/DPDP).
- **Policy actions:** allow · step-up (require a fresh factor) · deny, driven by a risk score — modeled on Auth0 Adaptive MFA
  / Entra Conditional Access / Okta risk policies. Expose the thresholds as config (doc 04).
- **Trusted devices (`AUTH-049`):** wire the schema-only table to a 30-day MFA-skip after a verified device, revocable from
  `/account/security` (doc 05).
- **Must FAIL:** a login from a new device/impossible-travel context is **stepped-up**, not silently allowed; a revoked
  trusted device gets no skip.

## 5. IP / country restrictions

- **IP allowlist** (*Implemented*, CIDR-match, per-tenant) — ships staged with a CIDR-match (not string-equality) and a
  client-IP-spoofing guard (`AUTH-077`: env-driven trusted-hop count, since a fronting CDN breaks the single-hop assumption).
- **Country/geo restrictions** (target) — allow/deny by geo, config-driven.
- **Must FAIL:** a too-tight allowlist has a **break-glass** disable that re-opens login without a deploy; a spoofed XFF does
  not bypass the allowlist.

## 6. Bot / abuse defense

- **CAPTCHA:** Turnstile (*Implemented*, `botCheck.ts`) — placed on signup/login/forgot/OTP-issue; evaluate Turnstile vs
  reCAPTCHA Enterprise vs hCaptcha per doc 02.
- **Credential-stuffing defense in depth:** breached-password check **at login, not just registration**; per-IP / per-account
  / global rate tiers; **throttle over hard-lockout** where possible (lockout is itself a DoS vector).
- **Brute-force lockout** (*Implemented*, `rateLimit.ts`) — per-identifier + per-IP; **the reset-code lockout must not fail
  open** (`AUTH-071`) — currently a Redis outage disables the guard.
- **OTP-bombing / toll-fraud:** rate-limit OTP issuance + per-tenant spend caps (delivery-risk register).
- **Must FAIL:** N failed attempts throttle without permanently locking a legitimate user out of recovery; a Redis outage
  does not silently disable the lockout (it alerts, `AUTH-066`).

## 7. Anomaly detection & security notifications

- **Notifications (`AUTH-067`, currently Absent):** password-changed, new-sign-in (new device/location), MFA-changed,
  recovery-email-changed, session-revoked, new-API-key — each queued (doc 03 §9) with a one-click **"secure my account"**.
  This is the primary account-takeover tripwire and an ASVS V6/V8 expectation.
- **Anomaly detection:** flag improbable logins, mass-failure spikes, new-device bursts → risk signals + optional
  notification.
- **Must FAIL:** a credential/factor change with no notification is a test failure.

## 8. Account lockout & recovery workflows

- **Reset flow (fix, docs 01/05):** enumeration-safe (identical responses + **timing** — the inline-send oracle `AUTH-064`
  must go), rate-limited, single-use hashed high-entropy token (raise the ~20-bit code, `AUTH-071`), revoke-all-sessions on
  completion (*works*), and **queued delivery over a real ESP** (`AUTH-061/063`).
- **Self-unlock UX** after lockout; **MFA recovery** (recovery codes, admin-assisted reset with verification, waiting
  periods).
- **SSO-only/passwordless recovery** — don't silently enable password login on an SSO-only account (`AUTH-070`); route to the
  IdP.
- **Magic-link scanner problem** — confirm-button landing page so corporate link-scanners don't consume single-use links
  (doc 06 §2).
- **Must FAIL:** a reset token is single-use, expires, is rate-limited, and does not reveal account existence via timing.

## 9. Session & token security policies

- **Concurrent-session cap** (`AUTH-042`, target) — `maxConcurrentSessions` per policy, evict-oldest or reject.
- **Idle + absolute session timeouts** (*Implemented*, flagged) — staged rollout.
- **Revocation** — deny-list per request; fail-open **with alert** (`AUTH-066`); `pa` demotion session-revokes (`AUTH-072`).
- **Cookie/CSRF/CSP invariants** (`AUTH-053/055/056`) — `__Host-` refresh cookie, SameSite=Strict, nonce-CSP no-regression
  on new routes, session-fixation rotation on privilege change.

## 10. Threat gates every new surface must pass (ship gates, not follow-ups)

From the threat model — enforced before enablement:
- **SSRF-guarded** metadata/JWKS/discovery/DNS fetch (`AUTH-009`).
- **Open-redirect** allowlists, never reflected (`AUTH-036`).
- **Mass-assignment** allowlists — no `org_role`/`is_platform_admin` from an IdP/SCIM claim (`AUTH-034`).
- **SAML** anti-XXE / anti-signature-wrapping / reject-unsigned (`AUTH-001`, doc 07) — the recent SAML CVE class (signature
  confusion / assertion forgery) makes these non-negotiable.
- **OIDC** id_token sig/iss/aud/nonce/exp/PKCE/state validation (`AUTH-008`).
- **IdP-initiated SSO** bound to a pre-registered ACS with replay defence; SP-initiated default (`AUTH-035`).
- **Session-fixation** rotation; **CSRF/CSP** no-regression (`AUTH-053/055`).

## 11. Observability (pre-req for enforcement)

Before any flip: login success/failure, MFA challenge/enroll, refresh-reuse revocations, **deny-list read/write errors**
(the fail-open signal), token-mint failures, JWKS health, SSO/SCIM error rates, per-tenant auth SLOs (`AUTH-012/022`).
Structured logs carry **no PII/tokens/secrets**.

## 12. Requirements, testing, migration, risks

- **Functional:** every control is config (doc 04), staged, break-glass-safe, audited, observable.
- **Non-functional:** policy resolution is cached + versioned; risk scoring is async where possible; WCAG/i18n on all
  security UI.
- **Testing:** each policy has its **Must-FAIL** abuse test as the ship gate; cross-tenant isolation on any new table.
- **Migration:** enforcement flips roll out observe → soft-fail → enforce per tenant; break-glass documented before the flip.
- **Risks (register Part 2):** SSO-against-stub lockout, enforcement-flag lockout, forced-MFA-without-enroll, SMS
  cost/bombing, HIBP dependency, signing-key compromise — each with its stated mitigation.
- **Future:** continuous/step-up risk auth, device-bound credentials (DPoP/passkeys), CAEP-driven cross-service revocation,
  ML anomaly scoring.
