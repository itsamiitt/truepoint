# 12 — Implementation Roadmap

> Document 12 of 12 · TruePoint Centralized Authentication Platform. Sequences the whole program: the P0 hotfix bundle that
> turns off the reported breakage, then the centralized-platform build. Extends `Authentication plan/08-roadmap.md` (the
> canonical delivery-wave doc) and the updated `AUTH-###` register in doc 01. Effort sizing (S/M/L/XL) and the delivery-risk
> discipline are inherited from `Authentication plan/11-gap-register.md` Parts 2–3.

## Executive summary

The program has **two distinct phases**. **Phase 0 (P0 hotfix, days not weeks)** fixes the three reported failures on top of
the sound core — it is small, independently shippable, and does not touch the architecture. **Phases 1–5 (the platform
build)** add the centralized, configurable IdP: the effective-policy engine, the admin console, the full login-method matrix,
real SSO/SCIM, passkeys, the developer/OAuth platform, and the operational hardening (key rotation, KMS, observability).

Two axes govern sequencing and must not be conflated (inherited from the existing plan): **business priority** (how badly an
enterprise needs it) vs **delivery wave** (dependency order it can ship in). Passkeys are P0 business priority but land in a
later wave because they depend on the `/account/security` surface (which now exists — that dependency is **unblocked**).
Every lockout-capable control ships **default-OFF, staged (observe → soft-fail → enforce), with audited break-glass**.

## The two-axis view

| | Business priority (what enterprises demand) | Delivery wave (what can ship when) |
|---|---|---|
| Highest | SSO enforcement, SCIM deprovision, passkeys, session controls, audit | P0 hotfix (breakage), then policy engine + admin console |
| Driver | enterprise deal blockers, security questionnaire | dependencies: surface exists → policy engine → providers → enforcement |

## Effort sizing (inherited)

- **S** ≤ ½ day — reuse a primitive; no new table/dependency.
- **M** 1–2 days — bounded endpoint/gate over existing data; small additive schema.
- **L** ~1 week — net-new feature with its own tables, API, isolation tests.
- **XL** multi-week / specialist — protocol-correctness/ceremony where the threat-model ACs (doc 09) are the ship gate.

---

## Phase 0 — P0 hotfix bundle (turn off the reported breakage)

Ships ahead of, and independent of, everything else. Closes the three reported failures.

| # | Item | AUTH | Effort | Verification (Must-FAIL gate) |
|---|---|---|---|---|
| 0.1 | **Add `/auth` basePath to all constructed auth URLs** (reset/magic links + `/account/security` deep links) + link-shape test + redirect from un-prefixed path | AUTH-062 | S | A reset link and a security-settings link resolve (not 404); the test fails if any cross-app/email URL omits `/auth` |
| 0.2 | **Real transactional email**: replace MailHog with an ESP; **queue** the send (BullMQ) with retry + bounce handling; **production env gate** so unset/typo'd sender fails loudly; remove inline send | AUTH-061, 063, 064 | L | With SMTP down, the flow **does not** report success and **does not** 500 the known-account branch (timing oracle gone); a real inbox receives the reset |
| 0.3 | **Extension scope enforcement**: API middleware reads `claims.scope`, restricts extension-audience tokens to a prospecting allow-list, deny-by-default | AUTH-065 | M | An extension token is **rejected** on a non-prospecting `/api/v1` route; web token unaffected |
| 0.4 | **Deny-list observability**: alert whenever the revocation read/write fails; optional short-TTL in-process fallback | AUTH-066 | S | A simulated Redis outage raises an alert; residual window is bounded + visible |
| 0.5 | **Security-notification emails**: password-changed / new-sign-in / MFA-changed templates, fired best-effort (queued) | AUTH-067 | M | Each sensitive action produces exactly one queued notification with a "secure my account" action |
| 0.6 | **In-product true MFA state** (or remove fake badges) | AUTH-068 | M | A TOTP-enrolled user sees "enabled", never a fabricated "Not set up" |
| 0.7 | **Passwordless enrollment path** (fresh-proof step-up) + hide unusable "Begin setup" | AUTH-069 | M | A magic-link-only user can enroll a factor; the always-failing form is gone |

