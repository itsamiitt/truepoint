# 05 — User Security Settings (Self-Service Dashboard)

> Document 5 of 12 · TruePoint Centralized Authentication Platform. Redesigns the end-user security self-service surface.
> Grounded in the security-settings audit
> ([`_evidence/audit/security-settings.md`](./_evidence/audit/security-settings.md)).

## Executive summary

**The self-service surface is built and works — but no user can reach it.** `apps/auth/src/app/account/security/*` (shipped
as P1-02) already implements password change, TOTP enroll/disable, recovery codes, session list/revoke, and login history —
all real, step-upped, ownership-checked, and mostly audited. The reason "users cannot manage their security settings" is a
single wiring bug: the in-product deep links omit the `/auth` basePath and **404** (`AUTH-062`, Critical). Fix that one line
and the existing surface becomes reachable.

Once reachable, four gaps still bite: passwordless users hit a **step-up catch-22** and can never self-enroll MFA
(`AUTH-069`); the in-product panel **shows the wrong state** (hard-codes MFA "Not set up", `AUTH-068`); there are **no
security-notification emails** at all (`AUTH-067`); and several advertised capabilities are absent — passkeys/SMS/email OTP
(`AUTH-024/025`), trusted devices (`AUTH-049`, schema-only), connected apps / API keys (`AUTH-017`), and email-change
(`AUTH-018`). This document specifies the complete self-service dashboard, its API, and the sequencing to close those gaps.

## 1. Current state (what exists, verified)

| Capability | State | Evidence |
|---|---|---|
| Change password | **Works** (step-up, NIST/HIBP, Argon2id, revokes other sessions) — unreachable | `account/security/actions.ts:43-98` |
| TOTP enroll / disable | **Works** (first-verify-then-persist, encrypted) — unreachable; passwordless blocked | `actions.ts:106-211`; `stepUp.ts:53-74` |
| Recovery codes | **Works** (hashed, shown once) | `actions.ts:220-242` |
| Session list + revoke (single/all-others) | **Works** (ownership-checked, deny-list) | `actions.ts:249-271` |
| Login history | **Partial** (own sessions, last 20; no failures/geo/events) | `data.ts:98`; `HistorySection.tsx` |
| Passkeys / WebAuthn | **Absent** (advertised in UI) | `mfa.ts:2`; `SecurityPanel.tsx:28` |
| SMS / email OTP | **Absent** (enum only) | `user_mfa_methods.type` |
| Trusted devices | **Absent** (schema-only, promised in copy) | `schema/auth.ts:235`; no runtime usage |
| Connected apps / OAuth grants | **Absent** (UI ships vs nonexistent endpoints) | `settings-developer/api.ts:35-37` |
| API tokens / PATs | **Absent** | same |
| Email/recovery-method change | **Absent** | no flow in `account/security/*` |
| Security-notification emails | **Absent** (3 templates only) | `apps/auth/src/lib/emails/` |
| Data export / account deletion (user scope) | **Absent** | settings-user has Profile/Security/Notifications only |

## 2. Findings this document resolves

`AUTH-062` (reachability — the report), `AUTH-067` (notifications), `AUTH-068` (fake MFA state), `AUTH-069` (passwordless
enroll catch-22), `AUTH-017` (API keys / connected apps), `AUTH-018` (email-change), `AUTH-024/025` (passkeys/OTP),
`AUTH-049` (trusted devices), `AUTH-075` (audit `mfa.disable`), plus the login-history and QR polish items.

## 3. Functional requirements — the complete dashboard

All credential surfaces live on the IdP origin (`/auth/account/security`, P1), reachable from the product via correctly
prefixed links; the in-product `apps/web` panel is a **read-through** that shows true state and deep-links to the IdP for
mutations.

1. **Password** — change (existing), with strength meter + breach check; "you have no password / set one" for passwordless.
2. **MFA / two-step** — TOTP (existing) + **passkeys/WebAuthn** (new, primary target) + email OTP (new) + recovery codes;
   per-method add/remove; a **passwordless-safe enrollment path** (§5) fixing `AUTH-069`.
