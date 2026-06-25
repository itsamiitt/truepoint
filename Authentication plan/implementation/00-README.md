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
| [`P0-01`](P0-01-pretenant-auth-audit-events.md) | Pre-tenant auth audit events (`password.reset.*`, +the tenant-less class) | P0 | **Ready** | Unblocks the `passwordReset.ts` TODOs. Prereq: accept ADR-0032. |
| [`P0-02`](P0-02-password-policy-and-breach-screening.md) | Enforced password policy + breached-password screening | P0 | **Ready** | NIST SP 800-63B-4 SHALL. New outbound dep (HIBP range API) → SSRF/k-anonymity rules apply. |
| [`P1-01`](P1-01-auth-policy-enforcement.md) | Auth-policy **enforcement** on login (MFA-required enrollment, allowed-methods, IP allowlist, session timeout) | P1 | **Ready** | Highest-risk: lockout-capable. Every gate ships behind a per-tenant default-off flag + break-glass. |
| [`P1-02`](P1-02-account-security-ui.md) | `/account/security` user self-service UI (password, MFA enroll, own sessions, login history) | P1 | **Ready** | Builds the Absent route on the auth origin. WCAG 2.2 AA + i18n are ship gates. |
| [`P1-03`](P1-03-workspace-members-api.md) | Workspace **Members** API (invite / role / remove) | P1 | **Ready** | Mirrors the shipped Sessions API; closest to shovel-ready. Wires `member.*` audit. |
| `P2-01` | Real OIDC (`arctic`) + SAML (`@node-saml`) adapters | P2 | _Outlined_ | Security ACs are the gate — see [`09-threat-model.md`](../09-threat-model.md). XL. |
| `P2-02` | SCIM 2.0 endpoints + deprovisioning | P2 | _Outlined_ | XL. Deprovision race bound — see `09`. |

P0 and P1 are specced and apply-ready; P2 (real OIDC/SAML adapters, SCIM 2.0 + deprovisioning) is outlined in
the plan (`08-roadmap.md`, `09-threat-model.md`) and will be turned into apply-ready specs on request — those
are XL items whose security acceptance criteria (anti-XXE/anti-wrapping SAML, SSRF, deprovision race) are the
gate.

## Already done in this environment (inspection-verified, no gates needed)

- **6 open decisions recorded** (docs 01/06/08/11; register shows 0 open).
- **AUTH-015 near-term action implemented:** the dead `/oauth/google` "Continue with Google" button removed from
  `apps/auth/src/app/login/page.tsx` (orphaned `Button`/`Separator` imports + `oauthHref` cleaned up). This is a
  pure-UI removal with no tenancy/RLS surface — still run `bun run typecheck` + `biome check` before commit.

## Prerequisite decision that gates P0-01

**Accept ADR-0032** (`docs/planning/decisions/ADR-0032-platform-audit-action-vocabulary.md`, currently
`Status: Proposed`). ADR-0031 (the routing split) is already **Accepted**; ADR-0032 defines the
`platform_audit_action` vocabulary that the tenant-less events need. It is fully designed; accepting it is the
one decision blocking P0-01. The spec includes the exact status edit + decision-log row.
