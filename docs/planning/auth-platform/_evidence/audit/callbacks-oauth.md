# Audit — Callback / Redirect / PKCE architecture (all four clients)

Area owner: callback/redirect/PKCE across apps/web, apps/admin, apps/extension, apps/auth.
Method: read the actual code end to end; every claim is file:line-grounded and re-verified against current source.

---

## Current implementation (file:line map)

### The cross-domain code flow (ADR-0016)
- **Login start (web)** `apps/web/src/lib/authClient.ts:62-69` — `startLogin()` mints PKCE (`pkce.ts`), stashes verifier+state in `sessionStorage`, redirects to `${AUTH_ORIGIN}/auth/login?app_origin&code_challenge&state`.
- **Login start (admin)** `apps/admin/src/lib/authClient.ts:57-64` — identical, distinct storage keys (`lw_admin_*`).
- **Auth-origin entry** `apps/auth/src/app/login/page.tsx:28-56` carries `app_origin/code_challenge/state` as hidden fields; per-step server actions (`password/actions.ts:30-41`, `magic/actions.ts:21-49`, `sso/actions.ts:20-51`, `signup/actions.ts:47-67`, `reset/actions.ts:61-67`) all re-validate `isAllowedOrigin(appOrigin) && codeChallenge` before persisting into the login transaction.
- **Finalize + redirect** `packages/auth/src/flow.ts:156-336` mints the durable session and single-use code (`issueCode`), then `apps/auth/src/lib/finishLogin.ts:16-28` sets the refresh cookie and `redirect(\`${result.appOrigin}/auth/callback?code=&state=\`)`.
- **Code mint/consume** `packages/auth/src/code.ts` — `issueCode` (32-byte base64url, `EX AUTH_CODE_TTL_SECONDS`), `exchangeCode` GETDEL single-use, `validateBinding` priority IP→origin→PKCE (`code.ts:42-50`).
- **Callback (web)** `apps/web/src/app/auth/callback/page.tsx:41-91` — `ran` StrictMode guard, `completeLogin(code,state)`, client-nav to `/prospect`, extension-return branch (`tp_ext_return`).
- **Callback (admin)** `apps/admin/src/app/callback/page.tsx:25-61` — same shape, `window.location.replace("/")`.
- **Exchange** `apps/auth/src/app/token/exchange/route.ts:32-118` — CORS gate → `exchangeCode` → `mintAccessToken(aud=origin)`; token never in URL.
- **Refresh** `apps/auth/src/app/token/refresh/route.ts:23-51` (cookie-based, rotates); `refresh.ts` reuse-detection + policy caps.
- **Logout** `apps/auth/src/app/logout/route.ts:25-48` — idempotent, always clears cookie, best-effort revoke.
- **Switch** `apps/auth/src/app/{org,workspace}/switch/route.ts` — cookie-based, CORS-gated, membership-checked.

### Origin allow-list / config
- `packages/config/src/env.ts:32-42,496-503` — `APP_ORIGINS` (min 1 url) + optional `EXTENSION_ORIGINS` (strict `chrome-extension://[a-p]{32}`) folded into `appOrigins()`; `isAllowedOrigin` = exact `includes`.
- CORS `apps/auth/src/lib/cors.ts:10-20` echoes Origin only when allow-listed, `credentials:true`, never `*`.
- Cookie `apps/auth/src/lib/cookies.ts:8-22` — `HttpOnly; Secure; SameSite=Strict; Path=/; Domain=AUTH_COOKIE_DOMAIN`. superRefine `env.ts:335-351` forces `AUTH_COOKIE_DOMAIN == AUTH_ORIGIN` host (host-only scope).

