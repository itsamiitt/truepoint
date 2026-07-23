# Audit — User security self-service (/account/security)

Auditor lane: user-facing security self-service (apps/auth `/account/security`, apps/web Settings ▸ User ▸ Security).
Date: 2026-07-06 (re-grounded verification pass — every cited line re-opened in current code).
Register basis: `Authentication plan/11-gap-register.md` (60 rows, AUTH-001…AUTH-060, canonical). New ids minted from AUTH-061.

## Verdict in one line

The `/account/security` surface is **built and works** (P1-02 shipped it: password change, TOTP enroll/disable,
recovery codes, session list/revoke, login history — all real, gated, step-upped, mostly audited), but **no user can
reach it from the product**: the only entry points — the four deep links in apps/web's SecurityPanel — omit the auth
app's `/auth` basePath and therefore 404 on every deploy shape. That is the real reason behind "users cannot manage
security settings."

## Current implementation (file:line map)

**apps/auth (the IdP, Next.js App Router, `basePath: "/auth"` — apps/auth/next.config.mjs:8):**

| Piece | File | Notes |
|---|---|---|
| Page (SSR, force-dynamic) | `apps/auth/src/app/account/security/page.tsx:26-52` | Sections: #password #mfa #sessions #history (SECTIONS at :19-24) |
| Auth gate | `apps/auth/src/lib/requireUser.ts:43-62` | Durable session resolved from hashed `lw_refresh` cookie; missing/revoked/expired/inactive → `redirect("/login")` (:45,:49,:53) — no return-to param |
| Read models | `apps/auth/src/app/account/security/data.ts:69-100` | hasPassword, MFA methods (detailed), recovery-code count, own sessions; history = `sessions.slice(0, 20)` (:98) |
| Server actions | `apps/auth/src/app/account/security/actions.ts` | changePassword:43, startTotpEnroll:106, verifyTotpEnroll:131, disableMfaMethod:191, regenerateRecoveryCodes:220, revokeOwnSession:249, revokeAllOtherSessions:263, finishEnroll:276, auditSessionRevoke:287 |
| Step-up re-auth | `apps/auth/src/app/account/security/stepUp.ts:38-75` | Current password (when passwordHash exists, :53-60) OR a live TOTP code from an already-verified factor (:65-70); wrapped in the credential lockout limiter (:46-49) |
| One-time enroll cookie | `apps/auth/src/app/account/security/enrollCookie.ts:10-29` | `lw_acct_enroll`, HttpOnly/Secure/Strict, 5 min (:11), deleted by finishEnroll (actions.ts:278) |
| Enroll/result screen | `apps/auth/src/app/account/security/enroll/page.tsx:25-29+` | TOTP manual key + otpauth URI + confirm form; recovery codes shown once; no QR image (acknowledged, :8-11) |
| Sections (UI) | `PasswordSection.tsx` (passwordless copy :106-111), `MfaSection.tsx:34-172`, `SessionsSection.tsx`, `HistorySection.tsx:1-15` | All forms wired to the real server actions (MfaSection.tsx:8) |
| Mid-login forced enroll (separate) | `apps/auth/src/app/mfa/enroll/*` | Distinct cookie `lw_mfa_enroll` — no collision with `lw_acct_enroll` |
| Refresh cookie | `apps/auth/src/lib/cookies.ts:6-18` | `lw_refresh`, HttpOnly/Secure/SameSite=Strict, `Domain=AUTH_COOKIE_DOMAIN`, Path=/ |

**apps/web (the client):**

| Piece | File | Notes |
|---|---|---|
| Nav entry | `apps/web/src/components/shell/navConfig.ts:63` | User ▸ Security → `/settings/security` (present for every user) |
| Panel | `apps/web/src/features/settings-user/components/SecurityPanel.tsx` | Read-only map + four "Manage on the sign-in site" deep links via `authLink()` (:21-23); MFA catalogue hard-coded `enrolled: false` (:26-32) |
| Auth origin | `apps/web/src/lib/publicConfig.ts:9` | `NEXT_PUBLIC_AUTH_ORIGIN` build-inlined; empty string on single-domain deploys |
| Single-domain rewrites | `apps/web/next.config.mjs:21-22` | Only `/auth/:path*` (and `/.well-known/*`) proxy to the auth service — an un-prefixed `/account/security` matches nothing |
| Developer scope (adjacent) | `apps/web/src/features/settings-developer/api.ts:35-37` | Calls `/api/v1/tenants/me/api-keys` + `/tenants/me/oauth-apps` + `/webhooks` — **no such routes exist in apps/api** (grep of apps/api/src: zero matches) |

