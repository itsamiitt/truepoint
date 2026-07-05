# ADR-0044 — Chrome extension authentication: silent re-auth against the dedicated IdP, no client refresh token

- **Status:** Accepted
- **Date:** 2026-07-05
- **Related:** ADR-0016 (dedicated auth origin + cross-domain token exchange), ADR-0018 (auth policy / MFA),
  ADR-0019 (global identity + tenant membership / org-switch as token re-issue), ADR-0040 (auth source-of-truth
  + session hardening), ADR-0043 (Chrome extension architecture).
- **Detail:** `docs/planning/chrome-extension/10-extension-authentication.md` (+ `11-extension-branding.md`).

## Context

The extension must authenticate against `auth.truepoint.in` and call `api.truepoint.in`, staying consistent
with `app.truepoint.in`. TruePoint auth is a **dedicated IdP / BFF** (ADR-0016): a 15-min EdDSA JWT access
token held **in memory** on the client, refreshed silently against an **HttpOnly · Secure · `SameSite=Strict`
refresh cookie** (`lw_refresh`) scoped to `truepoint.in`. The web app works because `app.` and `auth.` are
**same-site**, so the cookie rides app→auth fetches. A `chrome-extension://<id>` origin is **not** same-site:

1. The `SameSite=Strict` refresh cookie **never rides** the extension's cross-origin fetches → cookie-based
   `/token/refresh`, `/workspace/switch`, `/org/switch`, `/orgs`, `/logout` all fail.
2. The token routes' **exact-match `APP_ORIGINS` CORS allowlist** rejects the extension origin (**403**), and
   the token `aud` (= requesting origin) would fail the API's audience check.
3. The access-token claims (`sub/tid/wid/sid/scope/pa/…`) carry **no email/account and no roles**.

The currently-scaffolded `apps/extension/src/background/auth/module.ts` assumes a stock OAuth server, cookie
refresh, and an `account` claim — so it **cannot authenticate against the real server**. We need a locked
decision on the cross-origin auth model before writing the real AuthModule.

## Decision

1. **Silent re-authentication is the primary model.** The extension logs in once via
   `chrome.identity.launchWebAuthFlow` (PKCE S256), and obtains fresh 15-min access tokens by **re-running that
   loop non-interactively** (`interactive:false`). The `lw_refresh` cookie stays first-party on the auth origin
   (it rides the launchWebAuthFlow top-level navigation, not a cross-origin `fetch`), so **no refresh token ever
   lands in the extension** — preserving ADR-0016's "no long-lived credential in JS".

2. **The access token is held in memory only; nothing long-lived is stored on disk.** The "logged-in" marker
   and the PKCE verifier/`state` live in `chrome.storage.session` (RAM, cleared on browser close). Pre-refresh
   is scheduled with **`chrome.alarms`** (not `setTimeout`, which dies with the MV3 worker).

3. **Authorization is server-enforced and tenancy is pinned from verified claims.** The extension sends the
   Bearer JWT; the API pins `tenantId`/`workspaceId` from claims and derives roles per-request from
   `workspace_members`. The extension never sends tenant/workspace ids as trusted input and never verifies the
   JWT itself (it treats claims as UX hints).

4. **Workspace/org switching re-mints the token via the auth origin.** Expressed as a silent re-auth carrying
   the desired `workspace_id`/`tenant_id` (Model A), or via `/auth/workspace/switch` · `/auth/org/switch` ·
   `/auth/orgs` (Model B). The extension is multi-workspace/multi-org aware without trusting client scope.

5. **Revocation-aware by construction.** The server deny-lists the `sid`; the extension's next call 401s and
   silent re-auth fails, dropping it to signed-out. Password reset / suspension / SCIM-deprovision all revoke
   sessions server-side and flow through the same path. A future `/events/stream` `session.revoked` event can
   force immediate sign-out.

6. **SSO and MFA are transparent to the extension.** Enterprise SSO (SAML/OIDC) and MFA (TOTP, later
   SMS/email/WebAuthn) render inside the `launchWebAuthFlow` window on the auth origin; the extension only
   exchanges the resulting code. No extension change is needed to support them.

7. **Required backend changes (coordinated, additive):** (a) register the extension/redirect origin in
   `APP_ORIGINS` + CORS + accepted audience, **pinned to the published extension id** (never a wildcard);
   (b) a **silent-authorize (`prompt=none`)** path on the auth origin; (c) an **account-display source**
   (`GET /auth/me`) since the JWT carries none. These gate the extension auth and are scoped in doc 10 §7.

8. **The SW-held rotating refresh token is the vetted fallback (Model B):** an "extension client" variant of
   `/auth/token/exchange` + `/auth/token/refresh` returns/accepts the rotating refresh token in the body; the
   SW stores it AES-GCM-encrypted in `chrome.storage.local`. Adopt only if the silent path proves impractical;
   it relaxes ADR-0016's no-refresh-token-in-JS posture (mitigated by SW isolation, encryption, server-side
   rotation + reuse-detection, short access TTL, and sid revocation).

## Consequences

- **Positive:** preserves the platform's deliberate security posture (no client refresh token, XSS/theft-safe);
  reuses the exact exchange contract and JWKS/claims; SSO/MFA/WebAuthn require zero extension code; least
  privilege (only `identity` added; no `cookies`/`webRequest`); revocation-aware.
- **Costs / trade-offs:** requires coordinated backend work (the extension cannot auth with zero server change);
  each silent refresh spins a hidden auth-origin navigation (heavier than a JSON fetch, but ~15-min cadence);
  silent re-auth succeeds only while the 30-day session cookie is alive.
- **Net-new work:** the §7 backend changes (origin registration, silent-authorize, `/auth/me`) and the doc 10
  §8 reconciliation of the scaffolded AuthModule (correct endpoints/fields, extract `sid`, alarm pre-refresh,
  401-retry-after-reauth, workspace/org switch, drop the fake `account` claim).

## Alternatives considered

- **Reuse the web app's cookie refresh directly.** Rejected: the `SameSite=Strict` cookie cannot ride a
  cross-origin extension fetch; loosening it to `SameSite=None` would weaken the web app's CSRF posture.
- **Companion-tab bridge** (extension asks an open `app.truepoint.in` tab, via `externally_connectable`, to
  mint/refresh). Rejected as primary: fragile (requires an app tab open); kept as a possible optimization.
- **SW-held refresh token as primary** (Model B). Rejected as primary in favor of Model A's stronger posture;
  retained as the documented fallback (Decision 8).
- **Stock OAuth2 `/authorize`+`/token` for the extension.** N/A — TruePoint's IdP is a custom BFF with an
  identifier-first entry, not an OAuth authorization server.
