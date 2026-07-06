# 08 — Callback URL & OAuth Architecture

> Document 8 of 12 · TruePoint Centralized Authentication Platform. Redesigns the callback/redirect/OAuth layer across all
> clients. Grounded in the callbacks audit ([`_evidence/audit/callbacks-oauth.md`](./_evidence/audit/callbacks-oauth.md))
> and the token audit ([`_evidence/audit/token-session.md`](./_evidence/audit/token-session.md)).

## Executive summary

**The callback layer is the healthiest of the three reported problem areas.** The audit confirms the hard invariants hold:
open-redirect protection is a real exact-match allow-list (never reflected, `AUTH-036`), the URL carries a **single-use,
IP+PKCE+origin-bound code and never a token**, PKCE is S256 with a 32-byte CSPRNG verifier, CSRF is covered on the token
endpoints (`SameSite=Strict` + credentialed-CORS + PKCE-verifier binding, `AUTH-053`), and extension origins are dual-gated.
The redesign therefore **hardens** rather than rebuilds.

The one **real defect** is that the extension's `scope:["extension"]` is decorative — `apps/api` verifies audience but never
reads `scope`, so an exfiltrated extension refresh token has full tenant API access (`AUTH-065`, High). The rest are
hardening gaps: no Single-Logout for the extension family (`AUTH-016`), admin refresh lacks the web client's single-flight
de-dup (`AUTH-073`), the refresh cookie should be a `__Host-` cookie (`AUTH-074`), and the two web PKCE copies should be one
shared module (`AUTH-078`). This document specifies the target callback architecture, the per-client-type policy matrix, and
the first-party OAuth 2.1 authorization-server design that docs 06/07/10 build on.

## 1. Current implementation (verified)

- **Cross-domain code flow (ADR-0016):** `startLogin()` mints PKCE → redirect to `/auth/login` with
  `app_origin/code_challenge/state`; each step re-validates `isAllowedOrigin && codeChallenge`; `finalizeLogin` mints the
  durable session + single-use code; `finishLogin.ts:27` redirects to `{app_origin}/auth/callback?code&state`; the callback
  POSTs to `/auth/token/exchange` which returns the JWT in a JSON body.
- **Binding:** `code.ts` — 32-byte code, `GETDEL` single-use, `validateBinding` priority IP→origin→PKCE.
- **Origin allow-list:** `env.ts` `APP_ORIGINS` (+ optional `EXTENSION_ORIGINS`, strict `chrome-extension://[a-p]{32}`);
  `isAllowedOrigin` = exact `includes`. CORS echoes Origin only when allow-listed, `credentials:true`, never `*`.
- **Cookie:** `lw_refresh` — HttpOnly, Secure, SameSite=Strict, host-only `Domain`, Path=/ (`cookies.ts`).
- **Extension (ADR-0045):** companion tab mints via `/auth/extension/mint` (aud=`chrome-extension://<id>`,
  `scope:["extension"]`, `pa` omitted), handed to the SW via `onMessageExternal` with `sender.origin` + state-nonce checks;
  refresh token in `chrome.storage.session` (unencrypted, memory-backed — safer than the ADR text).

## 2. Findings this document resolves

| ID | Sev | Finding | Fix (this doc) |
|---|---|---|---|
| AUTH-062 | Critical | Emailed reset/magic links omit `/auth` basePath → 404 | §3 URL construction rule + link-shape test |
| AUTH-065 | High | Extension `scope` never enforced by API | §5 per-client policy matrix + scope-enforcement middleware |
| AUTH-016 | Medium | No Single-Logout; extension family survives web logout | §6 logout propagation + back-channel logout |
| AUTH-073 | Medium | admin `silentRefresh` lacks single-flight de-dup | §4 refresh single-flight (port web fix) |
| AUTH-074 | Low | Refresh cookie not `__Host-` | §3 cookie policy |
| AUTH-078 | Low | PKCE duplicated web/admin | §4 shared `@leadwolf/auth-client` module |

## 3. Target callback & redirect architecture

**Rule 1 — every constructed auth URL carries the `/auth` basePath.** The 404s in `AUTH-062` come from `authLink()` and the
email actions building `${AUTH_ORIGIN}/…` without `/auth`, while every other cross-app link includes it. Centralize URL
construction in one helper (`authUrl(path)` that always prepends `/auth`) used by both link-building and email templates, and
add a **link-shape test** asserting every `apps/web`/`apps/admin`→auth URL and every email template link begins with the
IdP basePath. Add a permanent redirect in `apps/auth` from the un-prefixed path as a belt-and-braces.