## What works (verified on the auth origin itself)

- **Auth gating**: `requireUser` fails closed; userId/sessionId come only from the verified durable session (requireUser.ts:43-62). CSRF: SameSite=Strict cookie + Next server-action origin check + per-mutation step-up (three layers).
- **Change password**: step-up first (rate-limited, actions.ts:53), NIST/HIBP acceptability gate (:56-60), Argon2id hash, revokes every OTHER session + deny-lists their access tokens for immediate eviction (:73-74), dual-sinked audit `password.reset.complete` (:77-95). Correct enterprise semantics (keep the proving device signed in).
- **TOTP enroll**: step-up to start (:110); the fresh secret rides ONLY in the HttpOnly Strict cookie (:117-123) and is persisted (encrypted) only after the first code verifies (:140-150); recovery codes generated with the first factor, stored hashed, shown exactly once (:153-166); `mfa.enroll` audited when a tenant resolves (:172-183).
- **TOTP disable**: step-up (:196); (methodId, userId)-scoped delete — foreign id is a no-op (:201); orphaned recovery codes cleared when the last factor goes (:206-211).
- **Recovery-code regeneration**: step-up (:224); full replace; shown once via the enroll screen (:228-241).
- **Session list + revoke one / all-others**: ownership-checked in SQL, current session marked and never offered, deny-list on revoke for immediate eviction (:254-259, :265-269).
- **Passwordless step-up fallback**: SSO/passkey-only users WITH a verified TOTP factor can step up with a code (stepUp.ts:62-70); the UI switches the field label/autocomplete accordingly (MfaSection.tsx:51-57).
- **One-time display discipline**: `lw_acct_enroll` HttpOnly/Secure/Strict/5-min, deleted on finish; malformed cookie → null (enrollCookie.ts:18-29).
- **Cross-domain reachability is sound for the real domains**: app.truepoint.in → auth.truepoint.in is same-SITE (registrable domain truepoint.in), so the SameSite=Strict refresh cookie rides the top-level navigation; a logged-in app user landing on the (correct) auth-origin URL renders authenticated. There is no redirect loop in `requireUser`. The failure is the URL itself (F1), not cookies.

## Findings

### F1 — CRITICAL / BROKEN — NEW:AUTH-061 — every product entry point to /account/security is a 404 (missing `/auth` basePath). This IS the user's report.
- **Evidence**: `SecurityPanel.tsx:21-23` builds `${AUTH_ORIGIN}/account/security#…`, but the auth app mounts everything under `basePath: "/auth"` (`apps/auth/next.config.mjs:8`) — the page actually serves at `…/auth/account/security`. Every OTHER apps/web→auth URL carries the prefix: `apps/web/src/lib/authClient.ts:68,82,106,141,156,181,193` (`/auth/login`, `/auth/token/exchange`, `/auth/token/refresh`, `/auth/logout`, `/auth/workspace/switch`, `/auth/orgs`, `/auth/org/switch`) and `apps/web/src/app/auth/extension/page.tsx:101` (`/auth/extension/mint`). Only `authLink()` omits it.
- **Deploy shapes**: multi-domain — `https://auth.truepoint.in/account/security` is outside the Next basePath → 404. Single-domain — `AUTH_ORIGIN=""` (publicConfig.ts:9) → `/account/security`, which matches neither an apps/web route nor the `/auth/:path*` rewrite (`apps/web/next.config.mjs:22`) → 404.
- **Root cause**: `authLink()` predates the basePath (page.tsx:2-3 still says "the apps/web SecurityPanel deep-links here"); nothing redirects the un-prefixed path.
- **Impact**: all four entry points ("Change password", "Manage two-step methods", "Manage sessions", "View login history") dead-end. The panel is deliberately read-only ("it NEVER fakes a mutation", SecurityPanel.tsx:3), so there is **no working path in the product to any security self-service action** — exactly "users cannot manage security settings". The surface itself works if the URL is hand-typed with `/auth/`.
- **Fix**: one line — `` `${AUTH_ORIGIN}/auth/account/security${section ? `#${section}` : ""}` `` — plus a URL-shape test over every apps/web→auth link, and optionally an apps/auth redirect for the un-prefixed path.

