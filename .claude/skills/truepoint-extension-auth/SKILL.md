---
name: truepoint-extension-auth
description: >
  Governs authentication, tokens, and API communication for TruePoint's browser
  extension — the companion-window login and `externally_connectable` handoff, the
  extension-scoped access and rotating refresh tokens and their lifecycle, the
  service-worker API client (Bearer, idempotency, RFC-9457, 401-retry,
  tenancy-from-claims), the handoff threat model, and the
  `EXTENSION_ORIGINS`/`CHROME_EXTENSION_ENABLED` enablement gates. Use this skill
  whenever editing anything under `apps/extension/src/background/{auth,api}`, the
  auth handoff on `apps/web`/`apps/auth`, the extension token endpoints, or when
  adding an authenticated call from the extension. Siblings: the MV3 shell is
  `truepoint-extension-architecture`; content-script work is
  `truepoint-extension-linkedin`. Governing decision: ADR-0045 + doc 14's as-built
  notes. Token-flow safety is `truepoint-security`'s final say; the API contract
  and tenancy are `truepoint-platform`'s. Active for any extension auth, token, SW
  API client, or enablement-gate work.
---

# TruePoint Extension — Auth & API Skill

This skill governs how the extension **proves who the user is and talks to the API**. The whole path is built
and shipped **dark** (M2); the governing decision is **ADR-0045** (companion-window login + handoff +
extension-scoped rotating refresh token), which supersedes ADR-0044's `launchWebAuthFlow` design. Read
ADR-0045 together with `docs/planning/chrome-extension/14-implementation-audit.md`'s drift log, because the
as-built code refines two of the ADR's details (refresh token in `storage.session`, not encrypted
`storage.local`; a silent background tab vs a visible window for interactive login — X16).

The reason this design exists at all: cookies are unusable cross-origin (the `lw_refresh` cookie is
`HttpOnly; SameSite=Strict`, host-only on `auth.truepoint.in`), so from LinkedIn the extension has no cookie
to ride — it must hold its own bearer credential. Everything below follows from that.

---

## Which Skill, When

- **truepoint-extension-auth** (this skill) — the companion handoff, the extension token lifecycle, the SW
  API client, the handoff threat model, the enablement gates.
- **truepoint-extension-architecture** — where the tokens are stored (the storage tiers), the message bus,
  the alarm that drives refresh.
- **truepoint-platform** — the API contract (`/api/v1`, RFC-9457, idempotency, cursor pagination), JWKS
  verification, and the RLS tenancy the token drives. This skill consumes that; it does not redefine it.
- **truepoint-security** — **final say** on anything that could leak a token, widen the handoff surface, or
  weaken revocation.

---

## The five rules

1. **The service worker is the only holder of credentials.** The access JWT is memory-only in the SW; the
   rotating refresh token is in `chrome.storage.session`. **No token is ever sent to a content script, a page,
   or `storage.local`/IndexedDB.** See `references/token-lifecycle.md`.

2. **Interactive login is a companion handoff, verified.** The extension opens `app.truepoint.in/auth/extension`,
   the handoff page mints an **extension-scoped** token, and posts it back via `externally_connectable`; the SW
   accepts it **only** after checking `sender.origin === "https://app.truepoint.in"` **and** the nonce it
   generated. See `references/companion-handoff.md`.

3. **The extension gets its own credential, never the web app's.** Mint returns `aud = chrome-extension://<id>`,
   `scope: ["extension"]`, and deliberately **drops the `pa` super-admin bit** — a separate, independently
   revocable `sid` family. Never move the web access token or the HttpOnly refresh cookie into the extension.

4. **Every API call goes through the SW client** with `Authorization: Bearer`, an `Idempotency-Key` on writes,
   RFC-9457 error parsing, and one silent-refresh-and-retry on 401. Tenancy comes from the **verified token
   claims**, never a request body. See `references/api-client.md`.

5. **Nothing works until the gates are set.** `EXTENSION_ORIGINS` (the published id) gates both API CORS and
   token-audience verification; `CHROME_EXTENSION_ENABLED` gates the `/ingest` connector. Both are unset in
   prod (dark). See `references/enablement.md`.

---

## Reference Files

Read only the one that matches your task.

| Task | Read |
|---|---|
| Login, the companion window/tab, the handoff + its verification | `references/companion-handoff.md` |
| Access/refresh token storage, rotation, alarm refresh | `references/token-lifecycle.md` |
| Making an authenticated API call from the SW | `references/api-client.md` |
| Handoff/token threat model, what could leak | `references/threats.md` |
| Turning the extension on (`EXTENSION_ORIGINS`, `CHROME_EXTENSION_ENABLED`) | `references/enablement.md` |

> Companion skills: `truepoint-extension-architecture` (storage tiers, alarms), `truepoint-platform` (the
> API/JWKS/tenancy contract), `truepoint-security` (final say on token safety). Status truth:
> `docs/planning/chrome-extension/14-implementation-audit.md`.
