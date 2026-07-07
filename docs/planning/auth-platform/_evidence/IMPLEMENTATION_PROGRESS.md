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
| 0.1b | Redirect from the un-prefixed `/account/security` etc. (belt-and-braces) — optional | AUTH-062 | ⏳ next | apps/auth middleware or a redirect route; low priority (links are the real break, now fixed) |
| 0.2a | Transport-visibility hardening: mailer flags an unset (AUTH-063) or dev-capture/MailHog (AUTH-061) transport with a stable alertable `MISCONFIGURED` marker in prod (no throw → no caller 500s); deploy template no longer defaults prod SMTP to MailHog | AUTH-061/063 | ✅ **done** | `mailTransport.ts` (pure `devCaptureHost`/`isDevCaptureTransport`, 4 tests) + `mailer.ts` + `deploy/env.production.template`. typecheck ✓ biome ✓ tests ✓. Chose log-loud-not-throw to keep all 4 `sendAuthEmail` callers 500-safe and preserve staging MailHog capture. |
| 0.2b | Durable send: move `sendAuthEmail` onto a BullMQ `auth_email` queue (producer in apps/auth, consumer in apps/workers) — retry + DLQ + **uniform-fast response that closes the AUTH-064 timing/enumeration oracle** (inline send on the account-exists branch is still a timing oracle) | AUTH-064/061/063 | ⏸ **deferred (needs supervision)** | High blast radius on the CRITICAL auth-email send path + can't be exercised end-to-end here (no live Redis+worker+SMTP) — flipping the 4 callers from inline to a queue that may not yet be consumed risks silently stalling all auth mail. Its user-visible payoff (real delivery) is gated on 0.2c's ESP anyway. Do under review with live-infra verification, not on the autonomous timer. Clean template exists: `apps/api/src/features/import/queue.ts` (producer) + `apps/workers/src/queues/*` (consumer). Design: producer renders the template + enqueues the rendered `{to,subject,text,html}` (dev/test keeps the console path, no Redis); worker owns the nodemailer send + the `mailTransport` misconfig markers; queue name in `@leadwolf/types`. |
| 0.2c | Bounce/complaint handling for auth mail (reuse the M12 ESP webhook pattern) + a real ESP wired in deploy (needs the user's ESP choice + credentials — record as blocked-on-user) | AUTH-040/061 | ◻ todo | Deploy-config; the ESP credential is a user decision. |
| 0.3 | Extension scope enforcement: API middleware reads `claims.scope`, restricts extension-audience tokens to a prospecting allow-list, deny-by-default | AUTH-065 | ✅ **done (observe-first)** | `apps/api/src/middleware/extensionScope.ts` (pure `isExtensionToken` + method-aware `extensionRouteAllowed` allow-list + alertable `[authz] extension-scope` marker, 7 tests) wired into `authn.ts`. Discriminator = `scope.includes("extension")` (web/admin tokens carry `scope:[]` → total no-op, zero blast radius). Allow-list derived from `apps/extension/src/background` (ingest, per-contact reveal + read, credits balance/costs, me, orgs). **Ships OBSERVE-first**: out-of-scope calls are logged but ALLOWED until `EXTENSION_SCOPE_ENFORCE="true"` flips to 403 `insufficient_scope` — a config flip, not a redeploy — so a wrong allow-list can't silently 403 the live extension. typecheck ✓ biome ✓ tests 7/7 (+26 middleware regression ✓). **Follow-up (0.3b): validate the allow-list against real extension traffic, then flip the flag on.** |
| 0.4 | Deny-list observability: alert on revocation read/write failure; optional in-process fallback | AUTH-066 | ✅ **done** | `revocationLog.ts` (pure alertable `[revocation] DEGRADED` marker, 4 tests, no PII) wired into both catch paths of `revocation.ts`; per-request `check` path throttled to 1 line/10s so an outage doesn't flood logs; fail-OPEN behaviour unchanged. typecheck ✓ biome ✓ tests ✓. Optional in-process fallback cache NOT done (adds state/risk) — deferred. |
| 0.5 | Security-notification emails (password-changed / new-sign-in / MFA-changed), queued | AUTH-067 | ◻ todo | New templates in `apps/auth/src/lib/emails/` + fire from actions. Depends on 0.2 queue. |
| 0.6 | In-product true MFA state (or remove fake `enrolled:false` badges) | AUTH-068 | ◻ todo | Needs the security-reviewed cross-origin enrolled-methods read, or drop badges. |
| 0.7 | Passwordless enrollment path (fresh-proof step-up) + hide unusable "Begin setup" | AUTH-069 | ◻ todo | `apps/auth/src/app/account/security/stepUp.ts` + MfaSection UI. |

**Phase 0 exit:** forgot-password delivers a working reset; `/account/security` reachable + usable by every user class;
extension token actually scoped; revocation outages visible.

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
