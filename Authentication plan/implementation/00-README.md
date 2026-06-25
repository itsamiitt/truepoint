# Authentication Plan — Implementation Specs

Ready-to-apply specs derived from the plan, written so an engineer (or an agent in a `bun`-capable
environment) can **apply them and run the gates**. They were authored in an environment **without `bun`/`node`**,
so none of this code has been executed — every spec ends with the exact gate commands to run before commit.

> **Mandatory gates (run for every spec before committing):**
> `bun run typecheck` · `biome check` (and `biome format`) · `bun run lint:boundaries` · the named unit/itests.
> Security-touching specs additionally require the relevant isolation test to stay green
> (e.g. `bun test packages/db/test/platformAuditLog.itest.ts`).

## How to read a spec

Each spec has: **Goal**, **Prerequisite decisions**, **Accepted design** (what ADR/section it implements),
**Changes** (file-by-file, with code), **Tests**, **Security checklist** (the truepoint-security threat
checklist, answered), and **Gates**. Code blocks are accurate to the conventions found in source; any spot not
verified against a live signature is marked `‹confirm›`.

## Wave status

| Spec | Item | Wave | Status | Notes |
|------|------|------|--------|-------|
| [`P0-01`](P0-01-pretenant-auth-audit-events.md) | Pre-tenant auth audit events (`password.reset.*`, +the tenant-less class) | P0 | **Code written — run gates** | Implemented across types/db/auth/apps; ADR-0032 accepted; reviewed against source. Run the gates + add the reset-audit itest. |
| [`P0-02`](P0-02-password-policy-and-breach-screening.md) | Enforced password policy + breached-password screening | P0 | **Code written — run gates** | Server-side gate (12-char floor + HIBP k-anonymity, fail-open) in registration + reset; edges map rejections. Reviewed against source. Follow-up: tighten `signupSchema` to `.min(12).max(128)`; optional `BREACH_CHECK_ENABLED` env flag. |
| [`P1-01`](P1-01-auth-policy-enforcement.md) | Auth-policy **enforcement** on login (IP allowlist, session timeout, allowed-methods, forced MFA enrollment) | P1 | **Code written — run gates** | Gates B (allowed-methods, via a txn `method` set at the 4 edges) + C (IP allowlist) + D (session timeout) + sub-gate A (forced in-login MFA enrollment → `/mfa/enroll`), **all behind `AUTH_POLICY_ENFORCEMENT_ENABLED` (default OFF = no-op)**; CIDR + cap-math unit tests; both increments reviewed (OFF-by-default proven byte-for-byte; the `mfa_required` backstop unchanged when OFF). **Deferred:** per-tenant flags + break-glass, idle timeout, `require_sso` (waits for P2 adapters), `mfa.enroll` audit enum. |
| [`P1-02`](P1-02-account-security-ui.md) | `/account/security` user self-service UI (password, MFA enroll, own sessions, login history) | P1 | **Code written — run gates + browser** | New `requireUser` auth-origin gate; 4 sections + TOTP enroll + one-time recovery codes + own-session revoke; reuses crypto/session primitives; step-up + rate-limit; reviewed clean (auth gate, scoping, `@oslojs` sigs, CSP all verified). **Needs a browser** for QR/render/axe. Follow-ups: visual QR `<img>`, passwordless step-up, `mfa.*` audit enum, `SecurityPanel` live read. |
| [`P1-03`](P1-03-workspace-members-api.md) | Workspace **Members** API (invite / role / remove) | P1 | **Code written — run gates** | types→core→api mirroring the Sessions routes; matches the live `MembersPanel` contract (`/current/members`); `member.*` audit wired (PENDING→WRITTEN). Reviewed (3 defects fixed). Follow-up: wire the invite email send (no mailer in apps/api). |
| `P2-01` | Real OIDC (`arctic`) + SAML (`@node-saml`) adapters | P2 | **Blocked — gated env** | `arctic`/`@node-saml` are **not installed** (no `package.json`/`node_modules` entry), so the adapters can't be wired or verified here. SAML validation is the **Critical** threat (`09` §SAML) — must be built where its anti-XXE/anti-wrapping/reject-unsigned negative-test suite runs. Hand-off: the spec + `09`. |
| `P2-02` | SCIM 2.0 endpoints + deprovisioning | P2 | **Code written — run gates** | `/scim/v2/Users` (list/get/POST/PUT/PATCH/DELETE) behind `scim_tokens` bearer auth; tenant-isolated; **deprovision (`active:false`/DELETE) flips membership + `revokeAllSessionsForUser`**; safe equality-filter parser; `member.*` audit; isolation itest. Reviewed (tenant isolation + deprovision-revokes-access verified; 2 defects fixed). No external lib. |

P0 and P1 are specced and apply-ready; P2 (real OIDC/SAML adapters, SCIM 2.0 + deprovisioning) is outlined in
the plan (`08-roadmap.md`, `09-threat-model.md`) and will be turned into apply-ready specs on request — those
are XL items whose security acceptance criteria (anti-XXE/anti-wrapping SAML, SSRF, deprovision race) are the
gate.

## Already done in this environment (inspection-verified, no gates needed)

- **6 open decisions recorded** (docs 01/06/08/11; register shows 0 open).
- **AUTH-015 near-term action implemented:** the dead `/oauth/google` "Continue with Google" button removed from
  `apps/auth/src/app/login/page.tsx` (orphaned `Button`/`Separator` imports + `oauthHref` cleaned up). This is a
  pure-UI removal with no tenancy/RLS surface — still run `bun run typecheck` + `biome check` before commit.

## P0-01 status — implemented (gates pending)

**Done in code** (reviewed against source). ADR-0032 is now **Accepted**. The change spans:
`packages/types/src/platformAudit.ts` (new `platformAuditAction` enum) + `platformAuditCoverage.test.ts`;
`packages/db` `recordPlatformEvent` sink (`client.ts` + `index.ts`); `packages/auth` `recordPlatformAuthEvent`
(`auditEvent.ts`) + the `password.reset.*` wiring (`passwordReset.ts`); `apps/auth` threads `ip`
(`reset/actions.ts`); `auditCoverage.test.ts` moves `password.reset.complete` to WRITTEN.

**Before it ships, run the gates** (no `bun` in the authoring env):
`bun run typecheck` · `biome check` · `bun run lint:boundaries` ·
`bun test packages/types/src/auditCoverage.test.ts packages/types/src/platformAuditCoverage.test.ts` ·
`bun test packages/db/test/platformAuditLog.itest.ts`.

**Follow-ups** (do alongside the gates, non-blocking): add a reset-audit integration test (request emits one
tenant-less `platform_audit_log` row for a known email and **none** for an unknown one; complete writes
`audit_log` for a single-tenant user and `platform_audit_log` otherwise; a forced audit failure never breaks
the reset); flip `password.reset.complete` to WRITTEN in `docs/planning/audit-log-enum.md §5`; add the
`platform_audit_log.action` DB `CHECK` with the apps/admin track (ADR-0032 §5).
