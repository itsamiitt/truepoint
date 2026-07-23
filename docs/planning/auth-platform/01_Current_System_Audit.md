# 01 — Current System Audit

> **Suite:** TruePoint Centralized Authentication Platform (`auth.truepoint.in`). This is document 1 of 12.
> **Status of this doc:** `authored` · **Grounding:** live code audit (migration `0052`), four deep per-area audits + a
> current-state inventory, reconciled against the canonical `Authentication plan/11-gap-register.md` (60 `AUTH-###` rows).
> **Evidence:** the full per-area reports live in [`_evidence/audit/`](./_evidence/audit/) — `forgot-password.md`,
> `security-settings.md`, `callbacks-oauth.md`, `token-session.md` — and the existing-plan digest in
> [`_evidence/existing-plan-digest.md`](./_evidence/existing-plan-digest.md). Every claim below carries a `file:line`
> anchor; re-open the cited file before acting on it.

## How to read this document

This is the audit the rest of the suite builds on. It does four things:

1. **Maps the current system** as it actually runs today — not as the older docs describe it.
2. **Root-causes the three reported failures** the brief calls out — forgot-password, user security settings, and
   callback/redirect management — and shows *why a real user experiences each as broken*.
3. **Brings the `AUTH-###` gap register current** against migration `0052` and appends a new `AUTH-061…AUTH-078`
   block for defects the earlier baseline never captured (several are the actual cause of the reported breakage).
4. **Names what is solid** — the well-built parts the centralized-platform redesign must preserve, not rewrite.

> **Relationship to the existing `Authentication plan/` tree.** That tree (11 docs, dated 2026-06-26) remains the
> canonical prior art and the source of the `AUTH-###` IDs. This suite **extends** it: we reuse its IDs (confirming or
> updating status with fresh evidence) and mint new findings from `AUTH-061` upward — we never renumber. Where this
> audit contradicts an older doc, the contradiction is called out as a **stale-doc** correction, not a silent overwrite.

---

## Executive summary

**The core auth engine is enterprise-shaped and, in the parts that were finished, genuinely well-built.** TruePoint runs
a real dedicated IdP (`apps/auth`) that mints EdDSA tokens; a stateless verifier (`apps/api`) that checks them against
JWKS and does a per-request revocation lookup; durable server-side sessions with opaque, hash-at-rest refresh tokens,
rotation, and family-revoke reuse detection; a per-request-derived role model; and a cross-domain code-exchange flow with
PKCE, IP-binding, and single-use codes. Multi-tenant selection is authorization-checked at the token gate. This is not a
stub.

**The three reported failures are real, and they are mostly deployment/wiring defects sitting on top of that sound core —
not architectural flaws.** Two of the three share a single root cause: **constructed auth URLs omit the `/auth` basePath**,
which 404s both the emailed reset/magic links *and* the in-product links to the security-settings page. The forgot-password
flow additionally ships **MailHog (a dev mail-capture container) as the production SMTP transport**, so reset emails are
swallowed on the server and never delivered — and when SMTP is simply unset, the flow **silently reports success**. The
callback layer is the healthiest of the three (open-redirect protection, PKCE, and CSRF invariants all verified working),
but it has one real privilege hole: the browser extension's `scope:["extension"]` token is **never actually scope-enforced
by the API**.

**The enterprise gaps are known and mostly already tracked.** Real SAML/OIDC adapters throw in production (only a mock IdP
works); SCIM Users is built but Groups and instant deprovision are not; passkeys/WebAuthn, SMS/email OTP, API keys /
service accounts, custom roles, and concurrent-session caps are absent. None of these is a surprise — they are the
`AUTH-###` register's existing High/Medium rows. The new work this audit adds is the **`AUTH-061…AUTH-078` block**: the
email-delivery breakage, the basePath 404s, the extension-scope hole, the deny-list fail-open window, and the
security-notification-email gap.

**Bottom line for sequencing:** a small **P0 hotfix bundle** (basePath fix, real SMTP + queued send, extension-scope
enforcement, deny-list alerting) closes the user-visible breakage in days, on top of a core that does not need to be
rebuilt. The centralized-platform work in docs 03–12 is then additive, not a rescue.