### Extension (ADR-0045)
- Handoff page `apps/web/src/app/auth/extension/page.tsx` — mints via `/auth/extension/mint`, `chrome.runtime.sendMessage(extId,…)`.
- Mint route `apps/auth/src/app/extension/mint/route.ts:36-115` — CORS gate, `EXT_ID_RE`, `isAllowedOrigin(chrome-extension://id)`, resolves user from `lw_refresh` cookie, new session family, `mintAccessToken(aud=extOrigin, scope:["extension"])`, **pa deliberately omitted**.
- Refresh route `apps/auth/src/app/extension/refresh/route.ts:14-67` — body-based refresh token, optional org/workspace re-scope.
- SW side: `background/index.ts:80-98` `onMessageExternal` → `classifyExternalMessage` (`companionTab.ts:54-84`, verifies `sender.origin === APP_ORIGIN` + state nonce); refresh token in `chrome.storage.session` (`refreshToken.ts`, `storage.ts:29-38`). Manifest `externally_connectable.matches:["https://app.truepoint.in/*"]`.

---

## What works (verified)

- **Open-redirect protection is real and consistent.** Every place a client-supplied `app_origin`/`returnTo` becomes a redirect target passes through `isAllowedOrigin` (exact-match `includes`, never a prefix, never reflected): `sessionGuard.ts:41-45`, `password/actions.ts:40`, `magic/actions.ts:36`, `sso/actions.ts:32`, `signup/actions.ts:58`, `reset/actions.ts:66`. `finishLogin` redirects to `txn.appOrigin`, which could only enter the txn after that gate. **AUTH-036 = works.**
- **Code, not token, in the URL.** `finishLogin.ts:27` puts only the single-use `code` (+state) in the callback URL; the JWT is returned in a POST JSON body (`token/exchange/route.ts:114`). Code is IP+PKCE+origin-bound and GETDEL single-use (`code.ts:57-76`).
- **PKCE S256** — verifier 32 bytes CSPRNG, SHA-256 challenge, base64url (`pkce.ts:9-13`); server recomputes `s256(verifier)===challenge` (`code.ts:35,48`).
- **CSRF on token endpoints.** `/token/refresh`, `/logout`, `/{org,workspace}/switch` are cookie-driven with `SameSite=Strict` + a credentialed-CORS allow-list; `/token/exchange` requires the PKCE verifier held in the initiator's `sessionStorage`. Server actions use Next App-Router built-in origin checks. **AUTH-053 invariant holds.**
- **Cookie attributes** — HttpOnly, Secure, SameSite=Strict, host-only Domain, Path=/ (`cookies.ts:8-18`). **AUTH-056 largely satisfied** (gap: no `__Host-` prefix).
- **Extension origin validation** — dual gate: `isAllowedOrigin(extOrigin)` server-side (mint 403s unregistered ids) + `sender.origin === APP_ORIGIN` and state-nonce match client-side (`companionTab.ts:59-67`). `EXTENSION_ORIGINS` off by default, fail-closed.
- **Reuse detection** protects the refresh rotation (`refresh.ts:29`, 30s grace).

---

## Findings

### F1 — Extension access token's `scope:["extension"]` is never enforced by the API (privilege not actually scoped)
- **Severity: high · Status: broken · AUTH: NEW:AUTH-061**
- **Evidence:** `apps/auth/src/app/extension/mint/route.ts:83-90` mints `scope:["extension"]`, `aud=chrome-extension://<id>`; the header comment calls it "a scoped prospecting credential, not an admin one." But `apps/api/src/middleware/authn.ts:17` verifies audience against the **entire** `appOrigins()` set — which *includes* the extension origins (`env.ts:496-499`) — and **never reads `claims.scope`**. A repo-wide grep for scope enforcement in `apps/api/src` returns nothing.
- **Root cause:** audience allow-list conflates "may present a token" with "may call this endpoint," and no middleware maps `scope` to an allowed route set. The scope claim is decorative.
- **Impact:** the extension token (and anyone who exfiltrates the SW-held refresh token) can call *every* tenant-scoped `/api/v1/*` endpoint for that user's tenant/workspace — full read/write, credit spend, exports — not just prospecting reads. Only `/admin/*` is out of reach (pa dropped). The stated security boundary of ADR-0045 ("scoped credential") does not exist at the enforcement point.

