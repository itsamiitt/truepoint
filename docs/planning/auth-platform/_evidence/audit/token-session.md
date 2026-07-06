# Token & Session Lifecycle — Deep Audit

Area: JWT mint/verify, refresh rotation, reuse detection, revocation deny-list, session timeout/idle caps,
signing-key custody & rotation, IP binding, clock skew, concurrent-session cap.

Verdict: the core lifecycle is **well-built and enterprise-shaped** — opaque refresh, hash-at-rest, rotation
with family-revoke reuse detection, a per-request deny-list, and a genuinely stateless verifier. The material
gaps are all **operational/custody**: single-key JWKS (no seamless rollover), dev-derived at-rest KMS key,
deny-list fail-open, no concurrent-session cap, and a `pa`-claim demotion window.

---

## Current implementation (file:line map)

- **Access JWT mint/verify** — `packages/auth/src/token.ts`
  - EdDSA, `ALG="EdDSA"` (token.ts:9); kid from `env.JWT_SIGNING_KID` set in protected header (token.ts:54).
  - Claims minted (token.ts:47-60): `tid`, optional `wid`, `sid`, `scope[]`, optional `pa:true`, `sub`, `iss=AUTH_ORIGIN`, `aud=requesting app origin`, `iat`, `exp=now+ACCESS_TOKEN_TTL_SECONDS`.
  - Verify (token.ts:64-74): `jwtVerify(token, remoteJwks(), { issuer: AUTH_ORIGIN, audience, algorithms:["EdDSA"] })` then `accessTokenClaimsSchema.parse`.
  - JWKS fetch location = `INTERNAL_AUTH_ORIGIN ?? AUTH_ORIGIN` + `/auth/.well-known/jwks.json` (token.ts:28); iss/aud still pinned to public `AUTH_ORIGIN` (token.ts:69). `createRemoteJWKSet` lazy singleton, ~5-min cache (token.ts:29-31).
  - `assertSigningKey()` boot self-test mints a throwaway token → clear non-secret error if key missing (token.ts:88-103).
- **JWKS route** — `apps/auth/src/app/.well-known/jwks.json/route.ts:5-8`: `Cache-Control public, max-age=300`. `getJwks()` (token.ts:77-80) publishes **exactly one** key `[{ ...jwk, use:"sig", alg:"EdDSA", kid }]`.
- **Claims schema** — `packages/types/src/auth.ts:125-136`: `sub` uuid, `tid` uuid, `sid` string, `scope[]`, `pa` optional bool, iss/aud/exp/iat. No `typ`/`jti`.
- **TTLs** — `packages/config/src/env.ts:64-66`: access default 900 s (15 min); refresh default 2_592_000 s (30 d); auth code ≤120 default 60 s.
- **Signing key material** — env.ts:68-75, 454-464: `JWT_PRIVATE_KEY_PEM`/`_PUBLIC_KEY_PEM` (+ `_B64` transport decoded in `loadEnv`). Single kid.
- **Durable session** — `packages/auth/src/session.ts`
  - `createSession` (72-89): `sessionId=randomBytes(24)`, `refreshToken=randomBytes(32)` base64url; stores **only** `hashRefreshToken` = SHA-256 hex (session.ts:12); `expiresAt=cappedSessionExpiry(...)`.
  - `rotateSession` (92-123): new id + token, capped to `min(default|policy, notLaterThan)`, `sessionRepository.rotate` revokes old + inserts new in one tx (`userRepository.ts:367-377`), then `markRevoked(oldSessionId)` (session.ts:121).
  - `revokeSession` (126-129): DB revoke + `markRevoked`. `revokeAllSessionsForUser` (132-135): revoke-all + `markManyRevoked`.
  - `findActiveSessionOrDetectReuse` (154-171): unknown hash → 401; `revokedAt` set and older than `REUSE_GRACE_MS=30_000` → `revokeAllSessionsForUser` (family revoke) then 401, within grace → plain 401; `expiresAt<now` → 401.
  - Timeout caps (21-44): `cappedSessionExpiry` = `min(default, now+cap)`; `isIdleExpired` gated, null lastSeenAt fails safe.
  - Partial-unique live-hash index — `packages/db/src/schema/auth.ts:216-218` `WHERE revoked_at IS NULL`.