---

## Method & scope

- **What was audited:** the IdP (`apps/auth`), the auth primitives (`packages/auth`), the API verifier + middleware
  (`apps/api`), the two web clients (`apps/web`, `apps/admin`), the MV3 extension (`apps/extension`), and the auth data
  model + RLS (`packages/db`). Deploy config (`deploy/`, `docker-compose.prod.yml`, `Caddyfile`) was audited because two
  of the three reported failures live there.
- **How:** five parallel evidence passes (a full inventory + four deep per-area audits), each reading current source and
  citing `file:line`. Findings were classified `works | broken | missing | partial | stale-doc` with enterprise-deal
  severity `critical | high | medium | low`, then reconciled against the register.
- **Status vocabulary** (inherited verbatim from the register): `Implemented | Partial | Stub | Planned | Absent`.
- **Ground truth markers:** latest migration `0052_worker_outbox`; the security skill's `enterprise-iam.md` status notes
  are **stale and understate what is built** (they predate SCIM Users and the granular role tiers) — do not re-plan
  already-shipped work from them.

---

## Part A — Current-state map (how auth works today)

**Topology (ADR-0016).** `auth.truepoint.in` (`apps/auth`, Next 15, `basePath:"/auth"`) is the IdP and the only place a
durable session or token is minted. `api.truepoint.in` (`apps/api`, Hono on Bun) is a **stateless verifier** — it validates
the access JWT against JWKS and derives tenancy from claims; it never issues tokens. `app.` and `admin.` are presentation
clients that hold only an in-memory access token.

**Login → token issuance.** A client calls `startLogin()`, which mints PKCE and redirects to `…/auth/login` carrying
`app_origin`, `code_challenge`, `state` (`apps/web/src/lib/authClient.ts:62-69`). Each per-step server action re-validates
`isAllowedOrigin(appOrigin) && codeChallenge` before persisting to the login transaction
(`apps/auth/src/app/{password,magic,sso,signup,reset}/actions.ts`). The authoritative gate is
`finalizeLogin` (`packages/auth/src/flow.ts:156-336`): it runs `authorizeTenantSelection(orgs, txn.tenantId)`
(`scopeGuard.ts`) to reject a forged/untrusted client `tenantId`, validates the workspace via
`workspaceRepository.getRoleForUser`, enforces MFA-required (fail-closed), IP-allowlist, and strictest-wins allowed-methods
(`policy.ts`), then mints the **durable session** + a **single-use cross-domain code** (`code.ts`, 32-byte, IP+PKCE+origin
bound, `GETDEL` single-use) and sets the refresh cookie. `finishLogin.ts:16-28` redirects to
`${appOrigin}/auth/callback?code&state` — **a code, never a token, in the URL**.

**Token exchange & shape.** The client's callback POSTs the code to `…/auth/token/exchange`
(`apps/auth/src/app/token/exchange/route.ts`), which CORS-gates, `exchangeCode`s (single-use), and mints an **EdDSA** access
JWT (`packages/auth/src/token.ts:47-60`) with claims `sub, tid, wid?, sid, scope[], pa?`, `iss=AUTH_ORIGIN`,
`aud=requesting app origin`, TTL 900 s. The token is returned in a JSON body and held **in memory only** — no app-domain
cookie or `localStorage`.

**API validation.** `apps/api/src/middleware/authn.ts:11-27` verifies the JWT against remote JWKS (issuer + audience pinned
to the public `AUTH_ORIGIN` even though keys are fetched over `INTERNAL_AUTH_ORIGIN`) and then does a **full deny-list
lookup on every request** (`isRevoked(claims.sid)`), so logout/rotate/switch take effect within seconds. `tenancy.ts`
derives `tenant_id`/`workspace_id` **only from verified claims, never the body**; `withTenantTx` sets the RLS GUCs so a
query that forgets its tenant filter returns nothing.