### F2 — HIGH / BROKEN — NEW:AUTH-062 — passwordless users without an existing TOTP factor can never enroll MFA (step-up catch-22)
- **Evidence**: `startTotpEnroll` requires `verifyStepUp` (actions.ts:110); for a user with no `passwordHash`, step-up only accepts a code from an already-enrolled verified TOTP factor (stepUp.ts:53-74 — "A user with neither a password nor a verified TOTP factor cannot step up (returns false)").
- **UI makes it worse**: MfaSection still renders "Begin setup" whenever `!hasTotp` (MfaSection.tsx:119-141), asking a passwordless, factor-less user for an "Authenticator code" they cannot possess; every submit fails with the reauth error (:14-15).
- **Impact**: every magic-link-only and SSO-JIT user is permanently locked out of self-service MFA enrollment. Adjacent to AUTH-019 (recovery edges) but a distinct enrollment-trust gap.

### F3 — HIGH / BROKEN — NEW:AUTH-064 — the in-product panel hard-codes every MFA method as "Not set up"
- **Evidence**: `SecurityPanel.tsx:26-32` (`enrolled: false` for all five catalogue rows) rendered as real StatusBadges (:83-95); the header comment (:7-11) acknowledges the cross-origin MFA-status read doesn't exist yet.
- **Impact**: a TOTP-enrolled user is told inside the product that two-step is "Not set up" — actively wrong security state; combined with F1 they cannot even reach the true state.

### F4 — HIGH / MISSING — NEW:AUTH-063 — no security-notification emails at all
- **Evidence**: `apps/auth/src/lib/emails/` contains only `magicLink.ts`, `passwordReset.ts`, `verificationCode.ts` (+ layout/index/test); `changePassword` (actions.ts:43-98) imports no mailer; nothing sends password-changed, MFA-enrolled/disabled, new-sign-in, or session-revoked notices. (AUTH-040 covers deliverability monitoring of such mail, not their existence.)
- **Impact**: an account-takeover victim gets zero signal on credential/factor changes — below the Auth0/Okta-class baseline and ASVS V6/V8 expectations.

### F5 — MEDIUM / MISSING — AUTH-025 (confirmed, status unchanged) — no WebAuthn/passkeys, SMS or email factors — yet the UI advertises them
- **Evidence**: WebAuthn exists only as a comment (`packages/auth/src/mfa.ts:2` — "SMS/email OTP and WebAuthn enrollment land with the account-security UI"; no ceremony code, no @simplewebauthn/navigator.credentials anywhere in packages/auth). The app panel lists "Passkey / security key", "SMS code", "Email code" as catalogue rows (SecurityPanel.tsx:27-31); MfaSection carries their labels (MfaSection.tsx:27-32); PasswordSection copy says "single sign-on or a passkey" (PasswordSection.tsx:107-110).
- **Register**: AUTH-024/AUTH-025 already carry this (passkeys High, sequenced P3 behind this very surface — which now exists, so the P3 dependency is UNBLOCKED; see register reconciliation).

### F6 — MEDIUM / MISSING + STALE-DOC — AUTH-049 (refined) — trusted devices are schema-only; no 30-day skip, no management UI, but promised in product copy
- **Evidence**: `trusted_devices` table exists (`packages/db/src/schema/auth.ts:235-236`; RLS mention `packages/db/src/rls/auth.sql:77`) but has **zero runtime usage** — no repository method, no reference anywhere in `apps/auth/src` (grep: no matches) or elsewhere in `packages/db/src/*.ts` beyond the schema. SecurityPanel copy promises "revoke trusted devices" (SecurityPanel.tsx:114-121).
- **Stale-doc note**: the audit-orchestration inventory claim "trusted_devices 30-day skip" PRESENT is wrong — there is no skip logic. AUTH-049 (register) correctly sequences the backend at P3; status stands, but any doc claiming it built must be corrected.

### F7 — MEDIUM / MISSING — AUTH-017 (confirmed Absent with fresh evidence) — no user/tenant API keys, PATs, or OAuth-app grants; the web UI ships against nonexistent endpoints
- **Evidence**: `apps/web/src/features/settings-developer/api.ts:35-37` targets `/api/v1/tenants/me/api-keys`, `/tenants/me/oauth-apps`, `/webhooks`; grep of `apps/api/src` for `api-keys|oauth-apps` returns nothing. Panels are correctly empty-first ("connects once the API ships (M11)", OAuthAppsPanel.tsx:54-58). No per-user connected-apps/grant revocation exists anywhere.