**Phase 0 exit:** forgot-password delivers a working reset; `/account/security` is reachable and usable by every user class;
the extension token is actually scoped; revocation outages are visible. No architecture changed.

---

## Phase 1 — Foundation: the effective-policy engine + admin console shell

The configuration backbone everything else plugs into (docs 03 §11, 04, 11).

| Item | AUTH | Effort | Notes |
|---|---|---|---|
| Effective-policy store + resolver (platform default → org → workspace, strictest-wins, versioned, cached) | — | L | Subsumes `tenant_auth_policies`; schema doc 11 |
| Config write path: `withPlatformTx`-audited, staff-RBAC-gated, cannot loosen a security minimum | AUTH-021 | M | Staff-app hardening (mandatory phishing-resistant MFA + IP allowlist + step-up) |
| Admin console shell (`admin.truepoint.in` auth module) + navigation | — | M | Doc 04 |
| Allowed-origins/callback URLs as managed config (env as floor) | AUTH-036 | M | Doc 08 §3 |
| Auth observability + SLIs + dashboards (pre-req for any enforcement flip) | AUTH-012, 022 | L | Doc 03 §10, doc 09 |
| Drizzle snapshot-debt stitch (prereq for clean additive migrations) | — | M | `_MAIN_MERGE_TODO.md`; doc 11 |

## Phase 2 — Token/session hardening + concurrent controls

Closes the operational gaps in the core (doc 03 §7, doc 10).

| Item | AUTH | Effort |
|---|---|---|
| Dual-key JWKS publication + overlapping-`kid` rotation runbook | AUTH-013 | M |
| KMS-managed at-rest key + key-versioned re-encrypt (off the dev-derived key) | AUTH-013 | M |
| `pa` demotion → session-revoke (close in-token residual) | AUTH-072 | S |
| Concurrent-session cap (`maxConcurrentSessions` policy) | AUTH-042 | M |
| `clockTolerance:30s`; env-driven trusted-XFF-hop count | AUTH-076, 077 | S |
| `__Host-` refresh cookie (dual-read transition window) | AUTH-074 | S |
| Extract `@leadwolf/auth-client`; admin refresh single-flight; admin callback client-nav | AUTH-073, 078 | M |

## Phase 3 — Login methods + MFA depth (incl. passkeys)

The configurable method matrix (docs 06, 09) — business-P0, now unblocked by the existing `/account/security` surface.

| Item | AUTH | Effort |
|---|---|---|
| Login-method registry (enable/disable/priority/org-restrict as data) | — | L |
| **WebAuthn / passkeys** (registration + assertion ceremony, RP-ID for the subdomain estate, attestation policy) | AUTH-024 | XL |
| Email OTP factor; SMS OTP as rate-limited fallback-only (spend-capped) | AUTH-025, 058 | M/L |
| Adaptive/risk step-up (new-device, impossible-travel, IP reputation) + policy actions | — | L |
| Social/OAuth login (build the dead path) | AUTH-015 | L |
| CAPTCHA/Turnstile placement + credential-stuffing tiers; breached-password at login | — | M |

## Phase 4 — Enterprise SSO + SCIM (real adapters)

The XL long-poles; the enterprise deal-blockers (doc 07). **Ship the no-lockout guard first.**

| Item | AUTH | Effort |
|---|---|---|
| `require_sso` no-lockout guard (cannot enable against the throwing stub; test-connection unlocks) | AUTH-031 | M |
| **Real OIDC adapter** (arctic): authorize → code → id_token sig/nonce/PKCE → attribute map → JIT | AUTH-008 | XL |
| **Real SAML adapter** (@node-saml): signed-assertion validation with **anti-XXE / anti-signature-wrapping / reject-unsigned** as ship-blockers | **AUTH-001** | XL |
| SCIM Groups + group→role mapping; deprovision automation with a **tested stale-access bound** | AUTH-010 | L |
| Domain DNS-TXT verification worker (claimed domains stop sitting `pending`) | AUTH-041 | M |
| SSO lifecycle: back-channel logout (SLO), metadata refresh, cert rotation; IdP-initiated bind-to-ACS + replay defence | AUTH-016, 035 | L/XL |
| Self-service SSO setup wizard + test-connection tool (the WorkOS admin-portal pattern) | — | L |