**Refresh / rotation / revocation.** The durable `user_sessions` row is the source of truth. The refresh token is opaque
(`randomBytes(32)`, returned once) and stored only as a SHA-256 hash (`session.ts:12,74`). Every refresh rotates the token
atomically and deny-lists the old `sid`; a revoked token replayed outside a 30 s grace triggers **family revocation**
(`findActiveSessionOrDetectReuse`, `session.ts:154-171`). The deny-list is Redis `revoked-sid:<sid>` with TTL = access-token
life and **fails open** on Redis error (`revocation.ts:42-48`). Role is derived per-request from `tenant_members`, so a role
change is immediate; the `pa` super-admin bit, however, lives in the token.

**Org/workspace selection & switching.** `resolveNextStep` routes to `mfa | mfa_enroll | org | workspace | complete`;
`selectOrg` (`isActiveTenantMember`) and `selectWorkspace` are membership-checked, and `switchOrg`/`switchWorkspace` rotate
the session, deny-list the old `sid`, and re-derive `pa`.

**Extension (ADR-0045).** A companion tab on `app.truepoint.in` mints an extension-audience token
(`apps/auth/src/app/extension/mint/route.ts`, `aud=chrome-extension://<id>`, `scope:["extension"]`, `pa` deliberately
omitted) and hands it to the service worker via `onMessageExternal` with `sender.origin` + state-nonce verification. The
refresh token lives in `chrome.storage.session` (memory-backed, unencrypted) — **safer than the ADR text**, which still
says `storage.local`+AES-GCM.

**Account security.** `apps/auth/src/app/account/security/*` implements password change, TOTP enroll/disable, recovery
codes, own-session list/revoke, and login history, each behind a step-up re-auth gate (`stepUp.ts`).

**Email.** Auth mail (`apps/auth/src/lib/mailer.ts`) is nodemailer over SMTP, sent **inline in the request**, with only
three templates (magic, reset, verification). This path is **separate from and weaker than** the M12 tenant-email
subsystem (`packages/core/src/email`, which has SPF/DKIM/DMARC) — see Part B.

---

## Part B — The three reported problems, root-caused

### B1. "Forgot password is broken"

**What the user experiences:** they submit the forgot form, see *"If an account exists, we've emailed a reset link,"* and no
usable email ever arrives.

**Root cause is a chain of three independent production defects, any one of which breaks the flow:**

1. **Production SMTP is MailHog (AUTH-061, Critical).** The prod template points `SMTP_URL` at a dev mail-capture container
   (`deploy/env.production.template:80` → `smtp://mailhog:1025`; `docker-compose.prod.yml:42-46`; `deploy/deploy.sh:63-64`
   starts MailHog as "prod infrastructure"). Every reset email is captured on-box (lost on restart), viewable only over an
   SSH tunnel. There is no real SMTP relay anywhere in the stack and no env key for one. **This is the primary reason the
   flow is "broken."**
2. **The emailed link omits the `/auth` basePath (AUTH-062, Critical).** Even with a working transport, the link 404s:
   `forgot/actions.ts:40` builds `${AUTH_ORIGIN}/reset?...`, but the auth app serves everything under `basePath:"/auth"`
   (`next.config.mjs:8`) and the Caddyfile proxies path-through with no rewrite. The same bug is in `magic/actions.ts:51`.
3. **Unset SMTP degrades to silent success (AUTH-063, High).** If `SMTP_URL` is unset, `mailer.ts:32-37` logs a warning and
   returns, while the action still redirects `?sent=1`. `packages/config/src/env.ts:199` marks `SMTP_URL` optional with **no
   production `superRefine`** (contrast `AUTH_COOKIE_DOMAIN`, which *is* prod-gated at `env.ts:335-351`). Any deploy drift
   makes recovery silently impossible.

**Secondary defects on the same flow:** the send is **inline and unguarded** on the account-exists branch
(`forgot/actions.ts:39-42`), so a transport failure 500s only for real accounts — an **existence + timing oracle** that also
breaks the flow (AUTH-064, High); the reset code is a **6-digit (~20-bit) URL bearer token** guarded by a fail-open lockout
and stored as unsalted SHA-256 (AUTH-071, Medium); and a reset **silently enables password login on SSO-only/passwordless
accounts** (AUTH-070, Medium).

