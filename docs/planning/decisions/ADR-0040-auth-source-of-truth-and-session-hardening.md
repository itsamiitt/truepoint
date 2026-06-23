# ADR-0040 — Auth source-of-truth + session hardening

- **Status:** Accepted.
- **Date:** 2026-06-23
- **Supersedes/extends:** builds on [ADR-0016](./ADR-0016-token-exchange-and-sessions.md) (token exchange +
  sessions), [ADR-0019](./ADR-0019-org-workspace-selection.md) (org/workspace selection), and
  [ADR-0032/0034](./ADR-0034-bootstrap-platform-admin.md) (the `pa` claim). It records the decisions taken in
  the end-to-end auth audit + hardening pass.

## Context

An auth audit surfaced three reported defects (logged-in users still see auth pages; multi-org/workspace
routing felt wrong; the bootstrap admin couldn't log in after a `.env` change) and several unreported
issues (the `pa` claim being dropped on refresh/switch; logout not affecting already-issued access tokens;
password reset not evicting sessions; the password step being un-throttled; non-deterministic
workspace/org auto-selection; refresh-reuse not being punished; a spoofable client-IP). This ADR is the
single source of truth for **what the auth state model is** and **how each issue was resolved**.

## Decision — the single source of truth

For `{authenticated user, active org, active workspace, active role, session validity}`:

- **The durable session row (`user_sessions`, auth origin) is authoritative** for the user, active tenant,
  and active workspace. It is created only at `finalizeLogin` and rotated on refresh / workspace-switch /
  org-switch; it carries the selected scope.
- **The access-token claims (`tid`/`wid`/`sid`/`pa`) are a short-lived (~15 min) projection** of that row.
  `apps/api` derives tenant/workspace **only** from the verified claims (`middleware/tenancy.ts`); it never
  trusts the request body.
- **`role` is derived per-request** from `workspace_members` (`/auth/session`, the role guards). It is never
  stored in a token, so a role change takes effect on the next request.
- **`tenant_members.last_workspace_id`** is the persisted *default selector* (not an authority): the login
  flow lands on it when present and still a valid membership, else the org default, else the first workspace
  (deterministic order). This removes the "wrong workspace after re-login" symptom.
- **`TeamSwitcher` localStorage is UI-only** (an M15 seam) and is never promoted to an authority.

There is **no second store** for active org/workspace on the app origin (the access token lives in memory; no
app-domain cookie/localStorage holds scope), so client and server cannot drift.

## Decision — session lifecycle hardening

- **Immediate revocation deny-list (`packages/auth/revocation.ts`).** Every revocation (`revokeSession`,
  `revokeAllSessionsForUser`, and the `rotateSession` of the old id) writes a Redis `revoked-sid:<sid>` key
  with TTL = the access-token lifetime; `apps/api/middleware/authn.ts` rejects any token whose `sid` is
  listed. Logout / forced-logout / a workspace switch now take effect within seconds, not at the 15-min token
  expiry. **Fails open** on a Redis outage (the token is already verified + ≤15-min bounded) — matching the
  rate-limiter's posture.
- **Revoke-on-credential-change.** `completePasswordReset` calls `revokeAllSessionsForUser` (+ deny-list), so
  a reset evicts every existing session (e.g. an attacker's).
- **Refresh-token reuse detection (`findActiveSessionOrDetectReuse`).** A *revoked* refresh token presented to
  refresh/switch/org-switch is a replay of a captured value (the browser always sends the latest cookie) →
  revoke the whole family. A re-presentation inside a 30 s grace window is treated as a benign
  concurrent-refresh race (no family revocation), which avoids false-positive logouts.
- **`pa` carried across refresh + switch.** `refreshAccessToken` and `switchWorkspace`/`switchOrg` now pass
  `isPlatformAdmin` to `mintAccessToken`, so a platform/bootstrap admin keeps console access past the first
  silent refresh (was the real "admin can't stay signed in" cause).
- **Credential brute-force lockout (`rateLimit.ts`).** The password, MFA, and reset-code steps consume a
  per-identifier + per-IP failure counter (`assertCredentialNotLocked` / `recordCredentialFailure` /
  `recordCredentialSuccess`); a lockout returns the same uniform error (no enumeration). The identifier step's
  existing throttle is unchanged.
- **Redirect-if-authenticated (`apps/auth/lib/sessionGuard.ts`).** The auth entry pages
  (login/signup/forgot/reset/magic/sso) validate the `lw_refresh` session and bounce an already-signed-in
  visitor to an **allow-listed** app origin; fails open (renders the page) on a DB error.
- **`.env` is the source of truth for the bootstrap admin.** Provisioning is keyed off a stable
  `users.is_bootstrap_admin` marker and re-run by `deploy.sh` on every deploy, so a changed password is
  re-hashed and a changed email **renames** the same record (ADR-0034).

## Disposition of the lower-severity hardening findings

- **#9 — `wid ∈ tid` not re-validated in `tenancy.ts`:** accepted as-is. The mint paths already validate
  workspace membership within the resolved tenant before minting `wid`, and RLS scopes every workspace-bound
  table by the `tid` GUC, so a mismatched `wid` cannot read another tenant's rows. A per-request membership
  lookup would add cost for no additional isolation.
- **#10 — SSO JIT trusts the IdP-asserted email domain:** **follow-up.** The validated IdP is the trust
  anchor today; requiring the asserted email's domain to match the tenant's verified `tenant_domains` is
  defence-in-depth. Deferred to avoid breaking legitimate multi-domain SSO without a per-tenant allow-domain
  policy.
- **#11 — login-transaction cookie not IP/UA-bound:** **declined.** `lw_login_txn` is already
  HttpOnly + Secure + SameSite=Strict (so not cross-site stealable), and hard-binding a multi-minute
  interactive flow to an IP causes false-positive failures for roaming/mobile users. The short-lived (60 s)
  cross-domain **code** remains IP-bound where roaming risk is negligible.
- **#12 — email-code purpose/replay:** already mitigated — `auth_email_tokens` hashes `(purpose, email,
  code)` and consumes atomically, so a code is single-use and cannot be replayed across purposes or addresses.
- **#13 — selection-step rate-limit:** accepted as-is. The org/workspace selection steps require a prior
  successful primary auth (a live `lw_login_txn`) and only ever reveal the caller's OWN memberships, so there
  is no cross-user enumeration to throttle.
- **#14 — spoofable client IP:** **fixed.** `clientIpFromHeaders` now takes the LAST `X-Forwarded-For` entry
  (the one Caddy appends), which the client cannot forge, so IP-keyed throttling/lockout and code-binding
  cannot be evaded by spoofing the header.

## Follow-up — in-login MFA enrollment (finding #7)

For a tenant whose policy is `mfaEnforcement = "required"`, `finalizeLogin` currently throws `mfa_required`
for an un-enrolled user, which locks them out. The planned fix is a forced in-login TOTP **enrollment** step
in `apps/auth` (generate + encrypt a secret, show the QR + manual key, verify a first code, then continue the
login) reached when `resolveNextStep` detects a required-MFA org with no verified method — instead of erroring
at the token gate. Tracked as a follow-up; the enforcement (fail-closed) stays until the enrollment screen
ships, so security is never weakened in the interim.

## Consequences

- Predictable, single-source-of-truth scope; immediate revocation; admin sessions that persist; brute-force
  and reuse resistance; deterministic routing. One added Redis `GET` per authenticated API request (the
  deny-list), cheap and fail-open.
- New migrations `0009` (`is_bootstrap_admin`) and `0010` (`last_workspace_id`).
