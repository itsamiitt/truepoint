# Deep Audit — Forgot-Password / Recovery Flow

Area: Forgot-password / recovery (reported BROKEN in production — root-caused).
Auditor scope: `apps/auth/src/app/forgot` + `reset` → `packages/auth/src/passwordReset.ts` → mailer (`apps/auth/src/lib/mailer.ts` + `lib/emails/*`) → token store (`emailVerification.ts`, `authEmailTokenRepository`) → login-after-reset.
Date: 2026-07-06. All citations re-verified against current working-tree code.

**Verdict: the flow is broken in production by TWO independent hard breakers.** (1) The
"production" SMTP transport is MailHog, a developer mail-capture container — every reset email is
swallowed on the box and never delivered. (2) Even with a real SMTP transport, the emailed link
itself is wrong: it omits the app's `/auth` basePath and 404s at the edge. Either alone fully
reproduces "forgot password is broken". The core library (`passwordReset.ts`) is actually
well-built — the breakage is entirely in the delivery seam and the link construction.

---

## Current implementation (file:line map)

| Stage | File | Key lines |
|---|---|---|
| Request screen (SSR, no-JS, enumeration-safe copy, `?sent=1` state) | `apps/auth/src/app/forgot/page.tsx` | 17–51 (sent state 32–51) |
| Request action (rate-limit → `requestPasswordReset` → mail → redirect `?sent=1`) | `apps/auth/src/app/forgot/actions.ts` | 15–45; link built at **40**; send at **41**; redirect at **44** |
| Reset screen (new-password + confirm, hidden email/code, neutral errors) | `apps/auth/src/app/reset/page.tsx` | 16–72; guard at 18 |
| Reset action (lockout → `completePasswordReset` → `/login?reset=1`) | `apps/auth/src/app/reset/actions.ts` | 19–72; lockout 40–46; consume 48–58; success clear 59; allowlisted carry-forward 63–71 |
| Core orchestration (enumeration-safe request; policy-before-consume; set password; revoke-all; audit) | `packages/auth/src/passwordReset.ts` | request 28–52; complete 67–114; revoke-all at **89** |
| Token mint/consume (6-digit code, SHA-256(purpose:email:code), 15-min TTL) | `packages/auth/src/emailVerification.ts` | TTL 11; hash 12–13; mint 23; consume 36–43 |
| Token store (one outstanding token per email+purpose; atomic single-use consume) | `packages/db/src/repositories/userRepository.ts` | 601–640 (create tx 602–622, consume 626–639) |
| Mailer (dev log / prod nodemailer / **unset → warn-and-return**) | `apps/auth/src/lib/mailer.ts` | 27–45; silent path **32–37** |
| Email template (branded HTML + text, 15-min copy) | `apps/auth/src/lib/emails/passwordReset.ts` | 10–25 |
| Brute-force lockout (5/identifier + 50/IP per 15 min; fails open) | `packages/auth/src/rateLimit.ts` | 120–122, 146–156, 159–191 |
| Env schema (`SMTP_URL` optional; prod superRefine never checks it) | `packages/config/src/env.ts` | 199; superRefine 334–371 |
| Deploy (MailHog as prod mail, Caddy path-through, basePath) | `deploy/env.production.template:80`, `docker-compose.prod.yml:42–46`, `deploy/deploy.sh:63–64,121`, `deploy/Caddyfile:39–49`, `apps/auth/next.config.mjs:8` | — |
| Login-after-reset notice | `apps/auth/src/app/login/page.tsx` | 39–41 |

## What works (verified)