**What already works (do not rebuild):** the core `passwordReset` library is sound — single-use hashed token, 15-minute TTL,
policy-and-breach check *before* the code is consumed, Argon2id rehash, revoke-all-sessions on completion, and dual-sinked
audit events are all verified (`packages/auth/src/passwordReset.ts`, `emailVerification.ts`).

**Fix shape:** wire a real transactional ESP with a queued (BullMQ) send + retry + bounce handling, add the `/auth` prefix
to link construction, add a production env gate on the sender config, and make delivery failure surface (not silent). Detail
in doc 05 and doc 09; roadmap in doc 12.

### B2. "Users cannot manage their security settings"

**What the user experiences:** the in-product Settings ▸ Security panel shows read-only status and four "Manage on the
sign-in site" links; clicking any of them dead-ends on a 404. There is **no working path in the product to any security
self-service action.**

**Root cause — the same basePath bug as B2, on a different surface (AUTH-062, Critical).** The `/account/security` page is
**built and works** (P1-02 shipped password change, TOTP enroll/disable, recovery codes, session list/revoke, login
history — all real, step-upped, mostly audited: `apps/auth/src/app/account/security/*`). But the only entry points — the
four deep links in `apps/web`'s `SecurityPanel.tsx:21-23` — build `${AUTH_ORIGIN}/account/security#…` **without** the `/auth`
basePath, so they 404 on every deploy shape (multi-domain: outside the Next basePath; single-domain: matches neither an
`apps/web` route nor the `/auth/:path*` rewrite). Every *other* `apps/web→auth` URL carries the prefix — only `authLink()`
was missed. **Fix is one line** plus a URL-shape test over every cross-app link.

**Compounding defects that would still bite after the 404 is fixed:**
- **Passwordless users can never enroll MFA (AUTH-069, High).** `startTotpEnroll` requires step-up, but for a user with no
  password, step-up only accepts a code from an already-enrolled TOTP factor (`stepUp.ts:53-74`) — a catch-22 that
  permanently locks every magic-link-only and SSO-JIT user out of self-service MFA, while the UI still shows "Begin setup."
- **The in-product panel shows the wrong state (AUTH-068, High).** `SecurityPanel.tsx:26-32` hard-codes every MFA method as
  `enrolled:false`; a TOTP-enrolled user is told inside the product that two-step is "Not set up."
- **No security-notification emails exist at all (AUTH-067, High).** Only three transactional templates exist
  (`apps/auth/src/lib/emails/`); nothing sends password-changed, MFA-changed, new-sign-in, or session-revoked notices — an
  account-takeover victim gets zero signal.
- **Advertised-but-absent factors:** the panel lists passkeys, SMS, and email codes (AUTH-024/025, still Absent) and
  promises "revoke trusted devices" (AUTH-049 — `trusted_devices` is **schema-only**, zero runtime usage), and the developer
  panel calls API-key/OAuth-app endpoints that **do not exist** in `apps/api` (AUTH-017).

> **Stale-doc correction (AUTH-062 family):** the entire `Authentication plan/` tree still baselines `/account/security` as
> **Absent** (register Part-3 XL row; docs 00/01/03/04/05/06/07). It is **Built, but unreachable.** Re-baseline those rows,
> and note the passkey P3 item is now *unblocked* because the wizard it depends on exists.

### B3. "Callback / redirect management"

**This is the healthiest of the three surfaces — the audit confirms the hard security invariants hold** — with one real
privilege hole and a handful of hardening gaps.

**What works (verified):** open-redirect protection is real and consistent (every client-supplied `app_origin`/`returnTo`
passes through an exact-match `isAllowedOrigin` allow-list, never a prefix, never reflected — **AUTH-036 = works**); a
**code, not a token, in the URL** (`finishLogin.ts:27`), IP+PKCE+origin-bound and single-use; **PKCE S256** with a 32-byte
CSPRNG verifier; **CSRF invariants hold** on the token endpoints (`SameSite=Strict` cookie + credentialed-CORS allow-list +
PKCE-verifier binding — **AUTH-053**); host-only cookie scope; and dual-gate extension origin validation.