### F8 — MEDIUM / MISSING — AUTH-018 (confirmed) — no self-serve email-change (or phone/recovery-method) flow
- **Evidence**: `apps/auth/src/app/account/security/*` has no email-change; nothing in settings-user either. Register row AUTH-018 status unchanged (Planned/P1b).

### F9 — MEDIUM / STALE-DOC — the entire "Authentication plan" tree still baselines /account/security as ABSENT — it is now BUILT
- **Evidence**: `11-gap-register.md:194-196` (Part-3 XL row: "Absent today"), `00-README.md:78`, `01-enterprise-benchmark.md:8`, `03-current-state-flows-frontend.md:112,154`, `04-settings-inventory.md:8,89`, `05-planned-not-built.md:115-116`, `06-gap-analysis.md:122,190`, `07-recommended-settings.md:29` all say the route does not exist. It does (`apps/auth/src/app/account/security/*`, P1-02). Docs 05/07 even record the OLD `authLink()` shape as correct-but-dead — the register never caught that when the route shipped under `/auth` basePath the link became wrong for a new reason (F1).
- **Impact**: the register's #5 Critical ("self-service Absent") must be re-baselined to "Built, unreachable (AUTH-061)"; downstream P1a/P3 items gated on this surface (forced enrollment done, passkeys pending) are unblocked.

### F10 — LOW / PARTIAL — NEW:AUTH-065 — audit coverage gaps: `mfa.disable` never audited; self-revokes by tenant-less sessions unaudited
- **Evidence**: actions.ts:212-213 (no declared `mfa.disable` action — "stays PENDING"); actions.ts:291 (`auditSessionRevoke` returns early when `!acct.tenantId`).
- **Impact**: factor removal — a classic takeover step — leaves no trail; ASVS V16/SOC 2 gap. Fix = declare the enum members and emit.

### F11 — LOW / BROKEN (UX dead-end) — requireUser loses the destination: expired session → login → app shell, never back to /account/security
- **Evidence**: requireUser.ts:45,49,53 → `redirect("/login")` with no `next` param; login completion targets the app origin. Fold into the F1 fix (auth-origin-local allowlisted `next`). Map: NONE (UX; track under AUTH-061 remediation).

### F12 — LOW / PARTIAL — login history is own-session-derived only: last 20, no failed attempts, no auth events, no geo
- **Evidence**: data.ts:98 (`sessions.slice(0, 20)`); HistorySection.tsx:4-7 declares the auth-EVENT history (login.success, mfa.challenge, failures) an explicit follow-up. SecurityPanel copy oversells ("time, device, location, and the origin domain", SecurityPanel.tsx:139). Map: NONE (new small row or fold into AUTH-063 notification/visibility work).

### F13 — LOW / PARTIAL — TOTP enrollment has no scannable QR image (manual key + otpauth URI only)
- **Evidence**: enroll/page.tsx:8-11 (acknowledged; CSP-safe `data:` QR suggested). Map: NONE (polish).

## Register reconciliation