- **Enumeration-safe UX by construction**: `requestPasswordReset` returns the same `{sent:true}` shape for unknown accounts (`passwordReset.ts:34`); the `code` rides back only for the mailer; forgot page renders one neutral confirmation either way (`forgot/page.tsx:32–51`). (Undermined at runtime by the timing/500 oracle — see AUTH-064.)
- **Single-use, TTL'd, hash-at-rest token**: raw code never persisted; SHA-256 of `(purpose:email:code)` is the PK (`emailVerification.ts:12–13`); 15-min TTL (`:11`) matching the email copy; atomic consume marks `consumed_at` only if unconsumed + unexpired (`userRepository.ts:626–639`); re-request deletes the prior unconsumed token so only one link is ever live (`userRepository.ts:602–622`).
- **Policy-before-consume (NIST 800-63B)**: the new password is checked (length + HIBP breach via `checkPasswordAcceptable`) BEFORE the single-use code is burned, so a weak password doesn't waste the link (`passwordReset.ts:72–78`; surfaced as "weak" in `reset/actions.ts:52`).
- **Revoke-all-sessions on reset (ADR-0040 W5/W6)**: `completePasswordReset` → `revokeAllSessionsForUser` (`passwordReset.ts:89`), which revokes durable rows AND deny-lists live access tokens (`packages/auth/src/session.ts:132–135`).
- **Brute-force lockout on the code**: `reset:${email}` namespaced credential lockout + per-IP, checked before consume, failure recorded, success cleared (`reset/actions.ts:40–59`; thresholds `rateLimit.ts:120–122` — 5/email + 50/IP per 15-min window, lockout = window = the token TTL).
- **Audit events**: `password.reset.request` → platform_audit_log for known accounts only (preserves non-enumeration, `passwordReset.ts:39–43`); `password.reset.complete` → tenant audit_log when exactly one tenant, else platform (`:95–111`). Matches the AUTH-051 enum names exactly.
- **Open-redirect discipline**: `app_origin` is carried forward to `/login` only if `isAllowedOrigin` (`reset/actions.ts:63–70`); `redirectIfAuthenticated` only bounces to allow-listed origins (`sessionGuard.ts:41–45`).
- **Login-after-reset**: `/login?reset=1` renders "Your password has been updated" (`login/page.tsx:39–41`); the reset flow deliberately does NOT auto-sign-in (correct — the fresh credential is proven at login, and MFA/policy still runs).
- **Reset code never logged / never echoed** in errors (verified in both actions; the neutral `error=1` maps to "invalid or expired").

## Findings

### AUTH-061 — [CRITICAL / broken] Production SMTP is MailHog: reset emails are captured on-box, never delivered — THE root cause
- **Evidence**: `deploy/env.production.template:80` (`SMTP_URL=smtp://mailhog:1025`); `docker-compose.prod.yml:42–46` (mailhog service, UI bound to `127.0.0.1:8025` "view captured email via SSH tunnel"); `deploy/deploy.sh:63–64` starts mailhog as step "[2/4] local infrastructure" on every production deploy and prints `Mail : http://127.0.0.1:8025 (MailHog…)` at `:121`; `mailer.ts:5–6` documents the arrangement ("the preview stack points SMTP_URL at MailHog").
- **Root cause**: the preview-stack mail capture was promoted verbatim into the production template/compose/deploy path. `NODE_ENV=production` (`env.production.template:14`, sourced via `env_file` at `docker-compose.prod.yml:16`) puts `sendAuthEmail` on the real-transport branch (`mailer.ts:38`), which "succeeds" — into a capture container no user can see. No real ESP (SES/Resend/SendGrid) exists anywhere in the repo for auth mail.
- **User impact**: every forgot-password request appears to succeed ("Check your email"), but the email only exists in MailHog on the server. Recovery is 100% broken for real users. Same transport also swallows signup verification codes and magic links (adjacent lanes).
- **Mapping**: NEW — closest register row is AUTH-040 ("deliverability unmonitored"), which materially UNDERSTATES this: deliverability isn't unmonitored, it is nonexistent.