**The one real hole — extension scope is decorative (AUTH-065, High).** The extension mints `scope:["extension"]`
(`extension/mint/route.ts:83-90`) — described in-code as "a scoped prospecting credential, not an admin one" — but
`apps/api/src/middleware/authn.ts:17` verifies audience against the **entire** `appOrigins()` set (which *includes* the
extension origins) and **never reads `claims.scope`**. The scope claim is not enforced anywhere. An exfiltrated
service-worker refresh token therefore has **full read/write access to every tenant-scoped `/api/v1/*` endpoint** — credit
spend, exports, everything except `/admin/*` — not the prospecting-only access ADR-0045 promises.

**Hardening gaps:** **no Single-Logout (AUTH-016)** — web logout does propagate across web apps (shared host-only cookie) but
never kills the extension's separate session family, and there is no upstream-IdP SLO; **admin `silentRefresh` lacks the
web client's in-flight de-dup (AUTH-073)**, so concurrent cold-load refreshes can trip reuse-detection into a spurious full
sign-out; the refresh cookie uses `Domain=` host scope instead of a **`__Host-` prefix (AUTH-074)**; and the two web PKCE
implementations are byte-identical copies that should be extracted to a shared package (AUTH-078).

> **Stale-doc correction:** ADR-0045 says the extension refresh token is stored in `chrome.storage.local` (AES-GCM); the code
> uses `chrome.storage.session`, unencrypted — **stronger** than documented. Fix the doc, not the code.

---

## Part C — Consolidated gap register (updates + new block)

Two changes to the canonical register. First, a set of **status refreshes** to existing rows against migration `0052`.
Second, a new **`AUTH-061…AUTH-078`** block for defects the earlier baseline never captured — several of which are the actual
cause of the reported breakage. (The four parallel audits each independently minted `AUTH-061+`; those collisions are
reconciled into the single clean sequence below.)

### C1. New findings — `AUTH-061…AUTH-078`

| ID | Sev | Status | Area | Gap (short) | Evidence |
|---|---|---|---|---|---|
| AUTH-061 | Critical | broken | email | **Prod SMTP is MailHog** — reset/magic/verification mail captured on-box, never delivered | `deploy/env.production.template:80`; `docker-compose.prod.yml:42-46`; `deploy/deploy.sh:63-64` |
| AUTH-062 | Critical | broken | callbacks/self-service | **Constructed auth URLs omit `/auth` basePath** → 404: (a) emailed reset+magic links, (b) `apps/web` `/account/security` deep links | `forgot/actions.ts:40`; `magic/actions.ts:51`; `SecurityPanel.tsx:21-23` vs `apps/auth/next.config.mjs:8` |
| AUTH-063 | High | broken | email | Unset `SMTP_URL` degrades to **silent success** (UI says "sent"); no prod env gate | `mailer.ts:32-37`; `env.ts:199` (no `superRefine`) |
| AUTH-064 | High | broken | email/enum | Inline unguarded send on account-exists branch → 500/timing **enumeration oracle** + broken flow | `forgot/actions.ts:39-42`; `passwordReset.ts:34` |
| AUTH-065 | High | broken | authz | **Extension `scope:["extension"]` never enforced** by `apps/api`; token has full tenant API access | `extension/mint/route.ts:83-90` vs `apps/api/.../authn.ts:17` |
| AUTH-066 | High | partial | sessions | Revocation deny-list **fails open** on Redis outage → ≤15-min residual access after revoke; no operator alert | `revocation.ts:42-48`; `authn.ts:22-24` |
| AUTH-067 | High | missing | email/self-service | **No security-notification emails** (password-changed / MFA-changed / new-sign-in / session-revoked) | `apps/auth/src/lib/emails/` (3 templates only) |
| AUTH-068 | High | broken | self-service | In-product SecurityPanel **hard-codes all MFA methods `enrolled:false`** → shows wrong security state | `SecurityPanel.tsx:26-32` |
| AUTH-069 | High | broken | MFA/self-service | **Passwordless users hit a step-up catch-22** — can never enroll MFA or change security settings | `stepUp.ts:53-74`; `MfaSection.tsx:119-141` |
| AUTH-070 | Medium | partial | recovery | Password reset **silently enables password login on SSO-only/passwordless accounts** (method downgrade) | `passwordReset.ts:32-51,83-84`; `login.ts:19` |
| AUTH-071 | Medium | partial | recovery | Reset code is **6-digit (~20-bit) URL bearer**; lockout fails open; unsalted SHA-256 at rest | `emailVerification.ts:23,12-13`; `rateLimit.ts:146-156` |
| AUTH-072 | Medium | partial | sessions | **`pa` super-admin claim is in-token**; demotion not session-revoked → ≤15-min cross-tenant residual | `token.ts:52`; `refresh.ts:90`; `platformAdmin.ts:14` |
| AUTH-073 | Medium | broken | callbacks | admin `silentRefresh` lacks in-flight de-dup → concurrent refreshes trip reuse-detection → **spurious full sign-out** | `apps/admin/.../authClient.ts:90-103` vs `apps/web/.../authClient.ts:102-121` |
| AUTH-074 | Low | partial | callbacks | Refresh cookie uses `Domain=` host scope instead of **`__Host-` prefix** | `cookies.ts:8-18` |
| AUTH-075 | Low | partial | audit | Audit enum lacks **`mfa.disable`** + platform-scope `session.revoked`; factor removal leaves no trail | `account/security/actions.ts:212-213,291` |
| AUTH-076 | Low | partial | sessions | **No clock-skew tolerance** on JWT verify (jose default 0 s) → boundary 401s under host drift | `token.ts:68-72` |
| AUTH-077 | Low | partial | abuse | **XFF trust hard-coded single-hop**; a fronting CDN silently makes client IP spoofable | `clientIp.ts:8-9,19` |
| AUTH-078 | Low | works | hygiene | PKCE impl **duplicated byte-for-byte** web/admin (drift risk); extract to shared package | `apps/web/src/lib/pkce.ts` ≡ `apps/admin/src/lib/pkce.ts` |