- **Refresh path** — `packages/auth/src/refresh.ts:23-99` + route `apps/auth/src/app/token/refresh/route.ts`. Enforcement caps behind `AUTH_POLICY_ENFORCEMENT_ENABLED==="true"` AND per-tenant `enforcementEnabled` (refresh.ts:54-69). Carries `pa` from live `user.isPlatformAdmin` (refresh.ts:90).
- **Deny-list** — `packages/auth/src/revocation.ts`: `markRevoked` key `revoked-sid:<sid>` EX=`ACCESS_TOKEN_TTL_SECONDS` (23-30), swallows errors; `isRevoked` **fails open** (returns false) on any Redis error (42-48).
- **API verifier** — `apps/api/src/middleware/authn.ts:11-27`: Bearer → `verifyAccessToken(token, appOrigins())` → **`isRevoked(claims.sid)` per request** → set claims. `platformAdmin.ts:14` gates on signed `pa`.
- **Cross-domain exchange** — `apps/auth/src/app/token/exchange/route.ts` + `packages/auth/src/code.ts` (single-use GETDEL Redis code, PKCE S256, IP-bound, origin-bound, ≤120 s).
- **IP binding** — `packages/auth/src/ipBinding.ts` (`strict|prefix|off`, default `prefix` = /24 or /64) + `apps/auth/src/lib/clientIp.ts` (**last** XFF entry, one-hop Caddy assumption).
- **Switch/logout** — `switchOrg.ts`, `switchWorkspace.ts` (rotate + deny-list + membership authz), `apps/auth/src/app/logout/route.ts` (best-effort revoke, always clears cookie + 204).
- **Extension family** — `apps/auth/src/app/extension/{mint,refresh,logout}/route.ts`: separate `createSession`, `aud=chrome-extension://<id>`, `scope:["extension"]`, `pa` deliberately not carried (mint route.ts:83-90).
- **Account security** — `apps/auth/src/app/account/security/actions.ts`: change-password evicts other sessions + deny-lists (73-74); self session-revoke (254-256) and revoke-all-others (265-268) deny-list.
- **Password reset** — `packages/auth/src/passwordReset.ts:89` `revokeAllSessionsForUser`.

---

## What works (verified)

1. **Stateless verifier with per-request revocation.** `authn.ts:17-24` verifies the EdDSA JWT against remote JWKS then does a **full deny-list lookup on every request** (`isRevoked(claims.sid)`) — not JWT-validity-only. Logout/rotate/switch take effect within seconds, not at the 15-min expiry.
2. **Opaque refresh, hash-at-rest.** Raw refresh token is `randomBytes(32)` returned once; only SHA-256 hex is persisted (`session.ts:12,74,81`). No JWT-as-refresh, no reversible storage.
3. **Rotation + reuse detection with family revoke.** `findActiveSessionOrDetectReuse` (session.ts:154-171) revokes the entire session family on a revoked-token replay outside a 30 s concurrency grace — correct OWASP-ASVS refresh-reuse posture. Rotation is atomic (`sessionRepository.rotate` single tx, userRepository.ts:367-377).
4. **iss/aud pinning survives the internal-fetch optimization.** `INTERNAL_AUTH_ORIGIN` moves only *where keys are fetched*; `jwtVerify` still pins `issuer=AUTH_ORIGIN` and audience to `appOrigins()` (token.ts:69, authn.ts:17). Internal http origin is never trusted as claim authority.
5. **Audience isolation for the extension.** Extension tokens carry `aud=chrome-extension://…`, `scope:["extension"]`, and deliberately omit `pa` (mint route.ts:88-90) — a scoped credential that apps/api accepts only if the ext origin is in `EXTENSION_ORIGINS ⊂ appOrigins()`.
6. **Absolute + idle session caps are correctly composed** behind the double flag; the absolute deadline is "sticky" across rotations via `notLaterThan` (refresh.ts:61, session.ts:101-105), so ~14-min rotations cannot extend a capped session.
7. **Boot self-test** (`assertSigningKey`) turns a missing/mangled key into a loud, secret-free 503 instead of every login silently failing (token.ts:88-103).
8. **IP-forgery hardening** — client IP is the **last** XFF hop (clientIp.ts:19), unspoofable behind the single Caddy hop; the cross-domain code binds to it (code.ts:46).