### AUTH-062 — [CRITICAL / broken] Emailed reset link omits the `/auth` basePath → 404 even with a working transport
- **Evidence**: `forgot/actions.ts:40` builds `` `${env.AUTH_ORIGIN}/reset?…` ``; `apps/auth/next.config.mjs:8` sets `basePath: "/auth"` (every page actually lives at `/auth/reset`); `deploy/env.production.template:17` sets `AUTH_ORIGIN=https://auth.truepoint.in` (no path); `deploy/Caddyfile:39–49` reverse-proxies `auth.truepoint.in` to `auth:3000` with NO path rewrite. Contrast: every other consumer addresses the auth app WITH the prefix — e.g. `apps/web/src/lib/authClient.ts:68` (`${AUTH_ORIGIN}/auth/login`), `:82` (`/auth/token/exchange`). Next.js serves 404 for requests outside its basePath.
- **Root cause**: absolute-URL construction for the email bypasses Next's automatic basePath handling (in-app `redirect("/reset?…")` gets the prefix added by the framework; the hand-built string does not).
- **User impact**: independent second hard breaker — fix the SMTP transport and the flow is STILL broken: clicking "Reset password" lands on a 404. **Same bug in the magic-link email**: `apps/auth/src/app/magic/actions.ts:51` builds `${env.AUTH_ORIGIN}/magic/confirm` (flagged for the magic-link auditor's lane).
- **Mapping**: NEW (not caught by the prior pass).

### AUTH-063 — [HIGH / broken] Unset `SMTP_URL` degrades to silent success; no production env gate
- **Evidence**: `mailer.ts:32–37` — production with `SMTP_URL` unset writes a stderr warning and RETURNS; the caller `forgot/actions.ts:44` then redirects to `?sent=1`, so the user sees "Check your email" while nothing was sent. `packages/config/src/env.ts:199` — `SMTP_URL: z.string().optional()`; the production `superRefine` (`env.ts:334–371`) asserts cookie-domain and origin consistency but never SMTP_URL. No health/smoke check in `deploy/deploy.sh` covers mail.
- **Root cause**: a deliberate "signup must never 500 on a missing transport" trade (`mailer.ts:7–8`) made sense for optional signup verification but is applied to the account-RECOVERY path, where the email IS the product. Combined with the optional schema, a production box can boot green with recovery entirely dark.
- **User impact**: any future deploy that drops/renames SMTP_URL silently kills recovery again — no boot failure, no alert, only a stderr line. This is the failure mode that turns AUTH-061 from a config bug into a systemic one.
- **Mapping**: NEW.

### AUTH-064 — [HIGH / broken] Inline, unguarded SMTP send in the server action → 500-on-transport-failure and an account-existence + timing oracle
- **Evidence**: `forgot/actions.ts:38–44` — `await sendAuthEmail(...)` at `:41` has no try/catch, and runs ONLY inside the `if (code)` known-account branch. `mailer.ts:38–44` `transport().sendMail(...)` rejects on any SMTP failure (connection refused, DNS, TLS, 5xx).
- **Root cause**: transactional send is synchronous and in-band with the request instead of queued (the repo already runs BullMQ workers), and the enumeration-safety analysis stopped at the redirect/copy level.
- **User impact / security impact**: (a) with a flaky/unreachable transport, existing accounts get a Next.js 500 error page while unknown emails always redirect to `?sent=1` — a perfect account-existence oracle, and broken UX for exactly the users who exist; (b) even when the send succeeds, the known-account branch performs a platform-audit insert + token insert + full SMTP round trip that the unknown-account path skips (`passwordReset.ts:34` returns immediately) — a measurable timing oracle that defeats the carefully-built response parity. OWASP ASVS 5.0 V6 expects recovery to be indistinguishable for existing vs non-existing accounts including response time.
- **Mapping**: NEW; concretizes register row AUTH-019 ("account-recovery edge cases … enumeration under-specified") — AUTH-019 stays open, this is its first confirmed concrete instance.

### AUTH-065 — [MEDIUM / partial] Reset token is a 6-digit code (~20 bits) used as a link-borne bearer secret; its only guard fails open, and its at-rest hash is trivially reversible
- **Evidence**: `emailVerification.ts:23` — `randomInt(0, 1_000_000)` zero-padded 6 digits, the SAME primitive for `verify`/`magic_link`/`reset`; it rides in a GET URL (`forgot/actions.ts:40`). Guessing is capped only by the Redis credential lockout (5/email + 50/IP per 15 min, `rateLimit.ts:120–122`) which **fails open on Redis outage** (`rateLimit.ts:146–156`: `catch { return; }`); `recordCredentialFailure` also swallows infra errors (`:174–181`). At rest the hash is a single unsalted SHA-256 over a 10^6 space (`emailVerification.ts:12–13`) — anyone with a DB read (backup, replica, SQLi elsewhere) recovers a live reset code in milliseconds.
- **Root cause**: reuse of the OTP primitive (designed for a typed code + strict lockout) for a clickable link, where NIST 800-63B/ASVS expect a ≥112-bit single-use URL token. The 6-digit choice is acceptable ONLY while the lockout holds; the lockout is fail-open by design.
- **User impact**: during a Redis outage an attacker who triggers a reset for a victim can brute-force ~10^6 codes inside the 15-min TTL (a few hundred rps sustained) and take over the account. Mitigations that keep this Medium not High: single outstanding token per email, 15-min TTL, atomic single-use consume, and per-IP Caddy exposure. Recommend: 128-bit random token for the `reset` purpose (keep 6-digit for typed OTP), HMAC-keyed hash at rest (`BLIND_INDEX_KEY` already exists).
- **Mapping**: NEW; adjacent to AUTH-019/AUTH-057 (recovery threat rows) but the entropy/fail-open specifics are unregistered.

### AUTH-066 — [MEDIUM / partial] Password reset silently ENABLES password login on SSO-only / passwordless accounts (auth-method downgrade)
- **Evidence**: `passwordReset.ts:32–51` issues a reset code for ANY existing user — no check of `users.password_hash IS NULL` (the schema's marker for SSO/passkey-only identities, `packages/db/src/schema/auth.ts`), no consult of tenant `allowed_methods` policy; `completePasswordReset` unconditionally `setPassword`s (`passwordReset.ts:83–84`, `userRepository.ts:127–129`). `authenticatePassword` then accepts the new hash (`packages/auth/src/login.ts:19–21`). Tenant policy enforcement is flagged OFF by default (`AUTH_POLICY_ENFORCEMENT_ENABLED`, `env.ts:195`).
- **Root cause**: recovery operates on the global identity and ignores the per-tenant method policy that login honors (when flagged on).
- **User impact**: a tenant that mandates SSO-only expects no password surface; anyone controlling the user's mailbox (or the user themselves) mints a password credential via /forgot, bypassing the intended posture. Today's blast radius is limited (real SSO adapters throw in production — the SSO lane's finding), but this becomes a live downgrade path the day SSO ships. Okta/Auth0 suppress recovery email for federated-only identities while keeping the neutral response.
- **Mapping**: NEW.

### AUTH-067 — [LOW / partial] Post-reset friction bundle (verified minor defects)
Three small, confirmed defects, bundled to keep the register tight:
1. **Reset does not clear the LOGIN lockout**: success clears only `reset:${email}` (`reset/actions.ts:41,59`); the plain-`email` credential counter from the failed logins that drove the user to /forgot persists — a just-reset user can stay locked out of /login for up to 15 min (`rateLimit.ts:122`). Support-ticket generator: "reset my password and it still says too many attempts".
2. **min-length mismatch**: the reset form's inputs say `minLength={8}` (`reset/page.tsx:43,56`) while the action rejects `< 12` (`reset/actions.ts:35`) and the error copy says 12 — an 8–11-char password passes browser validation then bounces server-side.
3. **No status gate on reset**: `completePasswordReset` never checks `user.status` (`passwordReset.ts:80–84`) — a suspended user can rotate their password (login still blocks at `login.ts:19`, so impact is hygiene/audit-noise only).
- **Mapping**: NEW (bundle).

### Verified-OK edge cases (no finding)
- **Concurrent requests**: re-request deletes the prior unconsumed token (`userRepository.ts:604–612`) — only the newest link works; no token-accumulation guessing surface.
- **Replay**: consume is an atomic conditional UPDATE (`:626–639`); a used/expired/foreign code re-renders the neutral "invalid or expired" error (`reset/page.tsx:25`).
- **Logged-in visitor on /reset**: bounced to the app by `redirectIfAuthenticated` (`reset/page.tsx:18`, fail-open on DB error, allowlisted target) — mild UX friction for "I'm logged in but want to reset", defensible; /account/security covers that path.
- **Unverified-email accounts**: reset works (it proves mailbox control — strictly stronger than the verify code); consistent with NIST.
- **Rate-limited request**: `?error=rate` renders a distinct throttle message (`forgot/page.tsx:13–15`) without revealing existence.

## Register reconciliation

Confirmed rows (fresh evidence, status unchanged):
- **AUTH-019** (recovery edge cases under-specified, Medium) — CONFIRMED still open; now has concrete instances (see AUTH-064/065). Rate-limit + replay + enumeration-messaging edges are actually IMPLEMENTED and verified; the register row's remaining substance is the oracle + entropy items.
- **AUTH-051** (audit enum names) — CONFIRMED accurate: `password.reset.request` / `password.reset.complete` are the live action strings (`passwordReset.ts:40,100`).
- **AUTH-057** (recovery social-engineering / fixation edges, Low) — CONFIRMED open; no session is minted by reset (no fixation surface found); reset revokes all sessions.

Status changes:
- **AUTH-040** (transactional-email deliverability unmonitored, Medium) — UNDERSTATED → superseded in practice by AUTH-061: production transport is a capture tool, so there is nothing to monitor yet. Keep AUTH-040 for the monitoring work; raise its dependency on AUTH-061.

New rows proposed (continuing from AUTH-061):
| ID | Severity | Title |
|---|---|---|
| AUTH-061 | **Critical** | Production SMTP pointed at MailHog — auth emails captured, never delivered (root cause of "forgot password broken") |
| AUTH-062 | **Critical** | Emailed reset (and magic-link) URLs omit the `/auth` basePath → 404 at the edge |
| AUTH-063 | High | Missing `SMTP_URL` degrades to silent success; no production env-schema gate or deploy smoke test for mail |
| AUTH-064 | High | Inline unguarded SMTP send in /forgot action → 500-only-for-existing-accounts + timing oracle (enumeration) |
| AUTH-065 | Medium | 6-digit (~20-bit) reset code as a URL bearer token; fail-open lockout; unsalted SHA-256 at rest |
| AUTH-066 | Medium | Reset enables password login on SSO-only/passwordless accounts (auth-method downgrade) |
| AUTH-067 | Low | Post-reset friction bundle: login-lockout not cleared, 8-vs-12 min-length mismatch, no status gate |

## Gaps vs enterprise expectations (Auth0/Okta-class, ASVS 5.0 V6, NIST 800-63B)

1. **Delivery is not architected**: no ESP integration, no DKIM/SPF/DMARC posture for `no-reply@auth.truepoint.in` (`mailer.ts:20`), no bounce/complaint feedback, no send queue/retry, no deliverability monitoring (AUTH-040). Enterprise IdPs treat recovery mail as a tier-1 dependency with health checks.
2. **Recovery indistinguishability must include timing and failure behavior**, not just copy (ASVS V6; violated per AUTH-064).
3. **URL-borne recovery tokens should be high-entropy (≥112 bits)** with keyed hashing at rest; 6-digit codes belong only to typed-OTP UX with hard fail-closed throttling (AUTH-065).
4. **Federated-identity awareness in recovery**: recovery for SSO-only users should route to the IdP (or be suppressed) per tenant policy (AUTH-066).
5. **No resend affordance / no delivery-status insight** on the sent screen (`forgot/page.tsx:46–48` tells the user to retry manually) — minor vs the above.

## Recommended fix direction (brief)

1. **P0 (unbreaks the flow)**: point `SMTP_URL` at a real ESP (SES/Resend SMTP) in `env.production.template`; demote MailHog to a compose override for previews only; fix the link builders to include the basePath — safest is a single `authUrl(path)` helper that derives from `AUTH_ORIGIN` + the known `/auth` basePath, used by both `forgot/actions.ts:40` and `magic/actions.ts:51`, with a unit test asserting the emitted URL matches a route that actually exists.
2. **P0 guardrails**: env `superRefine` — in production, require `SMTP_URL` and reject `mailhog` hosts; add a mail smoke check to `deploy.sh` (nodemailer `verify()`).
3. **P1**: wrap the send (try/catch + log + still redirect `?sent=1`) AND move it out-of-band — enqueue on the existing BullMQ infra so known/unknown paths do identical synchronous work (kills both oracles).
4. **P1**: switch the `reset` purpose to a 128-bit random token, HMAC-SHA-256 at rest with `BLIND_INDEX_KEY`; keep the 6-digit primitive for typed OTP only.
5. **P2**: suppress/route recovery for `password_hash IS NULL` users per tenant policy; clear the login lockout on successful reset; align form `minLength` to 12; add DKIM/SPF/DMARC + bounce webhook monitoring (closes AUTH-040).