### C2. Status refreshes to existing rows (vs the 2026-06-26 baseline)

| ID | Was | Now | Why |
|---|---|---|---|
| **/account/security build** (Part-3 XL, no ID) | Absent | **Implemented, unreachable** | P1-02 shipped the full surface; blocked only by AUTH-062 (`account/security/*`). Re-baseline docs 00/01/03/04/05/06/07. |
| AUTH-036 | New-section (open-redirect) | **Implemented / works** | Exact-match allow-list on every redirect target, never reflected. |
| AUTH-053 | New-section (CSRF) | **Holds / works** | `SameSite=Strict` + credentialed-CORS + PKCE-verifier binding on token routes. |
| AUTH-056 | New-section (cookie attrs) | **Partial** | HttpOnly/Secure/SameSite/host-Domain present; missing `__Host-` prefix (→ AUTH-074). |
| AUTH-016 | Medium, unbuilt | **Confirmed Absent** | No SLO; extension session family survives web logout. |
| AUTH-013 | High (key rotation + KMS) | **Confirmed open, sharpened** | **Single-key JWKS** (`token.ts:77-80`) → no seamless rollover; at-rest key **dev-derived** (`secrets.ts:9`). Split into dual-key-publish + KMS-wiring. |
| AUTH-042 | Medium (concurrent cap) | **Confirmed Absent** | `createSession` inserts unconditionally; no policy knob (`session.ts:72-89`). |
| AUTH-040 | Deliverability unmonitored | **Sharpened** | Not merely unmonitored — the prod transport is a capture tool; no ESP/DKIM/SPF/bounce handling (→ AUTH-061/063). |
| AUTH-049 | Trusted-device cross-wave note | **Confirmed schema-only** | `trusted_devices` has zero runtime usage; correct any "30-day skip built" claim. |
| AUTH-017 | Absent | **Confirmed Absent, fresh evidence** | `apps/web` developer UI ships against `/api/v1/tenants/me/api-keys` etc. that don't exist. |
| AUTH-024 / AUTH-025 | Passkeys/OTP High, P3 | **Still Absent, now unblocked** | The `/account/security` wizard they depend on now exists. |
| AUTH-010 | SCIM deprovision race | **Confirmed** | The fail-open ≤15-min residual is real at the revocation layer (generalized as AUTH-066). |