---

## Findings

### F1 — Single-key JWKS: no seamless signing-key rollover (rotation runbook gap)
- **Severity:** High · **Status:** partial · **AUTH mapping:** AUTH-013 (confirm + sharpen)
- **Evidence:** `packages/auth/src/token.ts:77-80` `getJwks()` returns `keys:[ …single env.JWT_SIGNING_KID ]`; mint always signs with that one kid (token.ts:54). No env slot for a "next" public key (`env.ts:68-75` has exactly one kid + one PEM pair).
- **Root cause:** The kid-in-header + remote-JWKS *seam* exists, but the publication side only ever emits one key. To rotate you must swap the single key, which **invalidates every in-flight token** the moment the JWKS cache turns over (≤5 min) and cannot overlap old+new. The code comment "add next on rotation" (token.ts:76) describes a capability the code does not have.
- **User-visible impact:** A key rotation (routine hygiene or post-compromise emergency) causes a fleet-wide 401 storm for up to the access-token TTL + JWKS cache. There is no zero-downtime cutover and no runbook — exactly the AUTH-013 + Part-2 "signing-key compromise" risk.

### F2 — At-rest secret key is dev-derived, not KMS-managed
- **Severity:** High · **Status:** partial · **AUTH mapping:** AUTH-013 (KMS-custody half)
- **Evidence:** `packages/auth/src/secrets.ts:9` `const KEY = sha256(env.BLIND_INDEX_KEY)` — the AES-256-GCM key for TOTP secrets / SSO client secrets is derived from the blind-index key. Comment at secrets.ts:8 concedes "production injects a dedicated KMS data key instead."
- **Root cause:** No KMS envelope wired; the same env secret protects blind-index and at-rest encryption, so one leaked env value compromises both. No key versioning → no re-encrypt/rotate path for stored MFA secrets.
- **User-visible impact:** Enterprise security review will flag shared-secret custody; a config/env leak exposes all stored TOTP + SSO secrets with no rotation story. (Signing key itself is a raw PEM in env, same custody class — see F1.)