3. **Passkeys** — register/rename/remove; conditional-UI autofill; the recommended primary factor (doc 09).
4. **Active sessions** — list (device, IP, location, last-seen, current), revoke one / all-others (existing) + **revoke-all
   incl. current** (with re-auth).
5. **Trusted devices** — list + revoke; the 30-day MFA-skip is backend-new (`AUTH-049`, doc 09).
6. **Connected applications / OAuth grants** — third-party apps the user authorized; per-grant revoke (needs the OAuth
   consent store, doc 08 §7).
7. **API keys / personal access tokens** — create (scoped, shown-once), list, revoke, last-used; needs the API-key backend
   (`AUTH-017`, docs 10/11).
8. **Recovery methods** — recovery email/phone; **secure email-change** (verify old + new, delayed + revocable, revoke
   sessions — `AUTH-018`).
9. **Security notifications** — user-visible log + the emails themselves (§6).
10. **Login history** — successful + **failed** attempts, device/geo, auth events (not just own sessions) — `AUTH` login
    history is derived from the auth-event stream (doc 03 §8), not `sessions.slice(0,20)`.
11. **Privacy / data** — consent view; **data export** (user's own identity/auth data) and **account deletion** at the user
    scope (distinct from tenant DSAR, `AUTH-014`).

## 4. The reachability fix (AUTH-062 — do first)

One-line: `authLink()` builds `${AUTH_ORIGIN}/auth/account/security${section?…}`. Add:
- a **link-shape test** over every `apps/web`/`apps/admin`→auth URL (shared with doc 08);
- a **redirect** in `apps/auth` from the un-prefixed `/account/security` to the prefixed path;
- fix `requireUser` to carry an **allow-listed same-origin `next`** so an expired-session bounce returns the user to the page
  they wanted, not the app shell (audit F11).

This alone turns "users cannot manage security settings" off — the surface behind it already works.

## 5. The passwordless enrollment fix (AUTH-069)

`startTotpEnroll` requires step-up, but passwordless users (magic-link / SSO-JIT) with no verified TOTP can never pass it.
Target:
- Accept a **fresh identity proof** as step-up for passwordless users: a just-completed magic-link/email-OTP confirmation, or
  a short **recent-login freshness window** (e.g. authenticated < 5 min ago via the current session's `auth_time`).
- **Passkey registration** needs no prior factor (the ceremony itself is the proof) — shipping WebAuthn (doc 09) is the clean
  structural fix and should be the primary passwordless enrollment path.
- The UI must **hide "Begin setup"** when no step-up credential exists, with explanatory copy, instead of offering a form
  that always fails.

## 6. Security-notification emails (AUTH-067)

Add templates + fire best-effort (queued, doc 03 §9) on: **password changed**, **new sign-in** (new device/location),
**MFA method added/removed**, **recovery email changed**, **session revoked**, **new API key created**. Each carries a
one-click **"secure my account"** action (force-logout-all + password reset). This is the Auth0/Okta baseline and an
ASVS V6/V8 expectation; its absence today means an account-takeover victim gets zero signal.

## 7. UI/UX recommendations

- **One IdP-hosted dashboard** (`/auth/account/security`), sectioned (Password · Two-step · Passkeys · Sessions · Devices ·
  Connected apps · API keys · Recovery · Notifications · Login history · Privacy). WCAG 2.2 AA + i18n as ship gates
  (`AUTH-020`).
- **In-product panel shows true state** — replace the hard-coded `enrolled:false` (`AUTH-068`) with a security-reviewed,
  authenticated cross-origin **enrolled-methods read** (auth→app), or drop the badges until that read exists. Never render a
  fabricated security state.
- **Step-up is contextual** — re-prove before any sensitive change; passwordless users get the §5 path.
- **Shown-once discipline** — recovery codes, API keys, and TOTP secrets are displayed exactly once (existing pattern via the
  one-time `lw_acct_enroll` cookie).
- **Scannable QR** for TOTP (CSP-safe `data:` image) in addition to the manual key (audit F13).
- **Four states** on every list (loading/empty/error/populated) per the design system.

## 8. API specification (representative)

```
GET    /auth/account/security                       → dashboard read model (methods, sessions, devices, grants)
POST   /auth/account/password                       (step-up) change password → revoke others + notify
POST   /auth/account/mfa/totp/enroll|verify|disable (step-up)                → notify
POST   /auth/account/mfa/passkey/register|remove    (WebAuthn ceremony)      → notify           (new)
POST   /auth/account/mfa/recovery-codes/regenerate  (step-up)                                    (new label)
GET    /auth/account/sessions | POST .../revoke     (ownership-checked, deny-list)
GET    /auth/account/devices  | POST .../revoke     (trusted devices)                            (new)
GET    /auth/account/connected-apps | POST .../revoke  (OAuth grants)                            (new)
GET/POST/DELETE /auth/account/api-keys              (scoped, shown-once)                          (new)
POST   /auth/account/email/change/{start,confirm}   (verify old+new, revoke sessions)            (new)
GET    /auth/account/history                        (auth-event derived: logins, failures, changes) (upgraded)
POST   /auth/account/export | POST /auth/account/delete  (user-scope DSAR)                        (new)
```

Every mutation is step-up-gated, RFC-9457-error-shaped, audited (incl. the missing `mfa.disable` + platform-scope
`session.revoked` — `AUTH-075`), and emits a notification event.

## 9. Security considerations

- **Authorization is server-side** — every read/write is scoped to the authenticated `userId` from the durable session
  (`requireUser`), never a client-supplied id.
- **Step-up before sensitive changes**; the passwordless path (§5) must not become a step-down.
- **No fabricated state** (`AUTH-068`) — a wrong "you're protected" badge is worse than none.
- **Email-change is a takeover vector** — verify both addresses, delay + allow-revoke, notify the old address, revoke
  sessions (`AUTH-018`).
- **API keys are bearer secrets** — scoped, shown once, hashed at rest, revocable, last-used tracked (docs 10/11).
- **Notifications are the tripwire** — the `AUTH-067` emails are how a victim learns of takeover.

## 10. Non-functional requirements

Dashboard read < 300 ms P95 (cached read model); mutations queue their side-effects (email) so the response is fast;
WCAG 2.2 AA + i18n; all actions observable (auth-event stream) and rate-limited.

## 11. Testing strategy

- **Reachability regression** (link-shape test) — the AUTH-062 guard.
- **Passwordless enrollment** — a magic-link-only user can enroll a passkey / TOTP via the §5 path; the old catch-22 is gone.
- **True-state panel** — a TOTP-enrolled user sees "enabled", not "Not set up".
- **Notification fan-out** — each sensitive action produces exactly one queued notification.
- **Step-up** — every sensitive mutation rejects without a fresh proof; ownership checks reject foreign ids.
- **Email-change** — old+new verified, sessions revoked, old address notified.

## 12. Migration strategy

1. **AUTH-062 reachability fix** (one line + test + redirect) — ships alone, closes the report.
2. **AUTH-068 true-state read** + **AUTH-067 notifications** — near-term, high user-trust value.
3. **AUTH-069 passwordless enrollment** + **WebAuthn/passkeys** (doc 09) — the structural MFA fix.
4. **Email-change (AUTH-018)**, **connected-apps/API-keys (AUTH-017, docs 10/11)**, **trusted-devices backend (AUTH-049)**,
   **login-history upgrade**, **export/deletion** — sequenced in doc 12.

## 13. Risks & future enhancements

- **Cross-origin enrolled-methods read** must be security-reviewed (it exposes MFA state to the app origin) — authenticated,
  minimal, per-role-shaped.
- **Passkey-only accounts** need a recovery story (recovery codes + admin-assisted reset with verification, doc 09) to avoid
  lockout.
- **Future:** passkey-as-primary with password deprecation, device-bound API keys, in-product security score/nudges,
  self-service SSO-account linking.
