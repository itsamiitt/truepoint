# Auth-platform — security review summary

The reviewer's one-page map for `feat/auth-platform-phase0`: what a review pass **verified sound** (no action)
vs. what is **flagged** (a decision/hardening before the relevant flag is flipped). Details live in the linked
rows of [`IMPLEMENTATION_PROGRESS.md`](./IMPLEMENTATION_PROGRESS.md); enable order is
[`../_runbooks/rollout.md`](../_runbooks/rollout.md). Everything security-sensitive ships **off by default**.

## Verified sound (reviewed, no change needed)

| Area | What was checked | Verdict |
|---|---|---|
| Email OTP / magic-link tokens | Code = `randomInt` CSPRNG (not `Math.random`); consume = one atomic `UPDATE … WHERE consumed_at IS NULL … RETURNING` | Single-use, no replay race (CI itest proves the concurrent case) |
| `/metrics` (auth + api) | `METRICS_TOKEN`-gated; 404 when unset (both processes, tested) | No unauthenticated SLI leak |
| MFA SLI + audit | `auth_mfa_challenge_total` covers TOTP + email-OTP + passkey; `mfa.success`/`mfa.failure` audited | Complete |
| Session eviction | `sessionsToEvict` pure + unit-tested; concurrent-cap enforced at login | Correct |
| Mailer | Detects MailHog-in-prod / unset SMTP → **alertable** MISCONFIGURED marker, never silent-success | No silent forgot-password |
| SCIM deprovisioning | Flips membership `deactivated` **and** `revokeAllSessionsForUser` (deny-list); ~30 s rotation-race handled | Immediate access cut |
| SSO connection→tenant routing | Client-supplied `tenant` only selects the IdP; IdP constrains identity; callback validates vs the txn tenant | Client can't cross tenants |
| Passkey isolation | `webauthn_credentials` REVOKEd from `leadwolf_app` (owner-only) — CI itest; cross-user assertion refused — unit test | Sound |
| Multi-tenant login authz | `finalizeLogin` authorizes client `tid`/`wid` vs REAL memberships (`authorizeTenantSelection`) | Sound |

## Flagged — decision/hardening before enable

| Item | Sev | Finding | Mitigation / decision | Flag |
|---|---|---|---|---|
| **Passkey ceremony** | — | Built end-to-end, off by default; crypto = vetted `@simplewebauthn` | Review the §9 checklist (RP-ID = registrable domain, origin allow-list, single-use challenge, cross-user refusal, counter clone-detection) before `WEBAUTHN_ENABLED`+`WEBAUTHN_RP_ID` | rollout §9 |
| **SSO JIT account-linking** | **High (latent)** | `provisionSsoIdentity` auto-links by `findByEmail`, no domain check (jit.ts:16). Not exploitable now (SSO stubbed in prod); with a real adapter, a rogue org IdP could link to any global user + reach their other orgs | Restrict linking to the org's VERIFIED domains (`auth_domains`) and/or an explicit policy + `email_verified`. Land WITH the real adapter | tracker P4 |
| **Real SAML/OIDC adapters** | High | `oidcProvider`/`samlProvider` throw until wired; the mock exercises the flow | **Build-vs-buy** (research). If build: assertion validation (anti-XXE / anti-signature-wrapping / reject-unsigned) is the top risk. Flip `WIRED_PROD_PROTOCOLS` when it lands | tracker P4 · brief |
| **`enforced` vs `require_sso`** | Med | The SSO panel's "enforce SSO" writes `tenant_sso_configs.enforced`, which is NOT enforced at login; the gates enforce `require_sso` | Deprecate `enforced`, or have the panel drive the guarded `require_sso` write | tracker P4 |
| **Resolve-time policy floor** | Med | Floor is write-time-enforced only; a sub-floor row (floor RAISE / direct write) resolves below the raised floor | Clamp at resolve (silent defense-in-depth) vs. a `findFloorViolations` remediation report | tracker 1.2d |
| **Trusted-device MFA skip** | Med | Half-scaffolded; the checkbox is now hidden behind `TRUSTED_DEVICES_ENABLED` | It SKIPS MFA — build the token store/skip-check/revocation off-by-default + specialist review | tracker · rollout |
| **Effective-policy cutover** | — | Shadow mode ready; enforcement still on `tenant_auth_policies` | Flip to the engine only after `auth_policy_shadow_total` reads ~100% `match` in prod | rollout §4 |

**Guardrails already in place:** SSO no-lockout guard (`require_sso` → 403 `sso_not_ready` unless the connection
is enabled + wired); passkey add/remove step-up + audit + owner-notify; extension-scope observe-first;
lockout-capable gates behind an env master-arm + per-tenant switch.

**One-line posture:** everything security-sensitive is off by default and reviewable in isolation; the flagged
items are decisions (build-vs-buy, three security-design calls, one product call), each with the finding + fix
spelled out — none is a live vulnerability on this branch.
