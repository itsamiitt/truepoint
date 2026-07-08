# Runbook — Auth-platform rollout (branch `feat/auth-platform-phase0`)

This branch ships Phase 1 (effective-policy engine), Phase 2 (token/session hardening), and part of Phase 3
(email-OTP factor, breached-password screening, passkey schema). **Almost everything lands OFF or additive** —
merging/deploying the branch changes no behaviour on its own. This runbook is the safe **enable order**: several
controls have a staged rollout where enabling the second step before the first is deployed everywhere causes an
outage (spurious logouts / lockouts). Do the steps top-to-bottom; each is independent unless noted.

Convention: **A)** applied automatically on deploy · **B)** enabled by an env flag · **C)** enabled by a data
action or admin UI · **★** staged — order matters.

---

## 0. On deploy (automatic — verify only)

- **A · Migrations** `0053–0055` create `auth_policies`, `auth_allowed_origins`, `webauthn_credentials`. Verify
  `migrate` ran clean (all `*.itest.ts` green in CI is the proof).
- **A · Grant-gap REVOKEs** — `user_mfa_methods` / `auth_email_tokens` / `trusted_devices` / `webauthn_credentials`
  are REVOKEd from `leadwolf_app` on every `applyMigrations`. No action; `userScopedAuthIsolation.itest.ts` proves it.
- **A · JWT clockTolerance (30s)** and **A · email-OTP MFA option** are live immediately (the email option only
  appears for users who already have TOTP; it needs a working transactional mailer — see §6).

## 1. Client IP behind the edge — `TRUSTED_PROXY_HOPS`

- **B** · Default `1` = a single Caddy edge (today's behaviour). Set to `2` **only if** a trusted CDN
  (Cloudflare) also sits in front. Under-counting is the safe direction; over-counting reads a client-forgeable
  XFF entry. Verify per-IP throttling/lockout still keys on the real client IP after changing.

## 2. Observability — `METRICS_TOKEN`

- **B** · Unset ⇒ `/metrics` 404s (invisible). Set a strong secret **and put the endpoint behind an internal
  network**, then scrape `GET /metrics` on both apps/api and apps/auth with `Authorization: Bearer <token>`.
  Watch `auth_login_total`, `auth_policy_block_total`, `auth_token_mint_total`, `auth_revocation_check_total`
  before flipping any lockout-capable control below.

## 3. ★ `__Host-` refresh cookie — two deploys

1. **A** (this branch) — readers already accept both cookie names. **Wait for it to roll out to every instance.**
2. **B** — set `REFRESH_COOKIE_HOST_WRITE=true`. Writers now emit `__Host-lw_refresh` (no Domain). Readers (step 1)
   handle it. **Never flip step 2 before step 1 is fully live** — a new-writer/old-reader mix spuriously logs users out.
3. Later — once no legacy `lw_refresh` cookie can still be in flight (> refresh TTL), drop the legacy read (code change).

## 4. ★ Effective-policy engine — shadow → cutover

1. **C** — run the one-time backfill (`effectivePolicyRepository.backfillTenantPolicies` via a `withPlatformTx`
   admin action) so `auth_policies` mirrors the live `tenant_auth_policies`. Idempotent.
2. **B** — set `AUTH_POLICY_SHADOW_ENABLED=true`. Login now ALSO resolves the engine and emits
   `auth_policy_shadow_total{match|mismatch|error}` — **enforces nothing**. Watch it reach ~100% `match`
   (mismatch = the backfill missed a tenant, or a new platform default; investigate each).
3. **Cutover** (a later code change, gated on step 2 being ~100% match) — switch `finalizeLogin` to enforce the
   engine's resolved policy instead of `tenant_auth_policies`. Do this design-first; it is the one genuinely
   risky flip. `enforcement_enabled` stays the staff switch on `tenant_auth_policies`, read alongside.
4. Staff manage platform defaults + org policy via the admin **Auth policy** console (already live) and the
   org `PUT /security/effective-policy` endpoint; every write is floor-guarded server-side.

## 5. Lockout-capable login gates (P1-01) — unchanged prerequisite

The IP-allowlist / allowed-methods / session+idle-timeout / forced-MFA gates fire ONLY when BOTH the global
`AUTH_POLICY_ENFORCEMENT_ENABLED="true"` AND a tenant's staff-set `enforcement_enabled` are on (unchanged by this
branch). Enable per VERIFIED tenant via `POST /admin/tenants/:id/auth-enforcement`; the observability in §2 is the
pre-req. Concurrent-session cap: set `max_concurrent_sessions` per tenant in the Auth-policy console — enforced at
login (evict oldest), additive, no flag.

## 6. Transactional mailer (email OTP, security notifications)

Email OTP and security emails need a real SMTP transport. Set `SMTP_URL` (e.g. Resend:
`smtps://resend:re_KEY@smtp.resend.com:465`) + verify the sending domain. The mailer logs a loud
`[auth-mail] MISCONFIGURED` marker if it is unset/MailHog in prod — alert on it.

## 7. Breached-password screening — `BREACHED_PASSWORD_CHECK_AT_LOGIN`

- **B** · Off by default. Set `true` to screen the just-verified password against HaveIBeenPwned (detached +
  fail-open) and record `auth_password_breach_check_total{breached|clean}`. Observe the `breached` rate before
  building the forced-reset enforcement (a later slice). Adds one HIBP range call per successful password login.

## 8. JWKS signing-key rotation

See [`jwks-key-rotation.md`](./jwks-key-rotation.md) — publish the NEXT key (`JWT_NEXT_*`) → wait > JWKS cache
TTL → cut the minter over → wait > access TTL → retire. Independent of everything above.

---

## Still flagged for specialist review (NOT built / NOT enable-ready)

- **Passkeys / WebAuthn ceremony** — only the credential schema + isolation exist; the registration/assertion
  ceremony (WebAuthn library, RP-ID, attestation, anti-replay) is unbuilt and **needs specialist review**.
- **Real SSO/SAML/OIDC + SCIM adapters** (Phase 4) — the XL long-poles; enforce the no-lockout guard first.
- **KMS-managed at-rest key**, **SMS OTP**, **social/OAuth login**, **adaptive step-up**, **forced-reset-on-breach**,
  the **`user_sessions` RLS** gap, and the **@leadwolf/auth-client** extract — all outstanding (see the progress tracker).