| AUTH id | Was | Now (this audit) |
|---|---|---|
| **Part-3 XL row "The /account/security build"** (no id) | Absent | **Implemented** (P1-02) — route shell, password change, TOTP + recovery, sessions, history all live (`apps/auth/src/app/account/security/*`); but see AUTH-061. Docs 00/01/03/04/05/06/07 need re-baselining (F9). |
| AUTH-017 | Absent (New-section) | **Confirmed Absent** — apps/api has no api-keys/oauth-apps routes; web UI is empty-first against them (F7). |
| AUTH-018 | Planned P1b | **Confirmed unbuilt** — no email-change flow on the new surface (F8). |
| AUTH-019 | Under-specified | **Sharpened** by NEW:AUTH-062 — the passwordless step-up catch-22 is a concrete instance (F2). |
| AUTH-024 / AUTH-025 | Passkeys High, P3 "after the P1b wizard" | **Dependency now satisfied** — the wizard exists; passkeys/SMS/email remain absent (F5). Status word for the register: still Absent/Stub, but unblocked. |
| AUTH-040 | Deliverability unmonitored | Distinct from NEW:AUTH-063 (the notification mails don't exist at all) — keep both. |
| AUTH-042 | Concurrent-session cap absent | Not re-tested in this lane (adjacent auditor); nothing on the self-service surface caps or surfaces a cap. No status change proposed. |
| AUTH-049 | Trusted-device cross-wave note | **Confirmed schema-only** (F6); correct any inventory claiming a built "30-day skip". |

**Proposed new rows (continuing from AUTH-060):**

- **AUTH-061 (Critical / broken)** — apps/web→auth deep links to `/account/security` omit the `/auth` basePath; the entire self-service surface is unreachable from the product (SecurityPanel.tsx:21-23 vs apps/auth/next.config.mjs:8).
- **AUTH-062 (High / broken)** — step-up catch-22: passwordless (magic-link/SSO-JIT) users with no verified TOTP cannot pass `verifyStepUp`, so they can never enroll MFA or change any security setting; the UI still offers the form (stepUp.ts:53-74; MfaSection.tsx:119-141).
- **AUTH-063 (High / missing)** — no security-notification emails (password-changed / MFA-changed / new-sign-in / session-revoked); only 3 transactional templates exist (apps/auth/src/lib/emails/).
- **AUTH-064 (High / broken-state)** — SecurityPanel hard-codes all MFA methods `enrolled: false`; needs the security-reviewed cross-origin enrolled-methods read (SecurityPanel.tsx:7-11,26-32).
- **AUTH-065 (Low / partial)** — audit enum lacks `mfa.disable` (and a platform-scope `session.revoked`); factor removal and tenant-less self-revokes leave no trail (actions.ts:212-213,291).

## Gaps vs enterprise expectations (Auth0/Okta-class checklist)

| Capability | Verdict | Evidence |
|---|---|---|
| Change password | **WORKS** on the auth origin; **unreachable** from the product (AUTH-061) | actions.ts:43-98 |
| TOTP enroll / disable / recovery codes | **WORKS** (same reachability caveat; passwordless users blocked, AUTH-062) | actions.ts:106-242 |
| Passkeys / WebAuthn | **MISSING** (advertised in UI) — AUTH-024/025 | packages/auth/src/mfa.ts:2; SecurityPanel.tsx:28 |
| SMS / email OTP factors | **MISSING** — AUTH-025 | enum-only (user_mfa_methods.type) |
| Trusted devices | **MISSING** (schema-only; promised in copy) — AUTH-049 | schema/auth.ts:235; no runtime usage |
| Active-session list + revoke (single + all-others) | **WORKS** (auth origin) | actions.ts:249-271 |
| Connected apps / OAuth grants (per-user revoke) | **MISSING** — AUTH-017 | apps/api: no routes; OAuthAppsPanel empty-first |
| API tokens / PATs | **MISSING** — AUTH-017 | settings-developer/api.ts:35-37 vs apps/api (absent) |
| Recovery methods (email/phone change) | **MISSING** — AUTH-018 | no flow in apps/auth account surface |
| Security notification emails | **MISSING** — NEW:AUTH-063 | lib/emails/ (3 templates) |
| Login history | **PARTIAL** — own sessions only, last 20, no failures/geo | data.ts:98; HistorySection.tsx:4-7 |
| Concurrent-session cap (user-visible) | **MISSING** — AUTH-042 | nothing on the surface |
| Privacy settings / data export / account deletion (self-service) | **MISSING** (user scope; tenant DSAR elsewhere — AUTH-014 lane) | settings-user has Profile/Security/Notifications only |

## Recommended fix direction (brief)

1. **AUTH-061 first — it is the report.** One-line `authLink()` fix (`/auth/account/security`), a URL-shape test covering every apps/web→auth link, and a permanent redirect in apps/auth from the un-prefixed path. Ship independently of everything else.
2. **AUTH-062**: add a second step-up proof for passwordless users (fresh magic-link/email-OTP confirmation or a short recent-login freshness window); hide "Begin setup" when no step-up credential exists, with explanatory copy. WebAuthn later gives the clean fix.
3. **AUTH-064**: build the security-reviewed authenticated enrolled-methods read (auth→app), or drop the fake badges until it lands.
4. **AUTH-063**: add passwordChanged/newSignIn/mfaChanged templates and fire best-effort from changePassword, finalizeLogin (new device), and the MFA actions.
5. **F11**: `requireUser` → `/login?next=<auth-origin-local path>` (allowlist same-origin paths only), honored at login completion.
6. **AUTH-065**: declare `mfa.disable` + platform-scope `session.revoked` and emit.
7. Re-baseline the Authentication plan docs (F9): mark P1-02 done, unblock the passkey P3 row, and roadmap the MISSING checklist rows (WebAuthn first — it also resolves AUTH-062; then notifications, grants/PATs, email-change, export/deletion).
