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
| 0.2b | Durable send: move `sendAuthEmail` onto a BullMQ `auth_email` queue (producer in apps/auth, consumer in apps/workers) — retry + DLQ + **uniform-fast response that closes the AUTH-064 timing/enumeration oracle** (inline send on the account-exists branch is still a timing oracle) | AUTH-064/061/063 | ◻ **next** | The "L" core. Needs a Redis producer in apps/auth + a worker queue. Read truepoint-platform async-jobs first. |
| 0.2c | Bounce/complaint handling for auth mail (reuse the M12 ESP webhook pattern) + a real ESP wired in deploy (needs the user's ESP choice + credentials — record as blocked-on-user) | AUTH-040/061 | ◻ todo | Deploy-config; the ESP credential is a user decision. |
| 0.3 | Extension scope enforcement: API middleware reads `claims.scope`, restricts extension-audience tokens to a prospecting allow-list, deny-by-default | AUTH-065 | ◻ todo | `apps/api/src/middleware/authn.ts` + a scope map. Stage in observe mode first. |
| 0.4 | Deny-list observability: alert on revocation read/write failure; optional in-process fallback | AUTH-066 | ◻ todo | `packages/auth/src/revocation.ts` + metric/log. |
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
