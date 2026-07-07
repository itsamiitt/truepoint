# Implementation Progress — Auth Platform

> Branch: `feat/auth-platform-phase0`. Driven by the 20-min `/loop` (cron `d2b375cd`). Each fire: read this file,
> do the next unstarted item, follow read-first + verify (typecheck/biome/tests), commit locally per item with the
> `AUTH-###` id (do NOT push), update this file. When a phase is fully done, move to the next. Gate command:
> `bunx turbo run typecheck --filter=./apps/auth --filter=./apps/web` + `bunx biome check <files>` + `bun test <files>`.
> Full plan: [`../12_Implementation_Roadmap.md`](../12_Implementation_Roadmap.md). Register: [`../01_Current_System_Audit.md`](../01_Current_System_Audit.md).

## Phase 0 — P0 hotfix bundle (turn off the reported breakage)

| # | Item | AUTH | Status | Commit / notes |
|---|---|---|---|---|
| 0.1 | Add `/auth` basePath to all constructed auth URLs (reset + magic email links, `/account/security` deep links) + link-shape tests | AUTH-062 | ✅ **done** | `authUrl` helper (apps/auth) + `authSecurityUrl` (apps/web), both tested (9 tests); wired forgot/magic actions + SecurityPanel. typecheck ✓ biome ✓ tests ✓ |
| 0.1b | Redirect from the un-prefixed `/account/security` etc. (belt-and-braces) — optional | AUTH-062 | ⏭️ **descoped (edge-only, low value)** | NOT fixable in app code: with `basePath: "/auth"`, Next auto-prefixes the middleware matcher, so an un-prefixed request 404s at the basePath boundary before reaching this app's middleware. The redirect must live at the EDGE (`deploy/Caddyfile`). Value is marginal — 0.1 already prefixed every CONSTRUCTED link; only stale pre-fix bookmarks/emails (expire in 15 min) or manual typos benefit. Editing prod TLS/edge config for that on the autonomous timer is high-blast-radius + unverifiable here (redirect-loop / healthcheck / JWKS / ACME footguns). **Safe recipe (supervised)** — in the `auth.truepoint.in {}` block: `@unprefixed { not path /auth/* /.well-known/* }` then `redir @unprefixed /auth{uri}`; then verify: no loop on `/auth/*`, `/auth/.well-known/jwks.json` still 200s, the container healthcheck path still 200s, ACME renewal unaffected. |
| 0.2a | Transport-visibility hardening: mailer flags an unset (AUTH-063) or dev-capture/MailHog (AUTH-061) transport with a stable alertable `MISCONFIGURED` marker in prod (no throw → no caller 500s); deploy template no longer defaults prod SMTP to MailHog | AUTH-061/063 | ✅ **done** | `mailTransport.ts` (pure `devCaptureHost`/`isDevCaptureTransport`, 4 tests) + `mailer.ts` + `deploy/env.production.template`. typecheck ✓ biome ✓ tests ✓. Chose log-loud-not-throw to keep all 4 `sendAuthEmail` callers 500-safe and preserve staging MailHog capture. |
| 0.2b | Durable send: move `sendAuthEmail` onto a BullMQ `auth_email` queue (producer in apps/auth, consumer in apps/workers) — retry + DLQ + **uniform-fast response that closes the AUTH-064 timing/enumeration oracle** (inline send on the account-exists branch is still a timing oracle) | AUTH-064/061/063 | ⏸ **deferred (needs supervision)** | High blast radius on the CRITICAL auth-email send path + can't be exercised end-to-end here (no live Redis+worker+SMTP) — flipping the 4 callers from inline to a queue that may not yet be consumed risks silently stalling all auth mail. Its user-visible payoff (real delivery) is gated on 0.2c's ESP anyway. Do under review with live-infra verification, not on the autonomous timer. Clean template exists: `apps/api/src/features/import/queue.ts` (producer) + `apps/workers/src/queues/*` (consumer). Design: producer renders the template + enqueues the rendered `{to,subject,text,html}` (dev/test keeps the console path, no Redis); worker owns the nodemailer send + the `mailTransport` misconfig markers; queue name in `@leadwolf/types`. |
| 0.2c | Bounce/complaint handling for auth mail (reuse the M12 ESP webhook pattern) + a real ESP wired in deploy (needs the user's ESP choice + credentials — record as blocked-on-user) | AUTH-040/061 | ◻ todo | Deploy-config; the ESP credential is a user decision. |
| 0.3 | Extension scope enforcement: API middleware reads `claims.scope`, restricts extension-audience tokens to a prospecting allow-list, deny-by-default | AUTH-065 | ✅ **done (observe-first)** | `apps/api/src/middleware/extensionScope.ts` (pure `isExtensionToken` + method-aware `extensionRouteAllowed` allow-list + alertable `[authz] extension-scope` marker, 7 tests) wired into `authn.ts`. Discriminator = `scope.includes("extension")` (web/admin tokens carry `scope:[]` → total no-op, zero blast radius). Allow-list derived from `apps/extension/src/background` (ingest, per-contact reveal + read, credits balance/costs, me, orgs). **Ships OBSERVE-first**: out-of-scope calls are logged but ALLOWED until `EXTENSION_SCOPE_ENFORCE="true"` flips to 403 `insufficient_scope` — a config flip, not a redeploy — so a wrong allow-list can't silently 403 the live extension. typecheck ✓ biome ✓ tests 7/7 (+26 middleware regression ✓). **Follow-up (0.3b): validate the allow-list against real extension traffic, then flip the flag on.** |
| 0.4 | Deny-list observability: alert on revocation read/write failure; optional in-process fallback | AUTH-066 | ✅ **done** | `revocationLog.ts` (pure alertable `[revocation] DEGRADED` marker, 4 tests, no PII) wired into both catch paths of `revocation.ts`; per-request `check` path throttled to 1 line/10s so an outage doesn't flood logs; fail-OPEN behaviour unchanged. typecheck ✓ biome ✓ tests ✓. Optional in-process fallback cache NOT done (adds state/risk) — deferred. |
| 0.5a | Security-notification email: **password-changed** — fires on both change paths (authenticated `/account/security` change + completed forgot-password reset) | AUTH-067 | ✅ **done** | New `passwordChanged.ts` template (branded, "if this wasn't you" secure-CTA to `/auth/forgot`, 2 tests) fired DETACHED + best-effort (`void …catch`, the `void recordAuthEvent` precedent) from `reset/actions.ts` + `account/security/actions.ts:changePassword` — never fails/delays the change, failure log carries no PII. Rides the current inline `sendAuthEmail` (same path as reset/verify; the durable queue 0.2b is deferred). typecheck ✓ biome ✓ tests 6/6 ✓. |
| 0.5b-tpl | new-sign-in email **template** (device/IP context, escaped, secure CTA) | AUTH-067 | ✅ **done** | `newSignIn.ts` (+3 tests: with-context, no-context degrades cleanly, and the UA-derived device string is HTML-escaped). Presentational — the caller decides WHEN to send + formats the device string. typecheck ✓ biome ✓ tests 9/9 ✓. |
| 0.5b-wire | **Fire** new-sign-in on a real new sign-in (not every login) | AUTH-067 | ⏸ **deferred (design + gated)** | Correct architecture is EVENT-DRIVEN: `finalizeLogin` (flow.ts) already emits `login.success` for every method (password/magic/SSO) OFF the hot path — react to THAT via the events consumer (covers all methods, no login-path risk, and packages/auth can't reach the app mailer anyway) rather than firing inline from N login actions. Needs (a) a new-device heuristic so it isn't alert-fatigue spam — cheapest is a long-lived device cookie on the auth origin: absent/unknown → new device → notify + set; present → skip (no per-user store) — and (b) delivery via the mail path. So it PAIRS with 0.2b (worker/queue) + 0.2c (ESP) and wants a design pass. Do under review, NOT on the autonomous timer. |
| 0.5c | Security-notification email: **MFA-changed** (enrolled / disabled / recovery-codes regenerated) | AUTH-067 | ✅ **done** | New `mfaChanged.ts` template (3 kinds via a `MfaChangeKind` copy map, brand-correct, secure-CTA, 2 tests) fired via a shared `notifyMfaChanged(email, kind)` helper (detached + best-effort, PII-free failure log) from all three fire sites in `account/security/actions.ts`: `verifyTotpEnroll` ("enrolled"), `disableMfaMethod` ("disabled", **only when `removed>0`** — a foreign methodId stays a no-op/non-oracle), `regenerateRecoveryCodes` ("recovery_regenerated"). typecheck ✓ biome ✓ tests 7/7 ✓. Rides inline `sendAuthEmail` (delivers when 0.2c wires a real ESP). |
| 0.6a | Remove the FAKE `enrolled:false` MFA badges in apps/web SecurityPanel (stop asserting a state it can't know) | AUTH-068 | ✅ **done** | The hard-coded 5-factor catalogue rendered "Not set up" for everyone — so a user WITH two-step on saw "Not set up" (a lie). Replaced with a single honest description + the existing "Manage two-step methods" deep-link (now consistent with the Sessions/History sections, which never fake state). Removed the dead `MFA_METHODS` const, `MfaMethodStatus` type, `StatusBadge` import, and the now-unused `MfaMethodType` local import. typecheck (apps/web) ✓ biome ✓ (display-only — no unit test applies). |
| 0.6b | **Real** cross-origin MFA-status read (auth→app-API `GET enrolled-methods`) so apps/web can show true On/Off | AUTH-068 | ◻ todo | The security-reviewed endpoint (must not leak factor presence cross-tenant) + wire the panel to it. Bigger; needs an auth-origin read API + apps/web fetch. Not blocking Phase 0 exit (0.6a removed the lie). |
| 0.7a | Stop offering an **unusable** "Begin setup" to passwordless-and-factorless users + give them a real path | AUTH-069 | ✅ **done** | Pure `canStepUp({hasPassword,hasVerifiedTotp})` predicate (mirrors verifyStepUp's contract, 3 tests) drives `MfaSection`: when a user can't step up (no password, no verified TOTP) the enroll form — whose credential field asked for an authenticator code they can't have — is replaced by guidance + a "Set a password" link to the reset flow (`AUTH_BASE_PATH/forgot`, root-relative). `hasPassword` stays a server-derived boolean (passwordHash never reaches the client). typecheck ✓ biome ✓ tests 3/3 ✓. |
| 0.7b | **Direct** passwordless first-factor enrollment (fresh-proof step-up: session-freshness OR an email/OTP re-verification) so they needn't set a password first | AUTH-069 | ⏸ **deferred (needs supervision)** | The real "fresh-proof" mechanism. Session-freshness is unverifiable-here (refresh-rotation makes `createdAt`/auth-time semantics unclear — a wrong window is a lockout or a weak bootstrap); the email/OTP variant depends on the blocked mail path (0.2c). Both are security-sensitive; do under review. 0.7a already unblocks these users via the existing set-password path. NOTE: guiding an SSO-mandated user to set a local password may interact with org SSO-enforcement policy — revisit when that policy lands. |

**Phase 0 exit:** forgot-password delivers a working reset; `/account/security` reachable + usable by every user class;
extension token actually scoped; revocation outages visible.

## Phase 0 — Exit Review (2026-07-07)

All work is on `feat/auth-platform-phase0`, **committed locally, NOT pushed**. Every shipped item passed its gate
(scoped `typecheck` + `biome` + colocated `bun test`).

**Shipped — 8 items (all the safe, unblocked fixes to the reported breakage):**
| Item | AUTH | What it fixed |
|---|---|---|
| 0.1 | 062 | `/auth` basePath on every constructed reset/magic/security link (reset-link 404 + unreachable security settings) |
| 0.2a | 061/063 | Mailer flags an unset / dev-capture (MailHog) transport LOUDLY; deploy template no longer defaults prod SMTP to MailHog |
| 0.3 | 065 | Extension-scoped tokens confined to a route allow-list (observe-first behind `EXTENSION_SCOPE_ENFORCE`) |
| 0.4 | 066 | Revocation deny-list fail-open now emits a throttled, alertable `DEGRADED` marker |
| 0.5a | 067 | Password-changed security-notification email (both change paths) |
| 0.5c | 067 | MFA-changed security-notification email (enroll / disable / regenerate) |
| 0.6a | 068 | Removed the FAKE `enrolled:false` MFA badges in apps/web (stopped asserting unknown state) |
| 0.7a | 069 | Passwordless users no longer shown an unusable "Begin setup" — guided to set a password |

**⛔ Blocked on you — 1 (the single most important unblock):**
- **0.2c — a real transactional email provider (ESP) + credentials.** Until this is wired, every reset /
  verification / magic / notification email above is code-complete + tested but **does not reach inboxes**. All the
  mail work lands the moment this does. *Decision needed:* which ESP (SendGrid / Amazon SES / Resend / Postmark) and
  its credentials, injected as `SMTP_URL` (see `deploy/env.production.template`).

**⏸ Deferred for supervision — 2 (need live-infra verification; unsafe to flip on the autonomous timer):**
- **0.2b** (AUTH-064) — durable BullMQ auth-email queue (retry/DLQ + closes the inline-send timing/enumeration
  oracle). High blast radius on the critical mail path; needs live Redis + worker + SMTP to verify end-to-end.
- **0.7b** (AUTH-069) — DIRECT passwordless first-factor enrollment (fresh-proof step-up). Session-freshness
  semantics are unverifiable here (refresh-rotation); the email-OTP variant depends on 0.2c.

**⏭️ Descoped — 1:** 0.1b (edge-only redirect, marginal value — see the row).

**Remaining net-new features — 2 (enhancements, NOT fixes to the reported breakage):**
- **0.5b** (AUTH-067) — new-sign-in notification. TEMPLATE **shipped** (`newSignIn.ts`, tested). The FIRING is
  deferred (0.5b-wire): event-driven off the existing `login.success` event + a device-cookie heuristic; pairs
  with 0.2b (worker) + 0.2c (ESP). See the 0.5b-wire row.
- **0.6b** (AUTH-068) — real cross-origin MFA-status read (a security-reviewed auth→app-API endpoint that can't
  leak factor presence cross-tenant) to show true On/Off in apps/web. Not blocked on the ESP — the one remaining
  item with standalone value that can be built autonomously, but it needs a security-design pass (do design-first).

**Verdict on the three reported-broken areas:**
1. **Forgot Password** — both structural breaks fixed: the link 404 (0.1) and the silent MailHog non-delivery
   (0.2a). Actual inbox delivery is gated on 0.2c (ESP). Hardening (durable queue + timing-oracle close) is 0.2b.
2. **User Security Settings** — reachable (0.1), honest for passwordless users (0.7a), and honest about MFA state
   in apps/web (0.6a). Real cross-origin MFA status is the 0.6b enhancement.
3. **Callback URL Management** — only the **extension-token scope** slice (0.3) was in Phase 0's P0 bundle. The
   BROADER callback / redirect-URI management surface (doc 08 — registered callback URLs, OAuth client config) was
   **NOT built in Phase 0**; it is Phase-1+ work. ⚠️ If "Callback URL Management" was reported broken in a way 0.3
   doesn't cover, that needs its own audit pass — flag for the user.

**Recommended sequence:** (a) You choose an ESP → I wire **0.2c** (unblocks ALL mail, the highest-leverage move).
(b) I do **0.5b** (the last unblocked notification). (c) Confirm the Callback-URL-Management scope (⚠️ above) before
treating Phase 0 as fully closed. (d) **Phase 1** (centralized-IdP consolidation, doc 12) is a large new build — begin
only after you've reviewed this exit state. The next autonomous fire will pick up **0.5b** unless redirected.

## Phases 1–5
Not started. See [`../12_Implementation_Roadmap.md`](../12_Implementation_Roadmap.md). Do not start until Phase 0 is complete.

## Log
- **2026-07-06:** Phase 0.1 (AUTH-062) done — the basePath fix that resolves two of the three reported failures
  (forgot-password link 404 + unreachable security settings). Branch created off `main` @ 51c02ad.
- **2026-07-06:** Phase 0.2a (AUTH-061/063) done — the auth mailer no longer silently "succeeds" against an
  unset or MailHog transport; it emits a stable `[auth-mail] MISCONFIGURED …` marker (alertable) and the deploy
  template no longer defaults prod SMTP to MailHog. Log-loud-not-throw keeps all callers 500-safe. Deferred to
  0.2b: the durable queue that closes the AUTH-064 inline-send timing oracle. Also noted: `deploy/deploy.sh:63-64,121`
  still starts MailHog as local infra + prints it as "Mail" — fine for dev/preview, but the deploy narrative
  should stop presenting it as the production mail solution (fold into 0.2c). Skipped 0.1b (un-prefixed redirect,
  optional belt-and-braces) in favour of the higher-value 0.2a; it remains an optional deferred item.
- **2026-07-06:** Phase 0.2b **deferred** (see the row) — a critical-path BullMQ queue is too high-blast-radius to
  flip unverified on the autonomous timer, and its delivery payoff is gated on 0.2c's ESP. Did **Phase 0.4
  (AUTH-066)** instead: the fail-open deny-list now emits a throttled, alertable `[revocation] DEGRADED` marker
  so a Redis outage (during which revoked/deprovisioned tokens keep working to expiry) is visible to on-call —
  self-contained, near-zero blast radius, fully unit-tested. **NEXT fire: Phase 0.3 (extension scope enforcement,
  AUTH-065)** — needs the token-scope semantics read first (what scope web/admin tokens carry vs extension) so
  enforcement in `apps/api` restricts extension-audience tokens without breaking web/admin; stage observe-first.
- **2026-07-07:** Phase 0.3 (AUTH-065) done, **observe-first**. Read-first confirmed the clean discriminator:
  extension tokens carry `scope:["extension"]` (from `/auth/extension/mint`), web/admin tokens carry `scope:[]`
  (from `/token/exchange`) — so `scope.includes("extension")` gates the guard and web/admin are a pure no-op
  (near-zero blast radius). Placed the check in `authn.ts` itself → deny-by-default coverage of every authn'd
  route in one place. Allow-list built from the extension's real call surface; ships behind
  `EXTENSION_SCOPE_ENFORCE` (default OFF = observe/log-only) because the extension is a LIVE surface I can't
  exercise here and a wrong allow-list would 403 it — flipping the flag after validating traffic closes the
  hole with no redeploy. **NEXT fire: Phase 0.5 (AUTH-067, security-notification emails)** — but note it
  *depends on the 0.2 mail path*; the queue (0.2b) is deferred-for-supervision, so 0.5 would ride the current
  inline `sendAuthEmail` (acceptable — same path the reset/verify mails use). If 0.5 feels too coupled to the
  deferred queue, do 0.7 (passwordless enrollment UI) or 0.1b (un-prefixed redirect) instead. 0.6 needs the
  cross-origin enrolled-methods read (bigger). Phase 0 remaining: 0.1b, 0.2b⏸, 0.2c(blocked-on-ESP), 0.5, 0.6, 0.7.
- **2026-07-07:** Phase 0.5a (AUTH-067) done — the **password-changed** security notification. New
  `passwordChanged.ts` template (no secret, "if this wasn't you → secure your account" CTA into `/auth/forgot`)
  fired from BOTH change paths (authenticated `changePassword` + completed `completeReset`), DETACHED +
  best-effort so it never fails or delays the change (mirrors the existing `void recordAuthEvent` pattern);
  failure log is PII-free. Rides the current inline `sendAuthEmail` — so it delivers exactly when reset/verify
  mail does (i.e. once a real ESP replaces the deferred queue/ESP, 0.2c). Split the rest of AUTH-067 into 0.5b
  (new-sign-in — needs care not to spam on refresh) + 0.5c (MFA-changed — same pattern, new template).
  **NEXT fire: Phase 0.5c (MFA-changed)** — cleanest next slice (same file, same detached pattern, one new
  template); then 0.7 (passwordless enrollment UI) or 0.1b. 0.5b (new-sign-in) needs the login-finalize/device
  context; 0.6 needs the cross-origin enrolled-methods read.
- **2026-07-07:** Phase 0.7a (AUTH-069) done — the passwordless MFA bootstrap trap. Read-first found the exact
  bug: `verifyStepUp` accepts only a password OR a verified TOTP code, but enrolling the FIRST factor is itself
  step-up-gated, so a passwordless-and-factorless user saw a "Begin setup" form whose field asked for an
  authenticator code they cannot have. Fixed the UI to detect that state (pure `canStepUp` predicate) and offer
  the real, already-working path — set a password via the reset flow — instead of an unusable form. Deferred the
  DIRECT fresh-proof enrollment (0.7b): session-freshness is unverifiable on the timer (refresh-rotation) and the
  email/OTP variant is blocked on the mail path — both security-sensitive, do under review. **NEXT fire: Phase
  0.6 (AUTH-068) — the "remove the fake `enrolled:false` MFA badges in apps/web SecurityPanel" half** (safe,
  self-contained: stop rendering a hard-coded state; the real cross-origin read is the deferred half). Then 0.1b
  (un-prefixed redirect, tiny) and 0.5b (new-sign-in). Phase 0 remaining after 0.6: 0.1b, 0.2b⏸, 0.2c(ESP),
  0.5b, 0.6-real-read, 0.7b⏸ → then Phase 0 exit review.
- **2026-07-07:** Phase 0.6a (AUTH-068) done — removed the fake `enrolled:false` MFA badges from apps/web's
  SecurityPanel. The panel hard-coded a 5-factor catalogue all showing "Not set up", so a user who actually had
  two-step enabled (on the auth origin) was told they had none — a trust-eroding lie the panel had no data to
  make. Replaced it with a single honest description + the existing manage deep-link, matching the panel's own
  Sessions/History sections (which correctly assert no state). Removed the dead `MFA_METHODS`/`MfaMethodStatus`/
  `StatusBadge`/`MfaMethodType`-import. The real cross-origin status read is split out as 0.6b (needs a
  security-reviewed auth→app-API endpoint that can't leak factor presence cross-tenant). **NEXT fire: 0.1b
  (un-prefixed `/account/security` redirect, belt-and-braces) — the last safe Phase-0 fix — then a Phase 0
  exit-review summary** (shipped vs deferred vs blocked) before touching Phase 1. Everything left in Phase 0 is
  either deferred-for-supervision (0.2b, 0.7b), blocked-on-ESP (0.2c), or a net-new feature (0.5b, 0.6b).
- **2026-07-07:** Phase 0.1b **descoped** (see the row) — architecturally edge-only (basePath hides un-prefixed
  paths from the app middleware) + high-blast-radius on prod TLS config + marginal value; left a safe supervised
  Caddy recipe. That was the last "safe fix" slot, so wrote the **Phase 0 — Exit Review** above (8 shipped, 1
  blocked-on-ESP, 2 deferred-for-supervision, 1 descoped, 2 net-new remaining). All three reported-broken areas
  addressed in code, with two honest caveats surfaced to the user: (1) mail delivery is gated on the ESP choice
  (0.2c), and (2) "Callback URL Management" was only covered by the extension-scope slice (0.3) — the broader
  redirect-URI surface (doc 08) is Phase-1+ and may need its own audit if it was the reported break. **NEXT fire:
  0.5b (new-sign-in notification)** — the last unblocked item — unless the user redirects toward the ESP wiring
  (0.2c) or Phase 1.
- **2026-07-07:** Phase 0.5b — shipped the **template** (`newSignIn.ts` + 3 tests), **deferred the wiring**
  (0.5b-wire) with a concrete event-driven design (react to the existing `login.success` event + a device-cookie
  new-device heuristic; pairs with 0.2b/0.2c). This was the last "unblocked" item, and its only genuinely-safe,
  self-contained slice was the template — the firing is a login-hot-path + heuristic change whose user value is
  gated on the ESP anyway. **⚑ Phase 0's safe autonomous work is now COMPLETE.** Everything left is: blocked-on-you
  (0.2c ESP), deferred-for-supervision (0.2b, 0.7b, 0.5b-wire), descoped (0.1b), or a security-reviewed net-new
  feature (0.6b). **NEXT fire: begin 0.6b (real cross-origin MFA-status read) DESIGN-FIRST** — it's the one
  remaining item with standalone value that isn't ESP-blocked; I'll draft the endpoint's cross-tenant-safe
  contract before writing code. But the highest-leverage action is still yours: **pick an ESP (0.2c)** to make all
  the shipped mail actually deliver, and give a **go/no-go on Phase 1** (the large centralized-IdP build).
- **2026-07-07:** Phase 0.5c (AUTH-067) done — the **MFA-changed** security notification (enrolled / disabled /
  recovery-regenerated). One `mfaChanged.ts` template with a per-kind copy map + a shared `notifyMfaChanged`
  helper (same detached best-effort pattern as 0.5a) fired from all three MFA mutators in
  `account/security/actions.ts`; the disable path notifies only on a real removal (no foreign-id oracle). With
  0.5a + 0.5c done, **AUTH-067 is substantially covered** — only 0.5b (new-sign-in) remains, and it's the odd
  one out (needs the login-finalize/device context + a "new device" heuristic to avoid notifying on every
  refresh). **NEXT fire: Phase 0.7 (AUTH-069, passwordless enrollment + hide the unusable "Begin setup")** —
  self-contained in the account/security surface, no external dep; then 0.1b (un-prefixed redirect, small) and
  0.5b. Remaining after 0.7: 0.1b, 0.2b⏸, 0.2c(ESP), 0.5b, 0.6. Then Phase 0 exit review.