### F3 — Revocation deny-list fails OPEN → ≤15-min residual access after revoke
- **Severity:** High · **Status:** works-as-designed-but-weakness · **AUTH mapping:** NEW:AUTH-061 (net-new: fail-open is a *revocation* weakness distinct from AUTH-010's SCIM race)
- **Evidence:** `packages/auth/src/revocation.ts:42-48` `isRevoked` returns `false` on any Redis error; `apps/api/src/middleware/authn.ts:22-24` therefore admits an otherwise-valid token during a Redis outage. `markRevoked` also swallows write errors (revocation.ts:26-29).
- **Root cause:** Deliberate safe-availability tradeoff — the durable session row is source of truth and refresh fails for a revoked session, so a Redis blip only re-widens the window to the token's natural ≤15 min. But for *immediate-revocation* obligations (deprovision, breach containment, compromised-session logout) this is a real 15-min residual-access window, and it is invisible to the operator (no alert when the list is unreachable).
- **User-visible impact:** During a Redis incident, a logged-out / deprovisioned / force-revoked user keeps working API access for up to 15 minutes. Combined with SCIM deprovision (also fail-open) the enterprise "instant off-boarding" claim is bounded at ≤15 min + 30 s refresh grace, not "immediate."

### F4 — No concurrent-session cap
- **Severity:** Medium · **Status:** missing · **AUTH mapping:** AUTH-042 (confirm — still Absent)
- **Evidence:** `createSession` (session.ts:72-89) unconditionally inserts a new row; no count/limit against `user_sessions` for the user. No `maxConcurrentSessions` knob in `tenant_auth_policies` reads (refresh.ts:54-69, flow.ts:207-210 read only mfa/methods/ip/timeouts). `sessionRepository` has no cap enforcement.
- **Root cause:** Feature never built; policy schema has timeout/idle/IP but no session-count control.
- **User-visible impact:** Enterprises that require "max N active sessions per user" (a common SSO/CASB control) cannot get it; a stolen refresh token that survived within grace can coexist indefinitely with the legitimate one until absolute expiry.

### F5 — Platform-admin (`pa`) demotion has a ≤15-min in-token residual
- **Severity:** Medium · **Status:** partial · **AUTH mapping:** NEW:AUTH-062
- **Evidence:** `pa` is minted into the JWT (token.ts:52) and **re-derived from the live user record on every refresh** (refresh.ts:90 `isPlatformAdmin: user.isPlatformAdmin ?? false`; same in switchOrg.ts:65, switchWorkspace.ts:67). `platformAdmin.ts:14` trusts the signed claim. Revoking `is_platform_admin` does **not** deny-list existing sessions.
- **Root cause:** Unlike org/workspace role (derived per-request from `tenant_members`, so demotion is immediate — GAP-TRUTH is correct there), the `pa` super-admin bit lives *in the token*. Nothing revokes outstanding `pa` tokens on demotion; they remain valid for the access-token TTL, and refresh happily re-mints as long as the underlying flag flips (it does re-read live, so refresh self-heals — but the current 15-min token does not).
- **User-visible impact:** A revoked platform super-admin keeps cross-tenant `withPlatformTx` access for up to 15 minutes unless someone also force-revokes their sessions. For the highest-privilege role this is the wrong default; demotion should deny-list the user's sessions.

### F6 — No clock-skew tolerance on verification
- **Severity:** Low · **Status:** partial · **AUTH mapping:** NONE
- **Evidence:** `token.ts:68-72` calls `jwtVerify` with no `clockTolerance`; jose defaults to 0 s. iss/aud/alg set, but no leeway for `exp`/`iat` skew between the auth origin and the api container.
- **Root cause:** Default strict clock. On a ~15-min token this is mostly benign, but any NTP drift between hosts can 401 a freshly-minted token at the boundary (or admit one a second past expiry).
- **User-visible impact:** Rare, hard-to-diagnose intermittent 401s at token boundaries under host clock drift. Enterprise IdPs typically allow a small (30-60 s) tolerance.

### F7 — Access token has no `jti`; deny-list is session-grained, not token-grained
- **Severity:** Low · **Status:** works (by-design) · **AUTH mapping:** NONE
- **Evidence:** Claims schema has no `jti` (auth.ts:125-136); revocation keys on `sid` (revocation.ts:20). Rotation deny-lists the **old sid** (session.ts:121), so the prior access token dies — correct. But two tokens minted under the *same* sid (only the extension mint reuses a fresh session, so not applicable) cannot be individually revoked.
- **Root cause:** Design choice — session-grained revocation is sufficient because rotation always changes sid. Noted for completeness; not a defect today.
- **User-visible impact:** None currently; flagged so a future "mint multiple tokens per session" change does not silently break granular revocation.

### F8 — XFF trust is single-hop; a fronting CDN would silently make client IP spoofable
- **Severity:** Low · **Status:** works (config-fragile) · **AUTH mapping:** NONE (relates to AUTH-036/rate-limit hardening)
- **Evidence:** `apps/auth/src/lib/clientIp.ts:8-9,19` hard-assumes exactly one trusted hop (Caddy) and takes the last XFF entry; the code comment explicitly warns "with an extra trusted CDN in front… raise the hop count accordingly" but the hop count is not configurable.
- **Root cause:** Hop depth is hard-coded to 1. Putting Cloudflare/another proxy in front (a plausible enterprise deployment change) makes the last entry the CDN's IP and re-opens client IP spoofing for the IP-bound code + per-IP rate limits.
- **User-visible impact:** Deployment-topology footgun: adding a CDN silently degrades IP binding and brute-force throttling. Should be an env-driven trusted-hop count.

---

## Register reconciliation

- **AUTH-013** (signing-key rotation runbook + KMS custody) — **CONFIRMED, still open.** Fresh evidence: single-key JWKS (`token.ts:77-80`, F1) means even *with* a runbook there is no seamless overlap without a code change to publish a second key; KMS custody still dev-derived (`secrets.ts:9`, F2). Status stays High; recommend splitting into F1 (dual-key publish, code work) + F2 (KMS wiring).
- **AUTH-042** (concurrent-session cap) — **CONFIRMED Absent** (F4). No enforcement in `createSession`; no policy knob read. No change to status.
- **AUTH-010** (SCIM deprovision race / deny-list fail-open) — **CONFIRMED for the token side.** The fail-open + ≤15-min residual is real at the revocation layer (F3); recorded here as the general revocation-weakness AUTH-061 so it is not scoped only to SCIM.
- **Proposed new rows:**
  - **AUTH-061** (NEW) — Revocation deny-list fails open on Redis outage → ≤15-min residual access after logout/revoke/deprovision, with no operator alert. Severity High. (F3)
  - **AUTH-062** (NEW) — `pa` platform-super-admin claim is in-token; demotion is not session-revoked, leaving ≤15-min cross-tenant residual. Severity Medium. (F5)

No stale-doc corrections needed in the register text for this area — the Part-2 "signing-key compromise" and AUTH-013/042 rows are accurate; they just need the sharper code evidence above.

---

## Gaps vs enterprise expectations (Auth0/Okta-class, ASVS 5.0 V6, NIST 800-63B)

- **Key rotation (ASVS V6 / operational):** Okta/Auth0 publish overlapping JWKS keys and rotate transparently. TruePoint publishes one key → no zero-downtime rotation (F1). **Gap.**
- **Key custody:** Enterprise IdPs keep signing keys in an HSM/KMS. TruePoint holds a raw PEM in env and derives the at-rest key from another env secret (F1/F2). **Gap.**
- **Immediate revocation:** Enterprise SCIM/CAEP promises near-instant off-boarding. TruePoint is "immediate when Redis is up, ≤15 min when it isn't," fail-open (F3). **Partial.**
- **Concurrent-session limits:** Standard CASB/SSO control; absent (F4). **Gap.**
- **Highest-privilege revocation:** Super-admin demotion should be instant; here it is in-token with a 15-min tail (F5). **Gap.**
- **Refresh reuse detection / rotation / hash-at-rest / opaque tokens:** **Meets or exceeds** the bar (family revoke + 30 s grace). **Strength.**
- **Audience/issuer pinning, PKCE cross-domain code, single-use:** **Meets** the bar. **Strength.**
- **Clock skew tolerance:** Minor deviation from typical 30-60 s leeway (F6). **Minor gap.**

---

## Recommended fix direction (brief)

1. **F1 (High):** Add a second signing-key slot (`JWT_NEXT_PUBLIC_KEY_PEM` + `JWT_NEXT_SIGNING_KID`); publish both in `getJwks()`; sign with current, verify against both. Write the overlapping-kid rotation runbook (AUTH-013). Small, high-leverage.
2. **F2 (High):** Wire `secrets.ts` to a KMS data key (interface already stable); add key-version tagging on stored blobs for re-encrypt. Stop deriving from `BLIND_INDEX_KEY`.
3. **F3 (High):** Keep fail-open, but (a) emit a metric/alert whenever `isRevoked`/`markRevoked` catches, so a silent deny-list outage is visible; (b) consider a short-TTL in-process fallback cache of recently-revoked sids to shrink the window during a Redis blip.
4. **F5 (Medium):** On `is_platform_admin` demotion, call `revokeAllSessionsForUser` (or deny-list the user's sids) so `pa` cannot outlive the flag by 15 min.
5. **F4 (Medium):** Add `maxConcurrentSessions` to tenant policy; enforce in `createSession` (evict oldest or reject) behind the existing enforcement flag.
6. **F6/F8 (Low):** Set `clockTolerance: "30s"` in `jwtVerify`; make the trusted-XFF-hop count env-driven.
