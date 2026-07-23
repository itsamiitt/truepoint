# Auth — Client-Side Patterns

TruePoint uses a centralised auth service at `auth.truepoint.in` (the dedicated
`apps/auth` IdP, package `@leadwolf/auth-app`). **`@leadwolf/auth` is a backend
package** — self-built auth primitives (password hashing, session issuance/rotation,
token mint/verify, JWKS, MFA, SSO) consumed by `apps/auth` and `apps/api` only.
Neither frontend app depends on it. Instead, **each frontend app owns a small local
auth client**: `apps/web/src/lib/authClient.ts` and `apps/admin/src/lib/authClient.ts`
(with `pkce.ts` beside them). This file covers that client-side pattern.

The *enterprise identity model* — SSO/SAML/OIDC, SCIM provisioning, org-defined
roles — lives in **truepoint-security** (enterprise-iam), and the *security
discipline* (why tokens never go in `localStorage`, the threat model) lives in
**truepoint-security** (access-control, frontend-security). This file is the
client-side "how"; that skill is the model and the "why".

---

## How Auth Works (frontend view, ADR-0016)

```
Browser → startLogin() → PKCE redirect to auth.truepoint.in → login UI (MFA/WebAuthn)
        → redirect back to /auth/callback?code=… → completeLogin(code, state)
        → access token held IN MEMORY (module state) + `lw_refresh` HttpOnly cookie
          (Secure, SameSite=Strict, scoped to the auth origin)
        → silentRefresh() re-mints the access token by riding that cookie
```

- The **access token lives in memory only** (`getAccessToken()`); it is never
  persisted. On a cold load, one `silentRefresh()` (credentialed fetch to the auth
  origin) re-mints it from the refresh cookie.
- The **refresh token never touches app-domain JS** — it is the `HttpOnly` cookie on
  `auth.truepoint.in`. Only the transient PKCE verifier/state sit in `sessionStorage`.
- There is **no Next.js auth middleware** in `apps/web`/`apps/admin`. The only
  `middleware.ts` is `apps/auth/src/middleware.ts`, and it sets security headers
  (CSP/HSTS), not sessions.

## The Gate (rendering, not security)

The authed shell gates client-side: `AppShell` (`apps/web`) calls
`getAccessToken() || await silentRefresh()`, and falls back to `startLogin()` when
no session can be established; `apps/admin` does the same via its `authClient` +
`adminGate.ts`. This is a **rendering/redirect gate — the security boundary is the
backend API**, which independently authenticates, authorizes, and tenant-scopes
every request (see **truepoint-platform** api-contract, **truepoint-security**
access-control). An attacker doesn't use the gate — they call the API directly, and
the API must say no.

## Calling the API

All authenticated calls go through the app's **`fetchWithAuth`** — it attaches
`Authorization: Bearer` from the in-memory token and runs `silentRefresh()` first
when the token is missing/expired. Never hand-roll a `fetch` with a copied token,
and never read or store the token outside `authClient.ts`.

## Session in Components

Read identity/role for **rendering** via the app's session hooks —
`useSessionIdentity()` / `useSessionRole()` (`apps/web/src/lib/`) — which decode the
in-memory token's claims read-only. Claims drive what to *show*; the server
re-checks what is *allowed* on every request. Never inline a raw role string for a
gate (see **truepoint-security** enterprise-iam).

## Org / Workspace Switching

`switchOrg(tenantId)` and `switchWorkspace(workspaceId)` in `authClient.ts` re-mint
the token with the new `tid`/`wid` via the auth origin — claims are never mutated
client-side, and the server validates the requested tenant/workspace against real
memberships.

## What NOT to Do

- Never store a token in `localStorage`/`sessionStorage` (see
  **truepoint-security** frontend-security; PKCE verifier/state are the only
  sanctioned `sessionStorage` items, and they are not tokens).
- Never add auth logic to a new surface by hand — reuse the app's `authClient.ts`;
  if both apps need a change, change both clients deliberately (they are
  intentionally small and parallel).
- Never import `@leadwolf/auth` into `apps/web`/`apps/admin` — it is server-side
  (session issuance, password hashing); pulling it into a client bundle is a defect.
- Never implement refresh anywhere except `authClient.ts` (`silentRefresh` +
  `fetchWithAuth`'s pre-request check).
- Never treat the client gate or a hidden button as a security boundary — the
  backend is the boundary.