**Rule 2 — redirect targets are always allow-listed, never reflected.** Keep the exact-match `isAllowedOrigin` gate
(`AUTH-036` works). Move the allow-list from env-only into the **effective-config store** (doc 11) so the platform admin can
manage allowed origins/callback URLs per environment and per org *without a redeploy* — with the env list as the fallback
floor. Validation stays exact-match (scheme+host+port), never prefix, with a documented `state` round-trip.

**Rule 3 — code, not token, in the URL; token only in a POST body.** Preserve. The single-use, IP+PKCE+origin-bound code is
the correct pattern; no change.

**Rule 4 — cookies are `__Host-` prefixed.** Rename `lw_refresh` → `__Host-lw_refresh`, drop the explicit `Domain`
attribute (host-only is already the intent, enforced by the `env.ts` superRefine), keep HttpOnly/Secure/SameSite=Strict/
Path=/ (`AUTH-074`). The `__Host-` prefix makes the tight scope structurally unforgeable at the user agent.

**Rule 5 — config baked at build is a floor, not the source of truth.** `NEXT_PUBLIC_AUTH_ORIGIN`/`APP_ORIGIN` remain
build-inlined (a known deploy footgun), but the prod `superRefine` asserting `NEXT_PUBLIC_APP_ORIGIN ∈ APP_ORIGINS` stays,
and the allowed-origin **runtime** list (Rule 2) is what the exchange validates against.

## 4. Client token handling (SPA: app./admin.)

- **Single shared client module.** Extract PKCE + the auth client into `@leadwolf/auth-client` consumed by both web and
  admin (`AUTH-078`), eliminating the byte-identical drift risk and giving one place to fix entropy/algorithm.
- **Refresh single-flight everywhere.** Port the web client's in-flight-promise de-dup into admin so concurrent cold-load
  refreshes collapse into one rotation and cannot trip reuse-detection into a spurious family revoke (`AUTH-073`).
- **Client-side nav on callback.** Switch the admin callback from `window.location.replace("/")` (which discards the
  just-minted in-memory token, forcing a redundant refresh) to a router nav like web (audit F7).
- **Token stays in memory.** No `localStorage`/cookie for the access token; silent refresh via the host-only refresh cookie.

## 5. Per-client-type policy matrix (the core OAuth model)

The IdP treats each client class as an OAuth client with an explicit policy. This is what `AUTH-065` needs: **audience proves
"may present a token"; scope + client policy prove "may call this route."**

| Client class | Grant / flow | Token TTL | Refresh | Sender-constrain | Scope enforced by API |
|---|---|---|---|---|---|
| Web confidential-ish SPA (app./admin.) | code + PKCE, cross-domain code | 15 m | rotating, 30 d, host cookie | — (SameSite cookie) | full app scope |
| **Browser extension** (public) | companion-window mint | **shorter (e.g. 10 m)** | rotating, **shorter TTL**, `storage.session` | **DPoP (target)** | **prospecting allow-list only** |
| Mobile (future, AUTH-043) | system-browser PKCE (ASWebAuthenticationSession) | 15 m | rotating + app attestation | DPoP | mobile scope |
| CLI / device (future) | device authorization grant (RFC 8628) | 15 m | rotating | DPoP | device scope |
| Service account / M2M (AUTH-017) | client-credentials | short | none (re-issue) | mTLS/DPoP | service scope, per-key |

**Scope-enforcement middleware (fixes AUTH-065).** In `apps/api`, after audience verification, read `claims.scope` and match
it against a route→required-scope map, **deny by default**. Extension-audience tokens are restricted to an explicit
prospecting/ingestion route set (the seam the extension actually uses); everything else 403s. Separate the extension audience
check from the web `appOrigins()` set so the two cannot be conflated. This makes the ADR-0045 "scoped credential" real at the
enforcement point.

## 6. Logout & Single-Logout

- **Cross-web-app logout already works** — web and admin share the one host-only refresh cookie, so a web logout propagates
  to admin on its next refresh / ≤15-min token expiry.
- **Extension family (AUTH-016, fix):** on web/admin logout (and on deprovision), best-effort **fan out a revoke by
  `userId`** to the extension session family server-side, so the extension token dies with the web session.
- **Upstream IdP SLO (SSO):** for SAML/OIDC sessions, implement **back-channel logout** (the deployable option in 2026;
  front-channel is unreliable) so an enterprise IdP logout terminates the TruePoint session — tracked with the real SSO
  adapters (doc 07). Emit a `session.revoked` auth event to the outbox → CAEP for downstream relying services.

## 7. First-party OAuth 2.1 authorization server (foundation for docs 06/07/10)

To serve third-party API clients and the future developer platform, the IdP grows a **standards-compliant OAuth 2.1 / OIDC
authorization server** alongside the first-party code flow:

