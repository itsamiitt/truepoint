# ADR-0031 — Auth-event audit tenancy

- **Status:** Accepted
- **Date:** 2026-06-15
- **Context doc:** [03-database-design.md](../03-database-design.md), [08-compliance.md](../08-compliance.md), [17-authentication.md](../17-authentication.md), [audit-log-enum.md](../audit-log-enum.md)
- **Relates to:** [ADR-0019](./ADR-0019-global-identity-and-tenant-membership.md) (global identity — the root cause), [ADR-0011](./ADR-0011-platform-admin-and-privileged-access.md) (`platform_audit_log`)

## Context

The closed `audit_log.action` enum already defines **20 auth events** (`login.*`, `mfa.*`,
`password.reset.*`, `sso.*`, `token.*`, `device.*`, `session.revoked`, `code.*`, `signup`, `oauth.link` —
[17 §9](../17-authentication.md), [08 §5](../08-compliance.md)). **None are written today**
([audit-log-enum.md §5.2](../audit-log-enum.md); two `// TODO … when the auth audit sink lands` markers in
`packages/auth/src/passwordReset.ts`). Wiring them collides with three facts:

1. **`audit_log.tenant_id` is `NOT NULL`** ([03 §7](../03-database-design.md); `schema/billing.ts`) and RLS
   is `WITH CHECK (tenant_id = current_setting('app.current_tenant_id'))` ([03 §9](../03-database-design.md);
   `rls/billing.sql`). Every row must name exactly one tenant whose session GUC is set.
2. **Global identity** ([ADR-0019](./ADR-0019-global-identity-and-tenant-membership.md)): a user belongs to
   0..N tenants and **authenticates before choosing an org**. So `login.failure` (unknown email),
   `password.reset.request`, `mfa.challenge`, and `signup` (before the org row exists) have **no resolvable
   tenant**; successful events resolve a tenant only at finalize.
3. **No ambient transaction in `packages/auth`**: its repositories run on the bare auth-service connection
   and don't thread a `Tx`, and `packages/auth` cannot import `@leadwolf/core`'s `writeAudit` (dependency
   graph). It *can* use `@leadwolf/db`'s `auditRepository` + `withTenantTx` directly, but the write is
   necessarily **best-effort / own-transaction** (observational; must never throw into the auth flow), not
   same-tx-atomic like the reveal/compliance path ([14 §2](../14-phase-1-execution.md)).

Net: the corpus places auth events on the tenant-scoped `audit_log`, but `NOT NULL` tenant + the pre-tenant
reality make a chunk of them un-writable as-is. This must be reconciled **before** the auth sink is wired —
it touches the schema/RLS contract (H1/H9), so it is an ADR-level call, not an ad-hoc fix.

## Decision

A **split by tenant-resolvability**, with **no change to the `audit_log` `NOT NULL` + RLS invariant**.
Wiring is **phased**: the tenant-resolved events are wired now; the tenant-less events wait for
`platform_audit_log` (the admin track) and the OQ-D vocabulary.

1. **Auth audit sink** — add `packages/auth/src/auditEvent.ts` (`recordAuthEvent`), wrapping
   `@leadwolf/db`'s `auditRepository.insert` inside its own `withTenantTx`, **swallow-on-failure**, invoked
   from the `apps/auth` edge where `ip`/`ua`/`origin` + the resolved tenant are in hand. `entityType:'user'`,
   `entityId:userId`; non-uuid handles (sessionId, jti, method, reason) go in `metadata`; never log
   codes/tokens/PII.
2. **Tenant-resolved events → `audit_log`** under the resolved tenant (the ~9 that satisfy `NOT NULL`):
   `login.success`, `mfa.success`, `mfa.failure`, `sso.initiated`, `sso.callback`, `code.issued`,
   `code.exchanged`, `token.issued`, `signup` (written after `provisionNewOrg`), and
   `password.reset.complete` when a single tenant resolves.
3. **Tenant-less events → `platform_audit_log`** (the existing tenant-independent immutable log,
   [ADR-0011](./ADR-0011-platform-admin-and-privileged-access.md)): `login.failure` (unknown/uniform),
   `password.reset.request`, `mfa.challenge`, and any pre-org event. This **requires defining
   `platform_audit_log`'s action vocabulary** (currently unspecified — **OQ-D**), so this ADR is coupled to
   that decision.
4. **Non-enumeration preserved** ([ADR-0020](./ADR-0020-existence-revealing-identifier-first-and-registration.md)):
   unknown-account failures log a salted hash of the identifier with **no** `actorUserId` and reveal nothing
   about existence.
5. **Volume:** `token.refresh` (every silent refresh) is **excluded** from `audit_log` — too high-volume for
   a compliance audit (cf. the OQ-B send-volume reasoning); revisit if a security-events stream is added.
6. **Blocked-no-service** (no flow exists yet): `login.locked`, `token.revoke`, `session.revoked`,
   `device.trusted`, `device.revoked`, `oauth.link` — stay PENDING until those flows are built.

## Rationale

Keeps the load-bearing `audit_log` tenant invariant (H1/H9) untouched, honors the corpus placement of
resolved auth events on the tenant log ([17 §9](../17-authentication.md)), and routes genuinely tenant-less
identity events to the log that is *designed* to be tenant-independent
([ADR-0011](./ADR-0011-platform-admin-and-privileged-access.md)) rather than weakening the RLS contract for
every audit row. It unblocks the majority of the 20 events without a risky schema change.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Split: resolved→`audit_log`, tenant-less→`platform_audit_log`** (this ADR) | Chosen | No `audit_log` contract change; each event lands in the right log; bounded follow-on (define `platform_audit_log` vocab, OQ-D). |
| Reserved "system" tenant UUID for tenant-less rows on `audit_log` | Rejected | Pollutes tenant-scoped exports with a sentinel tenant; needs BYPASSRLS to write; semantically wrong. |
| Make `audit_log.tenant_id` nullable + relax the RLS `WITH CHECK` | Rejected | Weakens the H9 fail-closed RLS invariant for *every* audit row to serve a minority of events; high blast radius. |
| Defer all auth-event auditing | Rejected | Leaves the [02 §6](../02-architecture.md) contract unmet for the entire auth surface and the `passwordReset.ts` TODO open indefinitely. |

## Consequences

- **Positive:** unblocks ~9 auth events immediately; preserves the `NOT NULL` + RLS invariant; clarifies that
  identity events are not tenant data.
- **Negative / coupling:** depends on resolving **OQ-D** (`platform_audit_log` action vocabulary — proposed in [ADR-0032](./ADR-0032-platform-audit-action-vocabulary.md)); auth audit
  writes are best-effort (a failed audit insert is swallowed — acceptable for observational events, but auth
  audit is therefore not transactionally guaranteed like the reveal/compliance path).
- **On acceptance (wiring):** add the `00 §7` decision-log row + the tripod; implement `recordAuthEvent` +
  the `apps/auth` call-sites; flip the wired events PENDING→WRITTEN in
  [audit-log-enum.md §5](../audit-log-enum.md) **and** in `packages/types/src/auditCoverage.test.ts` (the
  drift guard fails until both move together); define + extend `platform_audit_log`'s vocabulary; add the
  exercised-writer coverage per [audit-log-enum.md §8](../audit-log-enum.md).

## Revisit if

A dedicated high-volume **security-events stream** is introduced (then `login.failure` / `token.refresh` /
lockout move there), or the tenancy model changes so identity events gain a natural single tenant.