### F2 — admin `silentRefresh` lacks the in-flight de-dup the web client has → concurrent cold-load refreshes can trip reuse-detection
- **Severity: medium · Status: partial · AUTH: NEW:AUTH-062**
- **Evidence:** `apps/web/src/lib/authClient.ts:15,102-121` collapses concurrent refreshes into one shared promise, with an explicit comment that two concurrent `/token/refresh` calls let "the slower one rotate the cookie out from under the faster one." `apps/admin/src/lib/authClient.ts:90-103` has **no** such guard — the shell gate and first data fetch both call `silentRefresh` on cold load.
- **Root cause:** the web fix was not ported to admin.
- **Impact:** on admin cold load two rotations can race; the second presents an already-rotated cookie. The 30s `REUSE_GRACE_MS` window (`refresh.ts`) usually absorbs it, but outside that window `findActiveSessionOrDetectReuse` revokes the **whole session family** — a spurious full sign-out of the staff console (and, because the session is shared, the customer app too).

### F3 — No Single-Logout; extension session survives web logout, and there is no upstream-IdP SLO
- **Severity: medium · Status: missing · AUTH: AUTH-016 (confirm Absent)**
- **Evidence:** web/admin `logout()` (`authClient.ts:139-147` / `:121-129`) POSTs `/auth/logout`, which revokes only the session matching the `lw_refresh` cookie (`logout/route.ts:37-45`). The extension mints a **separate** session family (`extension/mint/route.ts:75`) — nothing revokes it on web logout. SAML/OIDC SLO is unbuilt (`06-gap-analysis.md` §(m); providers throw in prod).
- **Nuance (works):** web and admin **share** the one host-only `lw_refresh` cookie on `auth.truepoint.in`, so a web logout *does* propagate to admin on its next refresh/≤15-min token expiry — cross-*web-app* logout is effectively covered. The gap is (a) the extension family and (b) no logout signal to the upstream IdP.
- **Impact:** after a user logs out (or is deprovisioned) the extension keeps a live token family until it independently expires; enterprise SLO expectations (Okta/OneLogin global logout) are unmet.

### F4 — Refresh cookie uses `Domain=` host scope instead of a `__Host-` prefix
- **Severity: low · Status: partial · AUTH: AUTH-056 (confirm, refine)**
- **Evidence:** `cookies.ts:8-18` sets `Domain=${AUTH_COOKIE_DOMAIN}`. superRefine (`env.ts:345-351`) pins that to the exact auth host, so scope is effectively host-only — but the presence of a `Domain` attribute means it is not a `__Host-` cookie, which would additionally forbid `Domain` and pin `Path=/`+`Secure` at the UA level.
- **Impact:** minor hardening gap; a future misconfig that widened `AUTH_COOKIE_DOMAIN` to `truepoint.in` would silently broaden blast radius (the superRefine is prod-only and could be bypassed in a non-prod build). `__Host-lw_refresh` would make the tight scope structurally unforgeable.

### F5 — Three "PKCE impls" are actually two byte-identical copies (web/admin) + none in the extension
- **Severity: low · Status: works (by design) · AUTH: NONE (AUTH-036-adjacent)**
- **Evidence:** `apps/web/src/lib/pkce.ts` and `apps/admin/src/lib/pkce.ts` are identical (32-byte verifier, 16-byte state). The extension deliberately uses **no** PKCE — the companion-tab handoff (`companionTab.ts`) substitutes a 16-byte state nonce + `sender.origin` verification (ADR-0045).
- **Impact:** none functional. Duplication is a drift risk (a future entropy/algorithm fix must be applied twice); worth extracting to a shared package. The extension's non-PKCE model is sound because the handoff never crosses an untrusted redirect.

### F6 — ADR-0045 storage note is stale (code is safer than documented)
- **Severity: low · Status: stale-doc · AUTH: NONE**
- **Evidence:** the inventory/ADR-0045 note says the extension refresh token is "stored in chrome.storage.local (AES-GCM)." Actual code stores it in `chrome.storage.session` (memory-backed, cleared on browser close, TRUSTED_CONTEXTS only) with **no** encryption (`refreshToken.ts:1-30`, `storage.ts:29-38`).
- **Impact:** documentation-only; the implemented choice is stronger (no long-lived bearer secret on disk, no key to manage). Update the doc; do not "fix" the code back to storage.local.