### C3. The register at a glance (post-update)

- **Critical:** AUTH-001 (real SAML validator, still open) + **AUTH-061, AUTH-062** (new; the reported breakage).
- **High:** the existing 13 + **AUTH-063, 064, 065, 066, 067, 068, 069**.
- **Medium/Low:** existing rows + **AUTH-070…078**.
- Full per-row detail (root cause, symptom, fix direction) is in the four `_evidence/audit/*.md` reports; the sequenced
  remediation is doc 12.

---

## Part D — What is solid (preserve, do not rebuild)

The redesign is **additive on top of a sound core.** These are verified strengths the platform work must keep:

- **Stateless verifier with per-request revocation** — full deny-list lookup every request, not JWT-validity-only
  (`authn.ts:17-24`). Logout/rotate/switch take effect in seconds.
- **Opaque, hash-at-rest refresh tokens with rotation + family-revoke reuse detection** — correct OWASP-ASVS posture with a
  30 s concurrency grace (`session.ts:154-171`), atomic rotation.
- **Issuer/audience pinning survives the internal-fetch optimization** (`token.ts:69`) — the internal HTTP origin is never
  trusted as claim authority.
- **Authorization-checked tenant selection** — `authorizeTenantSelection` + membership checks close the historical
  client-supplied `tid/wid` bypass (`flow.ts`, `scopeGuard.ts`).
- **Per-request-derived roles** — org/workspace role changes are immediate (the `pa` bit is the one exception, AUTH-072).
- **RLS-enforced tenancy** — `withTenantTx` GUCs + fail-closed policies; a forgotten tenant filter returns nothing.
- **Cross-domain code flow** — code-not-token in URL, PKCE S256, IP+origin binding, single-use `GETDEL`.
- **The `/account/security` surface itself** — password change (evicts other sessions + deny-lists), TOTP enroll with
  first-verify-then-persist, hashed shown-once recovery codes, ownership-checked session revoke, layered step-up + CSRF.
- **Boot self-test** (`assertSigningKey`) turns a bad signing key into a loud, secret-free 503.
- **SCIM Users** — built, bearer-gated, tenant-scoped, deprovision revokes sessions (bounded window).

---

## Part E — Enterprise gap analysis (vs an Auth0/Okta-class platform)

Grouped; each line carries its `AUTH-###` handle. These are the inputs to docs 03–12.

- **Login methods:** social/OAuth login is a dead path (AUTH-015, decided: build in P3); passwordless is TOTP+magic-link
  only. No configurable, admin-managed login-method matrix (net-new scope, doc 06).
- **MFA / passkeys:** TOTP only; **WebAuthn/passkeys, SMS, email OTP absent** (AUTH-024/025); no adaptive/risk-based MFA;
  passwordless users can't self-enroll (AUTH-069). Push explicitly out of scope (AUTH-044).
- **Orgs / SSO / SCIM:** real SAML/OIDC adapters **throw in production** — only a mock IdP works (AUTH-001 Critical); SCIM
  **Groups + group→role mapping** and instant deprovision are unbuilt (AUTH-010/016); domain **DNS-TXT verification**
  deferred (AUTH-041); no SLO, metadata refresh, or cert rotation (AUTH-016).
- **Sessions:** no **concurrent-session cap** (AUTH-042); deny-list **fail-open** window (AUTH-066); `pa` demotion residual
  (AUTH-072); no seamless **key rotation** (AUTH-013).
- **Admin console:** no platform-admin surface to configure login methods, policies, branding, email templates, callbacks,
  or rate limits **without code** — the single largest net-new scope (doc 04).
- **User self-service:** built but unreachable (AUTH-062); no email-change (AUTH-018), passkeys, connected-apps/grants
  (AUTH-017), notifications (AUTH-067), data export/deletion at the user scope.
- **Developer / API:** no OAuth authorization server for third parties, no **API keys / PATs / service accounts /
  client-credentials** (AUTH-017), no signed outbound webhooks for auth events, no SDKs.