- **Grants:** authorization-code + PKCE (all interactive clients, incl. confidential), client-credentials (M2M,
  `AUTH-017`), device-authorization (RFC 8628, CLIs), token-exchange (RFC 8693, for impersonation/delegation — the staff
  impersonation path). Refresh rotation everywhere; ROPC never.
- **Discovery:** OIDC discovery document + JWKS; consider PAR (RFC 9126) and JAR for high-assurance clients; resource
  indicators (RFC 8707) so a token is minted for a specific API audience.
- **Consent:** a consent screen + grant store for third-party apps (per-user connected-apps, revocable — closes the
  `AUTH-017` "connected applications" self-service gap in doc 05).
- **Sender-constraining:** DPoP (RFC 9449) for public clients (extension/mobile/CLI) — the highest-leverage upgrade against
  token exfiltration, and the structural complement to enforcing `scope`.
- **Client registry:** OAuth clients (first-party + third-party) as data (doc 11 `oauth_clients`), each with grant types,
  redirect URIs, scopes, token TTLs, and sender-constraining policy — the per-client matrix in §5 becomes rows, admin-managed
  in doc 04.

## 8. Security considerations

- Redirect/callback validation is exact-match allow-list, never prefix or reflection (`AUTH-036`); `state` is single-use and
  bound to the initiator.
- SSRF-guard every outbound fetch to customer-controlled URLs (SSO metadata, JWKS, webhooks) — `AUTH-009`.
- `__Host-` cookies + SameSite=Strict + credentialed-CORS allow-list are the CSRF baseline for IdP endpoints (`AUTH-053/074`).
- Extension: keep the dual gate (server `isAllowedOrigin(extOrigin)` + client `sender.origin`/state), add scope enforcement
  (`AUTH-065`), shorten token/refresh TTLs, and evaluate DPoP.
- The access token never touches JS-readable storage; refresh cookie is HttpOnly host-only.

## 9. API specification (representative)

```
POST /auth/token/exchange     { code, code_verifier }              → { access_token, expires_in }
POST /auth/token/refresh      (cookie)                             → { access_token, expires_in }  (rotates refresh)
POST /auth/logout             (cookie)                             → 204   (revoke + deny-list + extension fan-out)
POST /auth/org/switch         (cookie) { org_id }                  → rotates session, re-scopes
GET  /auth/.well-known/jwks.json                                   → { keys:[current, next?] }   (dual-key, doc 03/10)
GET  /auth/.well-known/openid-configuration                        → discovery (new)
POST /auth/oauth/authorize    (OAuth 2.1 code+PKCE)                → 302 with code             (new, §7)
POST /auth/oauth/token        (code|client_credentials|device|token-exchange)                  (new, §7)
POST /auth/oauth/par          (pushed authorization request, optional)                          (new)
GET  /auth/oauth/consent | POST /auth/oauth/consent                                             (new, §7)
```

All under the `/auth` basePath (the AUTH-062 rule). Error envelope: RFC 9457 on the first-party API; standard OAuth error
responses on the `/oauth/*` endpoints.

## 10. Testing strategy

- **Link-shape test** over every cross-app + email-template URL (must start with `/auth`) — regression guard for AUTH-062.
- **Open-redirect negative suite:** every redirect target rejects non-allow-listed origins, prefixes, and reflections.
- **PKCE/binding:** code is single-use (`GETDEL`), rejects wrong verifier/IP/origin, expires at 60 s.
- **Scope enforcement:** extension-audience token is accepted on prospecting routes, 403 on everything else; web token
  unaffected.
- **Refresh single-flight:** concurrent cold-load refreshes produce exactly one rotation, no family revoke.
- **Logout propagation:** web logout kills the extension family; SSO back-channel logout terminates the session.
- **Cookie:** `__Host-` attributes asserted; no `Domain`; Secure+HttpOnly+SameSite=Strict.

## 11. Migration strategy

1. Ship the **AUTH-062 URL fix** + link-shape test first (independent, unblocks two reported failures).
2. Add **scope-enforcement middleware** (AUTH-065) behind a default-on flag with the extension route allow-list; observe 403s
   in staging before enforcing.
3. Rename the cookie to `__Host-lw_refresh` with a dual-read window (accept both names for one refresh cycle) to avoid
   signing everyone out on deploy.
4. Extract `@leadwolf/auth-client`; port single-flight to admin.
5. Stand up the OAuth 2.1 server behind the client registry (doc 11) as the foundation for docs 06/07/10.

## 12. Risks & future enhancements

- **Cookie rename** can sign users out if not dual-read during rollout — mitigate with the transition window above.
- **Scope enforcement** can break the extension if the allow-list is wrong — stage in observe mode first.
- **Future:** DPoP-bound public-client tokens; back-channel logout across all SSO connections; CAEP transmitter for
  cross-service revocation; per-client dynamic registration (RFC 7591) for the developer platform.