### F7 — admin callback does a full-document reload, discarding the just-minted token
- **Severity: low · Status: partial · AUTH: NONE**
- **Evidence:** `apps/admin/src/app/callback/page.tsx:40` `window.location.replace("/")` tears down the JS context and drops the in-memory access token, forcing a redundant silent refresh — the exact anti-pattern the web callback was rewritten to avoid (`web/.../callback/page.tsx:1-6,64-66`).
- **Impact:** one extra cross-origin `/token/refresh` per staff sign-in; slower console load. Correctness unaffected.

### Config fragility (context, not a discrete defect)
`AUTH_ORIGIN`/`APP_ORIGIN` are `NEXT_PUBLIC_*` baked at build (`web/src/lib/publicConfig.ts:9-14`, `admin/.../publicConfig.ts:6-11`); a wrong bake breaks sign-in (matches the prior deploy incident). Mitigated by the prod superRefine asserting `NEXT_PUBLIC_APP_ORIGIN ∈ APP_ORIGINS` (`env.ts:357-365`). `APP_ORIGIN` on web derives from `window.location.origin`, so a preview/non-allow-listed host fails `isAllowedOrigin` at exchange.

---

## Register reconciliation

| AUTH-### | Prior | Verified now | Note |
|---|---|---|---|
| AUTH-036 | New-section (open-redirect) | **Implemented / works** | Exact-match allow-list on every `app_origin`/returnTo redirect; never reflected. See "What works." |
| AUTH-053 | New-section (CSRF invariant) | **Holds / works** | SameSite=Strict cookie + credentialed-CORS allow-list on token routes; PKCE-verifier binds exchange; server-action origin checks. |
| AUTH-056 | New-section (cookie attrs) | **Partial** | HttpOnly/Secure/SameSite=Strict/host-Domain present; missing `__Host-` prefix (F4). |
| AUTH-016 | Medium, unbuilt | **Confirmed Absent** | No SLO, no extension-family logout on web logout (F3). |
| AUTH-052 | Fixed-in-place | **Confirmed** | JWKS lives at `/auth/.well-known/jwks.json` under basePath; `token.ts:28`, web rewrite. |
| NEW:AUTH-061 | — | **Broken (high)** | Extension `scope:["extension"]` unenforced by apps/api (F1). |
| NEW:AUTH-062 | — | **Partial (medium)** | admin `silentRefresh` missing in-flight de-dup → reuse-detection sign-out (F2). |

---

## Gaps vs enterprise expectations (Auth0/Okta-class, OWASP ASVS 5.0 V6, NIST 800-63B)

- **Token scoping (ASVS V6, least privilege):** a named scope that no resource server enforces (F1) fails the "scoped credential" expectation an enterprise assumes for a browser-extension token.
- **Global / single logout (Okta SLO):** absent (F3) — no way to kill all of a user's sessions (extension + upstream IdP) in one action.
- **Cookie hardening:** `__Host-` prefix is the modern baseline for session cookies (F4).
- **Concurrent-session cap** (AUTH-042) remains absent — out of my lane but adjacent to the shared-session model here.

## Recommended fix direction (brief)

1. **F1 (do first):** add scope enforcement in `apps/api` — a middleware that reads `claims.scope` and, for extension-audience tokens, restricts to an explicit prospecting route allow-list (deny by default). Alternatively verify extension tokens only on the routes the extension needs, with a dedicated audience check separate from web `appOrigins()`.
2. **F2:** port the web `refreshInFlight` single-flight promise into `apps/admin/src/lib/authClient.ts`.
3. **F3:** on web/admin logout, best-effort revoke the user's extension session family (server-side fan-out by userId), and track SLO under AUTH-016 for the SSO track.
4. **F4:** rename to `__Host-lw_refresh` and drop the `Domain` attribute (host-only is already the intent).
5. **F5:** extract `pkce.ts` to a shared `@leadwolf/*` module. **F6:** correct the ADR-0045 storage note. **F7:** switch admin callback to a client-side router nav like web.