- **Abuse defense & observability:** Turnstile + brute-force lockout exist, but **no auth SLIs/alerts before enforcement
  flips** (AUTH-012/022), no anomaly/new-device detection, CDN-topology IP footgun (AUTH-077).

---

## Part F — Recommended P0 hotfix bundle (closes the reported breakage)

Independently shippable, in dependency order, ahead of the platform build:

1. **basePath fix (AUTH-062)** — add `/auth` to every constructed auth URL (`authLink()`, `forgot/actions.ts:40`,
   `magic/actions.ts:51`); add a URL-shape test over every `apps/web`/`apps/admin`→auth link; optionally a redirect from the
   un-prefixed path. *Fixes both "forgot password" link 404s and "can't manage security settings."*
2. **Real transactional email (AUTH-061/063/064)** — replace MailHog with a real ESP; move the send to a **queued** worker
   (BullMQ) with retry + bounce handling; add a **production env gate** so an unset/typo'd sender fails loudly, not silently;
   remove the inline send from the request path (kills the timing oracle).
3. **Extension-scope enforcement (AUTH-065)** — add middleware that reads `claims.scope` and restricts extension-audience
   tokens to an explicit prospecting route allow-list, deny-by-default.
4. **Deny-list observability (AUTH-066)** — keep fail-open, but emit a metric/alert whenever the deny-list read/write
   catches, so a silent revocation outage is visible; consider a short-TTL in-process fallback cache.
5. **Security-notification emails (AUTH-067)** — add password-changed / new-sign-in / MFA-changed templates and fire
   best-effort from the relevant actions.

These five turn the three reported failures off. Everything else in the suite (docs 03–12) is the centralized-platform
build on top.

---

## Part G — Risks, assumptions, and migration notes

- **The MailHog finding is deployment config, not a commit to revert.** The fix is to introduce a real ESP + queued send;
  do not "roll back" — there is nothing correct to roll back to.
- **Fail-open is a deliberate availability trade-off**, not a bug per se — but it must be *observable* (AUTH-066) and its
  ≤15-min bound must be stated in the enterprise "instant off-boarding" claim (docs 07/09/10).
- **Drizzle snapshot debt** (`meta/` snapshots stop at `0028`, journal runs to `0052`; `migrations/_MAIN_MERGE_TODO.md`) —
  the runtime migrator works, but `drizzle-kit generate` cannot safely diff. New auth tables (doc 11) must account for this;
  stitching the snapshots is a prerequisite for clean additive migrations.
- **The security skill's `enterprise-iam.md` status notes are stale** — plan against *this* audit and the updated register,
  not against those notes.
- **Two ID systems exist** (`G-AUTH-*` in `docs/planning/28-enterprise-readiness-audit.md`; `AUTH-###` in `Authentication
  plan/`). `AUTH-###` is canonical; a future pass should cross-map `G-AUTH-*` to it so there is one spine.

---

## Appendix — evidence index

| Area | Full report |
|---|---|
| Forgot-password / recovery (B1) | [`_evidence/audit/forgot-password.md`](./_evidence/audit/forgot-password.md) |
| User security self-service (B2) | [`_evidence/audit/security-settings.md`](./_evidence/audit/security-settings.md) |
| Callback / redirect / PKCE (B3) | [`_evidence/audit/callbacks-oauth.md`](./_evidence/audit/callbacks-oauth.md) |
| Token & session lifecycle (Part A, D) | [`_evidence/audit/token-session.md`](./_evidence/audit/token-session.md) |
| Existing-plan digest (canonical decisions + net-new scope) | [`_evidence/existing-plan-digest.md`](./_evidence/existing-plan-digest.md) |

> **Coverage note (honest scope).** Five further audit lanes (email-delivery deep-dive, DB-schema, SSO/SCIM conformance,
> observability/abuse, and the full register reconciliation) and the 20-agent enterprise-platform research sweep were
> **interrupted by an account-level block** (Consumer-Terms re-acceptance + a usage-limit reset) before completing. Their
> scope is folded into docs 02, 06, 09, and 11, which will be completed once that block clears; the findings above are the
> confirmed, evidence-backed subset and are safe to act on now.
