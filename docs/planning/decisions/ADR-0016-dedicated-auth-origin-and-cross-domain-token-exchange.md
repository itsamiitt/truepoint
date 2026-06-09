# ADR-0016 — Dedicated auth origin + cross-domain token exchange

- **Status:** Accepted
- **Date:** 2026-06-08
- **Context doc:** [17-authentication.md](../17-authentication.md), [09-api-design.md](../09-api-design.md), [01-tech-stack.md](../01-tech-stack.md)

## Context

[ADR-0010](./ADR-0010-aws-native-self-hosted-stack.md) chose self-built auth on Lucia and specified the
transport as a **Lucia session cookie on a single app domain** ([09 §4](../09-api-design.md#4-auth--authorization)).
The product now requires authentication to live on a **dedicated origin, `auth.truepoint.in`**, fully
separate from the app (`app.truepoint.in`), with all login/signup/MFA/SSO/magic-link/OAuth flows served
there. After authentication the app domain must obtain tokens **without** the auth origin's long-lived
session ever being exposed to it. A single shared session cookie can't span two origins safely, and putting
long-lived credentials on the app domain widens the blast radius. We need a transport decision that keeps
the durable session on the auth origin while giving the app short-lived, in-memory access — at 1M DAU.

## Decision

Make **`auth.truepoint.in` an internal identity provider (IdP / BFF)**. The **Lucia** session remains the
durable, refresh-backed session, held **only on the auth origin**. Cross-domain handoff uses a **single-use
PKCE-style authorization code**:

- The code is minted in **Redis** (TTL **60 s**), **single-use**, and **bound to** the user, tenant,
  optional workspace, the target `app_origin`, the requesting **client IP**, and a PKCE `code_challenge`
  (S256). It is passed as a URL param on a redirect to `app.truepoint.in/auth/callback` — **tokens never
  appear in URLs**.
- The app exchanges the code at `auth.truepoint.in/token/exchange` (CORS, credentials); the server
  validates single-use + expiry + IP + PKCE + allow-listed origin **before** issuing tokens.
- **Access token** = signed **JWT** (asymmetric, JWKS at `auth.truepoint.in/.well-known/jwks.json`),
  **15 min**, **in memory only** on the app domain — never `localStorage`, never an app-domain cookie.
  `apps/api` validates it statelessly via JWKS, then still resolves tenant/workspace and sets RLS GUCs.
- **Refresh token** = opaque, rotating (reuse-detection), hashed in Redis + Postgres, delivered as an
  **HttpOnly · Secure · SameSite=Strict** cookie scoped to `auth.truepoint.in`. **Silent refresh** is a
  background `fetch` to `auth.truepoint.in/token/refresh` (not an iframe — `X-Frame-Options: DENY`).
- **CORS** on the auth origin allow-lists known app origins only (`app_origins`); no wildcard. Auth pages
  set HSTS, `X-Frame-Options: DENY`, `nosniff`, nonce-based CSP, `Referrer-Policy: no-referrer`.

This **amends the auth-transport portion of [ADR-0010](./ADR-0010-aws-native-self-hosted-stack.md)** (it
does not supersede the AWS-stack ADR or the choice of Lucia underneath). Full design:
[17](../17-authentication.md); schema [03 §4](../03-database-design.md#4-tenancy--auth).

## Rationale

`auth.truepoint.in` and `app.truepoint.in` are **same-site** (registrable domain `truepoint.in`) but
**cross-origin**: same-site lets a `SameSite=Strict` refresh cookie ride app-initiated fetches to the auth
host, while cross-origin keeps the app from reading the cookie and forces an explicit, allow-listed CORS
exchange. Keeping the refresh token on the auth origin and only short-lived in-memory access tokens on the
app domain minimizes blast radius (XSS on the app can't exfiltrate a durable credential). Signed JWTs let
`apps/api` validate statelessly via JWKS at scale; the ephemeral code lives in Redis (not a partitioned
table) so issuance/validation scale horizontally. Lucia, arctic, `@oslojs/otp`, `@node-saml/node-saml`,
`@node-rs/argon2`, and `rate-limiter-flexible` are unchanged underneath ([ADR-0010](./ADR-0010-aws-native-self-hosted-stack.md)).

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Dedicated auth origin + PKCE code → in-memory JWT + refresh cookie (this ADR) | Chosen | Durable session stays on auth origin; app holds only a 15-min in-memory token; scales statelessly via JWKS. |
| Keep the single-domain Lucia session cookie ([ADR-0010](./ADR-0010-aws-native-self-hosted-stack.md) as-was) | Rejected | Can't span two origins; fails the dedicated-auth-origin requirement. |
| Shared parent-domain cookie (`Domain=.truepoint.in`) for the session | Rejected | Exposes the durable session to every subdomain incl. the app; larger blast radius; weaker isolation. |
| Tokens (access+refresh) returned in the redirect URL | Rejected | Tokens in URLs leak via history/logs/referer; violates token-hygiene rules. |
| Hidden-iframe silent refresh | Rejected | Incompatible with the required `X-Frame-Options: DENY`; background `fetch` achieves the same. |

## Consequences

- **Positive:** clean auth service boundary; minimal app-domain credential exposure; stateless API
  validation; horizontally scalable code issuance; SSO/OAuth/magic-link callbacks consolidated on one origin.
- **Negative:** more moving parts (JWKS + key rotation, code store, CORS allow-list, two deployables
  `apps/auth` + `apps/web`); cross-origin CORS to debug; JWT revocation is not instantaneous.
- **Mitigation:** publish current+next keys in JWKS for seamless rotation; a short-TTL Redis `sid` denylist
  gives near-immediate revocation within the 15-min access window; refresh rotation with reuse-detection
  revokes a stolen family; every token/code event is audited ([17 §9](../17-authentication.md#9-audit--events)).

## Revisit if

Per-request immediate revocation becomes a hard requirement (move to opaque access tokens + introspection),
or operating a separate auth origin outweighs the isolation benefit at the current team size.