## Phase 5 — Developer platform + operate-and-comply

The OAuth authorization server, machine auth, and the run/comply surface (docs 04/09/10).

| Item | AUTH | Effort |
|---|---|---|
| OAuth 2.1 authorization server (code+PKCE, client-credentials, device grant, token-exchange) + discovery + consent | AUTH-017 | XL |
| API keys / PATs / **service accounts** + connected-apps self-service | AUTH-017 | L |
| Signed outbound auth webhooks (SSRF-guarded) + SIEM export | AUTH-038 | L |
| CAEP / Shared-Signals transmitter (cross-service revocation) | AUTH-016 | XL |
| Secure email-change flow; user-scope export/deletion; DSAR/retention of auth artifacts | AUTH-018, 014 | L |
| Incident-response + breach-notification runbook; key-compromise runbook; FinOps (metered auth cost) | AUTH-037, 013, 059 | M |
| Data-residency map for auth artifacts (India DPDP / APAC) | AUTH-039 | M |
| Consent/lawful-basis registration before risk/device/geo profiling ships | AUTH-060 | S |

---

## Delivery-risk discipline (binding, inherited)

Every lockout-capable control (SSO enforcement, allowed-methods, IP-allowlist, session-timeout, forced-MFA) ships:

1. **Per-tenant default-OFF flag**; 2. **staged rollout** (observe-only → soft-fail → enforce); 3. **audited break-glass**
   owner local-login that re-opens access without a deploy. Specific risks (from the register Part 2):

- **`require_sso` against the throwing stub = org-wide lockout** → cannot enable until a real adapter passes test-connection.
- **Forced-MFA without an enrollment screen** → ship in-login forced enrollment first (done) + the passwordless path (0.7).
- **Enforcement-flag lockout** (too-tight IP-allowlist/CIDR misread) → staged + break-glass + CIDR-match not string-equality.
- **SMS cost / OTP-bombing** → rate-limit + spend-cap; SMS is discouraged fallback only.
- **HIBP dependency** → k-anonymity + fail-open to a local blocklist.
- **Signing-key compromise** → dual-key rotation + deny-list + KMS (Phase 2).

## Testing & migration strategy (program-level)

- **Every new tenant-scoped table** ships with a **cross-tenant isolation itest** (FORCE-RLS proven).
- **Every enforcement flip** has an **abuse-case "Must FAIL"** test (doc 09) as the ship gate.
- **SSO/SCIM** get negative suites (anti-XXE/anti-signature-wrapping/reject-unsigned; deprovision-revokes-session) before
  enablement.
- **Migrations:** stitch the snapshot debt first (Phase 1); additive, reversible, seed-preserving; feature-flag every
  behaviour change so rollback needs no deploy.

## Sequencing summary

```
Phase 0  P0 hotfix ........ AUTH-061..069            days      (turns off the reported breakage)
Phase 1  Policy engine + admin shell + observability weeks     (the config backbone)
Phase 2  Token/session hardening ................... 1–2 wks   (AUTH-013/042/072/074/076/077)
Phase 3  Login methods + passkeys + risk MFA ....... weeks     (AUTH-024/025; business-P0)
Phase 4  Real SSO + SCIM (XL long-poles) ........... weeks     (AUTH-001 Critical; deal-blockers)
Phase 5  Developer/OAuth platform + operate/comply . weeks     (AUTH-017; enterprise readiness)
```

## Risks & future enhancements

- **Phase 0 must not wait on the platform build** — it is the user-visible fix and ships first.
- **The XL long-poles (SSO adapters, OAuth server, passkeys, CAEP) need specialist review** — the threat-model ACs (doc 09)
  are the ship gate, not a follow-up.
- **Future:** DPoP-bound public-client tokens, per-region residency routing, first-party mobile, fine-grained
  authorization (the separate IAM/RBAC track, AUTH-045).
