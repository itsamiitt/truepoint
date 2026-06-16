# 17 — Authentication & Identity

> The authentication system runs on a **dedicated origin, `auth.truepoint.in`**, as LeadWolf's internal
> **identity provider (IdP / BFF)**. It owns login, signup, MFA, SSO, magic links, OAuth callbacks, and
> account-security settings; the customer app (`app.truepoint.in`) holds no credentials. Login is
> **progressive (identifier-first)**; after authentication the app domain receives a short-lived,
> single-use **code** and exchanges it for tokens. Built on the existing self-built auth libraries
> ([ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md)) — **Lucia / arctic / @oslojs/otp /
> @node-saml/node-saml / @node-rs/argon2 / rate-limiter-flexible** — extended for cross-domain tokens
> ([ADR-0016](./decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md)), progressive
> login + **email/username, existence-reveal & registration**
> ([ADR-0017](./decisions/ADR-0017-progressive-identifier-first-login-and-domain-tenant-routing.md),
> [ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md)), **global
> identity** ([ADR-0019](./decisions/ADR-0019-global-identity-and-tenant-membership.md)), and per-scope auth
> policy ([ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)).
> Tables in [03 §4](./03-database-design.md#4-tenancy--auth); API surface in
> [09 §4](./09-api-design.md#4-auth--authorization); settings in [12](./12-settings.md).

## 1. Service boundary & domains

Authentication is an **isolated origin**, not a route group inside the app. It is a separate deployable
(`apps/auth`, Next.js 15 on ECS) that renders every auth screen and exposes the token endpoints; it talks
to `packages/auth`/`packages/core`/`packages/db` and holds **no application business logic**.

| Origin | Role | Holds |
|---|---|---|
| **`auth.truepoint.in`** | Identity provider / BFF | Durable Lucia session; refresh cookie; MFA/SSO/passkey state; account-security settings; token endpoints; JWKS |
| **`app.truepoint.in`** | Application | In-memory access token only; workspace/tenant admin settings; the `/auth/callback` code receiver |

- `auth.truepoint.in` and `app.truepoint.in` are **same-site** (registrable domain `truepoint.in`) but
  **cross-origin**. Same-site is *why* a `SameSite=Strict` refresh cookie set on the auth host is still
  sent on app-initiated fetches to the auth host; cross-origin is *why* CORS is still required.
- **CORS** on `auth.truepoint.in` explicitly allow-lists known app origins (`app_origins`) — **no
  wildcard**; `Access-Control-Allow-Credentials: true`.
- **SSO callbacks** (SAML ACS, OIDC `redirect_uri`), **magic-link / email-OTP** (`/verify`), and **social
  OAuth** callbacks all resolve on `auth.truepoint.in` — never on the app domain.
- **Security headers on every `auth.*` response** (set in `apps/auth` middleware): HSTS,
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, a nonce-based **CSP with no inline scripts**,
  `Referrer-Policy: no-referrer`. Because framing is denied, silent refresh uses a background `fetch`,
  **not** a hidden iframe (§5).
- **Staff auth is separate.** The platform console (`apps/admin`, [13](./13-platform-admin.md),
  [ADR-0011](./decisions/ADR-0011-platform-admin-and-privileged-access.md)) has its own staff identity,
  SSO + mandatory MFA, and is **not** served from `auth.truepoint.in`.

## 2. Progressive (identifier-first) login

Entry is always **`auth.truepoint.in/login`**. The identifier accepts an **email *or* username** (an
optional global-unique alias — [ADR-0019](./decisions/ADR-0019-global-identity-and-tenant-membership.md)).
The step **resolves whether the identity exists** and branches: an existing identity routes to the right
Step-2, an unknown one starts **registration** (`/signup`). Revealing existence is a deliberate trade for the
registration UX, **mitigated** by an invisible **Turnstile** + per-IP/per-identifier rate-limiting +
progressive lockout ([ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md),
[§6](#6-security-layers)). The **credential** step stays uniform — it never reveals *why* it failed. **MFA**
runs right after primary auth; **org** then **workspace** selection follow ([§4](#4-multi-tenancy-auth-model)).

```mermaid
flowchart TD
  L[/login — email or username + Turnstile/] --> EX{identity exists?}
  EX -->|no| SU[/signup → verify → placement/]
  EX -->|yes| RT{auth method}
  RT -->|domain SSO enforced| SSO[/sso handoff/]
  RT -->|password set| PW[/password + passkey/]
  RT -->|passwordless| ML[/magic link/]
  L -->|Continue with Google| OA[/oauth/callback/]
  SSO --> CB[/sso/{oidc,saml}/callback + JIT/]
  PW --> PA{primary auth ok?}
  ML --> V[/verify/] --> PA
  OA --> PA
  CB --> PA
  SU --> PA
  PA -->|yes| MFA{MFA required?}
  MFA -->|yes| CH[/mfa challenge/]
  MFA -->|no| ORG
  CH -->|ok / trust device 30d| ORG{member of >1 org?}
  ORG -->|yes| OS[/org selector/]
  ORG -->|no| WS{>1 workspace?}
  OS --> WS
  WS -->|yes| SEL[/workspace selector/]
  WS -->|no| ISS[issue 60s code]
  SEL --> ISS
  ISS --> APP[app.truepoint.in/auth/callback → exchange]
  PA -.invalid x N.-> LOCK[progressive lockout]
```

**Paths from the identifier step:**
- **Exists → 2A · Password** — email/username shown as a locked chip with back-nav; show/hide;
  forgot-password link; passkey prompt if a `webauthn_credentials` row exists.
- **Exists → 2B · SSO handoff** — "Your organization uses SSO"; redirect to the IdP with `RelayState`/`state`;
  misconfiguration falls back to a support path, never a blank error.
- **Exists → 2C · Magic link** (`/magic` → `/verify`) — confirmation that mail was sent; resend with a
  cooldown; `/verify` validates the `auth_email_tokens` token (`expired`/`already-used` states).
- **Social OAuth** — "Continue with Google/Microsoft" via `arctic`; resolves on `/oauth/callback`.
- **Not registered → Registration** (`/signup`): (1) **email** (prefilled) → verify via `auth_email_tokens`
  (OTP/link) on `/verify`; (2) **profile** — name, optional username (unique), password *or* passkey;
  (3) **org placement** ([§4](#4-multi-tenancy-auth-model)) — verified company domain → join; pending invite →
  accept; else create a **new org**.

After primary auth, **MFA** (identity-level) runs first, then **org selection** (if the identity belongs to
more than one org), then **workspace selection** (if the chosen org has more than one) — single options
auto-select. Every failed credential attempt routes to the generic error and increments the lockout counters
([§6](#6-security-layers)).

## 3. Cross-domain token contract

After all required factors pass on `auth.*`, the user is handed to the app domain via a **single-use
authorization code** (PKCE-style), never via tokens in the URL.

```mermaid
sequenceDiagram
  participant B as Browser
  participant Auth as auth.truepoint.in
  participant App as app.truepoint.in
  B->>Auth: complete login (+MFA/SSO)
  Auth->>Auth: mint code (Redis 60s; bind user, tenant, workspace?, app_origin, client_ip, S256 challenge)
  Auth-->>B: 302 app.truepoint.in/auth/callback?code&state (refresh cookie set on auth.*)
  B->>App: GET /auth/callback?code&state
  App->>Auth: POST /token/exchange {code, code_verifier, state} (CORS, credentials)
  Auth->>Auth: validate single-use · not expired · client_ip match · PKCE · origin allow-listed
  Auth-->>App: 200 {access_token (JWT, 15m)}   (refresh stays the auth.* cookie)
  App-->>B: access token held in memory only
```

**Code rules** ([ADR-0016](./decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md)):
the code is **single-use**, **expires in 60 s**, **bound to the requesting client IP** and to the PKCE
`code_challenge` + target `app_origin`, and is **validated server-side before any token is issued**. It is
held in **Redis** (TTL), not a Postgres table, so it scales horizontally with 1M DAU.

- **Exchange** returns the access token in the JSON body; the app **never receives the refresh token**.
- A **confidential server-side variant** (the app backend exchanges with a registered client secret) is
  supported for non-SPA flows; the browser-BFF variant above is the default.
- **CSRF / fixation:** the `state` nonce + PKCE verifier + IP-bound, single-use, 60 s code together gate
  the exchange; the refresh cookie is `SameSite=Strict`.
- **Callback resilience & failure semantics** — the `/auth/callback` effect is guarded against React
  **StrictMode** double-invoke so the single-use code is consumed **once**; a recoverable `state`/code
  failure (`invalid_state`/`pkce_mismatch`/`code_not_found`) **auto-restarts login once** (`lw_auth_recovery`
  sessionStorage flag) instead of dead-ending, while a **`503 auth_unavailable`** is shown, not looped. The
  password step likewise separates an `InvalidCredentialsError` (uniform credential error, [§6](#6-security-layers))
  from an infra outage ("temporarily unavailable") and no longer `500`s on a dependency blip. Failure modes,
  the recovery contract, and the **monitoring/alerting** signals are detailed in the
  [ADR-0016 callback-recovery addendum](./decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md#addendum-2026-06-16--callback-auto-recovery--honest-password-failure-semantics).

## 4. Multi-tenancy auth model

- **Global identity, many orgs** ([ADR-0019](./decisions/ADR-0019-global-identity-and-tenant-membership.md)):
  a person is **one** identity (`users` — global-unique email + optional username + credentials/MFA) that
  belongs to **many** tenants via **`tenant_members`** (carrying `is_tenant_owner` + `status`); each tenant
  has many workspaces. The identifier lookup is a single global query, before any tenant context.
- **Tenant resolution from email domain.** **`tenant_domains`** (claimed + DNS-TXT verified) maps a verified
  domain → `tenant_id` + that tenant's SSO config, and carries a **`join_policy`** (`sso_only` / `auto_join` /
  `request_access`) governing how a new matching email is placed at registration. The identifier step uses it
  to choose the Step-2 path (SSO when enforced). Unclaimed/personal domains fall through to password / social / magic.
- **Org placement at registration** (the hybrid model, [ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md)):
  verified domain `auto_join` → create a `tenant_member` (default role); `request_access` → pending; else a
  **pending `invitations`** row for the email → accept (its tenant/workspace/role); else → **`provisionNewSignup`**
  (tenant + default workspace + owner `tenant_member` + owner `workspace_member` + audit, one tx).
- **Post-auth selection:** **org selector** if the identity has >1 active `tenant_member`; then **workspace
  selector** if the chosen tenant has >1 accessible workspace (single options auto-select). The chosen
  `tenant_id` + `workspace_id` bind into the session + the cross-domain code; "switch org/workspace" re-issues a token.
- **Per-tenant SSO** via **`tenant_sso_configs`** (SAML 2.0 + OIDC; metadata, attribute mapping, JIT, default
  role, `enforced`) — see [§8](#8-sso--scim-architecture).
- **Two-axis RBAC** (drift hazard **H8**): per-workspace `workspace_members.role ∈ owner|admin|member|viewer`,
  and the **tenant-level** capability **`tenant_members.org_role`**
  (`owner|billing_admin|security_admin|compliance_admin|member` — membership moved off `users` by
  ADR-0019; granular roles by [ADR-0030](./decisions/ADR-0030-granular-tenant-org-roles.md)) — orthogonal
  ([09 §4](./09-api-design.md#4-auth--authorization)).
- **Auth-policy overrides** (`tenant_auth_policies` / `workspace_auth_policies`,
  [ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)): enforce MFA, restrict allowed
  methods, disable social login, require SSO, IP allowlist (CIDR), session timeout — **strictest** of the
  applicable tenant + workspace scopes.

## 5. Session, token & device architecture

| Concern | Design |
|---|---|
| Durable session | **Lucia** on `auth.*` (`user_sessions`, Postgres + Redis), refresh-backed |
| Access token | Signed **JWT** (asymmetric EdDSA/RS256; JWKS at `auth.truepoint.in/.well-known/jwks.json`), **15 min**, **memory only** on the app domain — never `localStorage`, never an app-domain cookie |
| Refresh token | **Opaque, rotating** with reuse-detection; hashed in Redis + Postgres; delivered as an **HttpOnly · Secure · SameSite=Strict** cookie scoped to `auth.truepoint.in` |
| Cross-domain code | Redis, **60 s, single-use, IP-bound, PKCE-bound, origin-bound** (§3) |
| Per-device tracking | `user_sessions.device_id` + **`trusted_devices`** (fingerprint hash, last IP/geo, "trust this device 30 days") |
| Concurrent sessions + revocation | Per-policy cap; revoke by `sid` via a short-TTL Redis denylist (immediate) + refresh-family revoke (durable); **admin-reversible** (zero-trust) |
| Silent refresh | Background `fetch` (credentials) to `auth.*/token/refresh` ~1 min before expiry; **not** an iframe (XFO=DENY) — returns a new access JWT, rotates the refresh cookie |
| Stateless API | `apps/api` validates the JWT via JWKS, then re-resolves tenant/workspace and `SET LOCAL` the RLS GUCs ([03 §9](./03-database-design.md#9-row-level-security), [09 §1](./09-api-design.md#1-conventions)) |

**Token hygiene:** tokens never appear in URLs (only the single-use code), logs, or error messages.
Signing keys live in Secrets Manager (KMS) and **rotate**; JWKS publishes current + next public keys so
rotation never invalidates live tokens.

## 6. Security layers

- **Brute-force / progressive lockout** — `rate-limiter-flexible` with **per-IP and per-identifier** counters
  in Redis; exponential backoff → captcha escalation → temporary lock. Every auth endpoint is rate-limited
  ([09 §1](./09-api-design.md#1-conventions)).
- **Identifier existence is revealed, but throttled** ([ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md)) —
  the identifier step branches login vs **registration**, so it *does* reveal whether an identity exists. This
  is gated by an invisible **Turnstile** + per-IP/per-identifier rate-limiting + lockout (enumeration is
  slow/throttled, not impossible). The **credential** step (password/SSO/magic) stays uniform — it never
  reveals *why* it failed.
- **Bot detection at the identifier step** — invisible challenge (Turnstile/hCaptcha), velocity checks,
  **disposable-domain blocking** (reuses the existing `signupGuards`, [05 §1](./05-features-modules.md#1-auth--tenancy--mvp-m2)),
  honeypot field.
- **Suspicious-login detection** — device fingerprint + IP geo → **new-device / new-geo / impossible-travel**
  risk score → step-up MFA or email re-verification; a new-device email alert is sent.
- **CSRF for the cross-domain exchange** — PKCE + `state` nonce + IP-bound single-use 60 s code, validated
  server-side; `SameSite=Strict` refresh cookie; origin allow-list (no wildcard) (§3).
- **Immutable audit** — every auth event is written to `audit_log` ([§9](#9-audit--events)).

## 7. MFA strategy

- **Methods:** **TOTP** (`@oslojs/otp`), **SMS / email OTP** fallback, **WebAuthn / passkey / hardware key**
  (`webauthn_credentials`), and **recovery codes** (hashed, single-use, regenerable).
- **Storage:** multiple methods per user via **`user_mfa_methods`** (+ `user_mfa_recovery_codes`),
  generalizing the single-secret `user_mfa`.
- **Challenge UX:** 6-digit input auto-submits on completion; method toggle; "trust this device for 30
  days" writes a `trusted_devices` row; a recovery-code escape hatch is always available.
- **Enforcement levels** ([ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)):
  **user opt-in**, **workspace-required**, **tenant-mandated** — resolved as the strictest applicable.

## 8. SSO & SCIM architecture

- **SAML 2.0** SP-initiated **and** IdP-initiated (`@node-saml/node-saml`); **OIDC / OAuth 2.0**.
- **Fixed callback URLs (shown in the admin UI):** ACS `https://auth.truepoint.in/sso/saml/callback`;
  OIDC redirect `https://auth.truepoint.in/sso/oidc/callback`; plus the Entity ID.
- **JIT provisioning** on first SSO login (creates the `users` identity if new + a `tenant_member` +
  default-role `workspace_member` per `tenant_sso_configs.default_role`); **attribute mapping** for
  email/name/role/department.
- **SCIM 2.0** lifecycle (provision / update / deprovision) via **`scim_tokens`** +
  `users.scim_external_id`.
- **Per-tenant management UI** ([12 §4](./12-settings.md#4-tenant-settings-tenant-owner--billing--tier-as-noted)):
  guided SAML/OIDC wizard, metadata upload/URL, **test-connection** tool, and **domain claiming +
  verification** (`tenant_domains`).

## 9. Audit & events

Every auth event writes an immutable `audit_log` row ([03 §7](./03-database-design.md#7-activity--outreach-layer-adr-0009),
[08 §5](./08-compliance.md)) with `actor (user_id) · action · entity_type · entity_id · ip_address ·
user_agent · tenant_id · workspace_id · origin_domain · metadata{success/failure, method} · occurred_at`.
The **`origin_domain`** column (new) records both the auth origin and the originating app origin per event.

New closed `action` values (added to the audit-actions enum): `login.success`, `login.failure`,
`login.locked`, `mfa.challenge`, `mfa.success`, `mfa.failure`, `password.reset.request`,
`password.reset.complete`, `sso.initiated`, `sso.callback`, `token.issued`, `token.refresh`,
`token.revoke`, `device.trusted`, `device.revoked`, `session.revoked`, `code.issued`, `code.exchanged`,
`signup`, `oauth.link`. Existing reveal/send/suppression/DSAR/credit actions are unchanged.

## 10. Screens, components & settings surfaces

**On `auth.truepoint.in` (`apps/auth`)** — all SSR with no-JS initial render, mobile-first at 375 px,
keyboard-first, WCAG 2.1 AA, using the existing design tokens ([04](./04-ui-ux-design.md)):
`/login` (email or username + Turnstile), `/password`, `/sso`, `/magic`, `/verify`, `/mfa`, `/org`,
`/workspace`, `/forgot`, `/reset`, `/signup` (multi-step: email → verify → profile → org placement),
`/oauth/callback`, `/sso/saml/callback`, `/sso/oidc/callback`, `/token/exchange`, `/token/refresh`,
`/.well-known/jwks.json`, and **Account Security** (`/account/security`): password + strength meter, active
sessions, MFA enrollment wizard (TOTP QR / SMS / WebAuthn), recovery codes view/regenerate, trusted
devices, and **login history** (event, location, device, timestamp, `origin_domain`).

**On the app domain (`apps/web`, Settings destination — [12](./12-settings.md))**: `/auth/callback` (code
receiver + in-memory token store + silent-refresh client); **Workspace ▸ Authentication** policy (MFA
enforcement, allowed methods, session timeout, IP allowlist); **Tenant ▸ Security & access** (SSO/SCIM
wizard, ACS/Entity-ID display, attribute mapping, JIT + default role, SCIM tokens, domain claiming);
**Developer** (OAuth app creation with `auth.*` redirect URIs, personal access tokens, auth-event webhooks).

**Component reuse** ([04 §7](./04-ui-ux-design.md), `packages/ui` shadcn primitives): Button, Input, Label,
Field/Form, Checkbox, **InputOTP**, Dialog/AlertDialog (every destructive action confirmed), Card, Skeleton,
toast, Badge/Chip (locked-email chip), Separator, Avatar. New composed pieces: `AuthShell`, `BrandLockup`
(from `logo/SVG/truepoint-lockup-color.svg`), `IdentifierForm`, `PasswordForm`, `SsoHandoff`,
`MagicLinkSent`, `MfaChallenge`, `RecoveryCodeInput`, `WorkspacePicker`, `SessionList`, `DeviceList`,
`MfaEnrollWizard`, `SsoSetupWizard`, `ScimSetup`, `OAuthAppForm`. Primary buttons use `--tp-ink`; **Cobalt
is fill/logo only, never text**; focus rings are subtle grey; no shadows except modal/popover; light theme
only.

## Links
- **Links to:** [03 §4](./03-database-design.md#4-tenancy--auth), [03 §7](./03-database-design.md#7-activity--outreach-layer-adr-0009),
  [03 §9](./03-database-design.md#9-row-level-security), [04](./04-ui-ux-design.md),
  [05 §1](./05-features-modules.md#1-auth--tenancy--mvp-m2), [08 §5](./08-compliance.md),
  [09 §1](./09-api-design.md#1-conventions), [09 §4](./09-api-design.md#4-auth--authorization),
  [11](./11-information-architecture.md), [12](./12-settings.md), [13](./13-platform-admin.md),
  [19](./19-observability-reliability.md) (infra key-rotation cadence), [25](./25-departments-teams-workspaces.md)
  (department/team is **authz** — app-level — not authn; JWT `sub`/`tid`/`wid` claims unchanged),
  [ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md),
  [ADR-0016](./decisions/ADR-0016-dedicated-auth-origin-and-cross-domain-token-exchange.md),
  [ADR-0017](./decisions/ADR-0017-progressive-identifier-first-login-and-domain-tenant-routing.md),
  [ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md),
  [ADR-0019](./decisions/ADR-0019-global-identity-and-tenant-membership.md),
  [ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md).
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [05 §1](./05-features-modules.md#1-auth--tenancy--mvp-m2),
  [09 §4](./09-api-design.md#4-auth--authorization), [10 M2/M11](./10-roadmap.md), [12](./12-settings.md), README.

## Open questions
1. **Access-token format** — signed JWT (chosen, stateless via JWKS) vs opaque + introspection; revisit if
   immediate per-request revocation outweighs stateless validation (today handled by the `sid` denylist, §5).
2. **Silent-refresh transport** — background `fetch` (chosen, compatible with `X-Frame-Options: DENY`) vs a
   hidden iframe; revisit only if a browser blocks same-site credentialed fetch.
3. **Bot/CAPTCHA vendor** — **Cloudflare Turnstile** chosen at the identifier step
   ([ADR-0020](./decisions/ADR-0020-existence-revealing-identifier-first-and-registration.md)); hCaptcha
   remains a fallback if cost/UX warrants.
4. **Username normalization** — case-folding (citext) + reserved-name list + min length for the optional
   global-unique username alias ([ADR-0019](./decisions/ADR-0019-global-identity-and-tenant-membership.md)).
5. **Trusted-device fingerprinting** — signal set and privacy posture for the 30-day trust window.
6. **SCIM scope at MVP-Enterprise** — full lifecycle vs provision/deprovision only (carried from
   [12 §7](./12-settings.md#7-schema--open-items)).
