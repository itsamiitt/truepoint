# ADR-0045 — Extension authentication: companion-window login + externally_connectable handoff (supersedes ADR-0044's Model A)

- **Status:** Accepted — **supersedes the launchWebAuthFlow "Model A" decision of ADR-0044**
- **Date:** 2026-07-05
- **Related:** ADR-0044 (extension auth — superseded here), ADR-0016 (dedicated auth origin + cross-domain
  token exchange), ADR-0019 (global identity + org/workspace as token re-issue), ADR-0040 (session hardening
  + rotation/reuse-detection), ADR-0043 (Chrome extension architecture — reserves `externally_connectable`
  for `app.truepoint.in`).
- **Detail:** `docs/planning/chrome-extension/12-extension-auth-gap-analysis-and-remediation.md`.

## Context

ADR-0044 chose `chrome.identity.launchWebAuthFlow` ("silent re-auth", Model A) as the extension's primary
auth. Implementation + testing proved it **cannot work** against the real IdP, with `file:line` evidence:

- `launchWebAuthFlow` only completes when the browser navigates to `https://<id>.chromiumapp.org/*`. The
  auth server **always** redirects the code to `${app_origin}/auth/callback` and **never reads `redirect_uri`**
  (`apps/auth/src/lib/finishLogin.ts:26-28`, `login/page.tsx:28-31`). For the extension `app_origin =
  chrome-extension://<id>`, so the code goes to `chrome-extension://<id>/auth/callback` — the window never
  captures it, never closes, and gets 302'd onto `app.truepoint.in` (the "stuck tab" the user reported).
- No `prompt=none` path exists, so every silent re-auth also fails; and `EXTENSION_ORIGINS` is unset by
  default, so every request from the extension origin is 403'd.
- Even if patched, `launchWebAuthFlow` fights TruePoint's **multi-step, MFA/SSO/WebAuthn** login: those steps
  use `window.open` and real top-level contexts the single auth webview can't host (they spill into a tab).
- No enterprise incumbent uses `launchWebAuthFlow` for a login like this — Apollo/ZoomInfo/Grammarly use a
  companion web session; HubSpot/Salesforce/Gong use an OAuth window.

## Decision

1. **Interactive login is a companion window.** The extension opens the **real web login** in a popup window
   — `chrome.windows.create({ type: "popup", url: "https://app.truepoint.in/auth/extension?state=<nonce>&ext_id=<id>" })`.
   The full normal flow (identifier → password → MFA → **WebAuthn/passkey** → SSO → workspace) runs
   first-party in the user's profile, so it all works and reuses any existing `truepoint.in` session. This
   opens a real window (the product requirement) and needs no surgery on the core login redirect.

2. **Token handoff via `externally_connectable` + `onMessageExternal`, verified.** After login, the
   `/auth/extension` page mints an extension-scoped credential and `chrome.runtime.sendMessage`s it to the
   extension. The extension accepts it **only** after verifying `sender.origin === "https://app.truepoint.in"`
   **and** the `state` nonce it generated. `externally_connectable` is narrowed to `https://app.truepoint.in/*`
   (never a wildcard).

3. **Extension-scoped, rotating refresh token held by the service worker.** The mint returns a short-lived
   `aud=extension` access token + a **rotating** refresh token — **never** the web app's access token and
   **never** the HttpOnly `SameSite=Strict` refresh cookie (which can't cross origins anyway). Access token
   in `chrome.storage.session`; refresh token in `chrome.storage.local`, **AES-GCM encrypted**, reusing the
   shipped rotation + reuse-detection (`packages/auth/src/session.ts`) and independently revocable via its own
   `sid` family on the deny-list. This relaxes ADR-0016's "no refresh token in JS" **for the extension only**,
   mitigated by SW isolation, encryption, rotation, short access TTL, and immediate `sid` revocation.

4. **Silent refresh via the SW + `chrome.alarms`.** The SW refreshes with the rotating token on a
   ~13-minute alarm; the `ApiClient` 401-retry-after-refresh (already built) covers reactive refresh.

5. **`launchWebAuthFlow(prompt=none)` is a SECONDARY fallback only** — pursued only if a `prompt=none` +
   `chromiumapp.org`-redirect server path is later added. It is not the primary interactive login.

6. **Required backend surface (NET-NEW, security-reviewed, CI-itest-gated):** the extension token-mint +
   rotating-refresh endpoint (`aud=extension`); the `/auth/extension` handoff page; registering the published
   extension id in `EXTENSION_ORIGINS` + the manifest `externally_connectable`; optionally `GET /api/v1/me`
   (or fold identity into the handoff).

## Consequences

- **Positive:** works with the full multi-step MFA/SSO/WebAuthn login and reuses the existing session (often
  instant); opens a real window; no changes to the security-critical core login redirect; the extension holds
  a separate, independently-revocable credential; least privilege (`externally_connectable` narrowed, `identity`
  optional).
- **Costs / trade-offs:** a new backend surface (handoff page + mint endpoint); `externally_connectable`
  widens the attack surface (mitigated by origin + nonce verification); a rotating refresh token at rest
  (mitigated per Decision 3). Relaxes ADR-0016's client-refresh-token posture for the extension.
- **Supersedes:** ADR-0044 Decision 1/2 (launchWebAuthFlow silent re-auth as primary). The extension work in
  doc `12` §8 replaces `pkceFlow.runAuthFlow`/`silentAuth` as the primary path.

## Alternatives considered

- **Fix launchWebAuthFlow** (make the server honor `redirect_uri`→`chromiumapp.org` + add `prompt=none` +
  set `EXTENSION_ORIGINS`). Rejected as primary: requires bending the shared, security-critical core login
  redirect, still fights MFA/SSO/WebAuthn, and `prompt=none` silent auth is brittle. Retained only as the
  secondary silent-refresh fallback (Decision 5).
- **Offscreen hidden-iframe same-site-cookie refresh.** Rejected: the iframe is a third-party/embedded context
  under `chrome-extension://`, so `SameSite=Strict` cookies aren't sent and 3P-cookie phase-out breaks it.
- **Ride the site cookie** (LinkedIn-style). N/A: only works when the extension is same-site with the auth
  cookie; a `chrome-extension://` origin never is.
