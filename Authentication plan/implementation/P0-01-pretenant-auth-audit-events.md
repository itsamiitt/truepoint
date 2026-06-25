# P0-01 — Pre-tenant auth audit events (`password.reset.*` and the tenant-less class)

## Goal

Wire the two `// TODO … emit password.reset.* audit events …` markers in
`packages/auth/src/passwordReset.ts:31,73` (and unblock the rest of the pre-tenant auth-event class:
`login.failure`, `mfa.challenge/success/failure`), implementing the **already-accepted** routing of
[ADR-0031](../../docs/planning/decisions/ADR-0031-auth-event-audit-tenancy.md) and the **proposed** vocabulary
of [ADR-0032](../../docs/planning/decisions/ADR-0032-platform-audit-action-vocabulary.md).

## Why it isn't a one-liner

`recordAuthEvent` (`packages/auth/src/auditEvent.ts`) writes the **tenant-scoped** `audit_log` via
`withTenantTx({ tenantId })` — and `audit_log.tenant_id` is `NOT NULL` with a `WITH CHECK` RLS policy. But
password reset runs on the **global identity before any org is chosen** (ADR-0019), so `password.reset.request`
has no resolvable tenant. ADR-0031 resolves this by **splitting** events:

- **Tenant-resolved** → `audit_log` (via `recordAuthEvent`).
- **Tenant-less** → `platform_audit_log` (the existing tenant-independent, append-only log).

Per ADR-0031 §2–§3: `password.reset.request` → `platform_audit_log` (always tenant-less);
`password.reset.complete` → `audit_log` **when a single tenant resolves**, else → `platform_audit_log`.

## Prerequisite decisions

1. **Accept ADR-0032** — `docs/planning/decisions/ADR-0032-platform-audit-action-vocabulary.md`:
   change `- **Status:** Proposed` → `- **Status:** Accepted` and add `- **Accepted:** <date>`. Add the
   `00 §7` decision-log row per the repo's ADR convention ("the tripod": decision-log row + ADR status + the
   doc update in `audit-log-enum.md §5/§9.1`).
2. No schema migration is required for the table itself — `platform_audit_log` already exists
   (`packages/db/src/rls/platform.sql:16-27`) with `action text NOT NULL` (free-text today). The
   `platform_audit_action` **CHECK** constraint is optional in this spec (ADR-0032 §5 lands it "with the
   `apps/admin` track"); the Zod enum below is the enforced contract at the type boundary now.

## Accepted design (what this implements)

| Event | Sink | Tenant | Actor |
|-------|------|--------|-------|
| `password.reset.request` | `platform_audit_log` | none | `user.id` when the account exists; **no row** for an unknown email (non-enumeration, ADR-0031 §4) |
| `password.reset.complete` | `audit_log` if the user has exactly **one** active tenant; else `platform_audit_log` | resolved or none | `user.id` |

Both are **best-effort / swallow-on-failure** (observational; must never throw into the auth flow — ADR-0031 §1).
Never pass the reset code, token, or any PII into `metadata`.

## Changes (file-by-file)

### 1. `packages/types/src/platformAudit.ts` *(new)* — the platform vocabulary

```ts
// platformAudit.ts — the closed action vocabulary for platform_audit_log (ADR-0032). SEPARATE from the
// tenant audit_log `auditAction` enum so staff-only + tenant-less identity values never leak into a tenant's
// DSAR/export. Mirrors audit_log's dotted convention.
import { z } from "zod";

export const platformAuditAction = z.enum([
  // staff / admin actions (ADR-0011, ADR-0032 §3)
  "tenant.suspend",
  "tenant.reactivate",
  "credit.grant",
  "plan.override",
  "impersonation.start",
  "impersonation.end",
  "feature_flag.set",
  "provider_config.update",
  "audit.export",
  "staff.login",
  "staff.login.failure",
  // tenant-less identity events routed here by ADR-0031 §3
  "login.failure",
  "mfa.challenge",
  "mfa.success",
  "mfa.failure",
  "password.reset.request",
  "password.reset.complete",
]);
export type PlatformAuditAction = z.infer<typeof platformAuditAction>;
```

Export it from `packages/types/src/index.ts` (mirror how `auditAction` is exported).

### 2. `packages/db` — the best-effort platform sink

`withPlatformTx` (`packages/db/src/client.ts:94-110`) is the **staff** path: it requires a `PlatformActor`,
writes the audit row in the **same transaction** as the staff action, and must sit behind a verified `pa`
claim. Auth events need a **lighter, observational** sink that owns its transaction and never throws. Add it
next to `withPlatformTx`:

```ts
// recordPlatformEvent — best-effort writer for tenant-less identity events (ADR-0031 §3 / ADR-0032). Own
// transaction on the owner connection (same connection withPlatformTx uses, so RLS-exempt as the table owner);
// SWALLOW-ON-FAILURE — an audit miss must never break auth. NOT for staff actions (those use withPlatformTx,
// which writes in the action's tx). Never pass codes/tokens/PII in metadata.
export interface PlatformEventInput {
  actorUserId?: string | null; // null = unknown/system (e.g. login.failure for an unknown email)
  action: PlatformAuditAction;
  targetType?: string | null;
  targetId?: string | null;
  tenantId?: string | null; // a *reference* (e.g. a staff action's target), NOT the RLS scope
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordPlatformEvent(entry: PlatformEventInput): Promise<void> {
  try {
    await db.transaction((tx) =>
      tx.execute(
        sql`INSERT INTO platform_audit_log
              (actor_user_id, action, target_type, target_id, tenant_id, ip, metadata)
            VALUES (${entry.actorUserId ?? null}::uuid, ${entry.action}, ${entry.targetType ?? null},
                    ${entry.targetId ?? null}, ${entry.tenantId ?? null}::uuid, ${entry.ip ?? null},
                    ${entry.metadata ? JSON.stringify(entry.metadata) : null}::jsonb)`,
      ),
    );
  } catch (err) {
    // observational: log the action only — never the actor/identifiers/PII or the stack. ‹confirm the
    // packages/db logger; if none, use the same minimal structured warn pattern as auditEvent.ts›
    logDbWarn("platform_audit.write.failed", { action: entry.action, err: err instanceof Error ? err.name : "unknown" });
  }
}
```

Import `platformAuditAction`/`PlatformAuditAction` from `@leadwolf/types`, and export `recordPlatformEvent` +
`PlatformEventInput` from `packages/db/src/index.ts`. (`audit_log_action` validation already happens in
`auditRepository.insert`; here, type the `action` param as `PlatformAuditAction` so a bad value fails at
compile time. Optionally add a runtime `platformAuditAction.parse(entry.action)` before the insert for
defence-in-depth, given the column has no CHECK yet.)

### 3. `packages/auth/src/auditEvent.ts` — the auth wrapper

Keep `packages/auth` as the only place `apps/auth` imports auth concerns from. Add:

```ts
import { recordPlatformEvent } from "@leadwolf/db";
// ...
// Tenant-less auth identity events (ADR-0031 §3) → platform_audit_log. Best-effort; recordPlatformEvent
// already swallows, so this never throws into the auth flow either.
export async function recordPlatformAuthEvent(entry: {
  action: "login.failure" | "mfa.challenge" | "mfa.success" | "mfa.failure" | "password.reset.request" | "password.reset.complete";
  actorUserId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  await recordPlatformEvent({ ...entry, targetType: "user", targetId: entry.actorUserId ?? null });
}
```

Export it from `packages/auth/src/index.ts`.

### 4. `packages/auth/src/passwordReset.ts` — emit the events

Replace the two TODO markers. `requestPasswordReset` already has `user` + `input.ipAddress`.
`completePasswordReset` needs `ip` (add an optional field) and must resolve the user's active tenants for the
single-tenant rule.

```ts
// requestPasswordReset — after resolving `user`, before/after creating the verification:
if (user) {
  await recordPlatformAuthEvent({
    action: "password.reset.request",
    actorUserId: user.id,
    ip: input.ipAddress ?? null,
  });
}
// (no event for a non-existent account — preserves non-enumeration, ADR-0031 §4)
```

```ts
// completePasswordReset — add `ipAddress?: string` to CompletePasswordResetInput; after revokeAllSessionsForUser:
const tenants = await workspaceRepository.‹orgsForUser›(user.id); // active tenants; query exists at workspaceRepository.ts:105-116 — ‹confirm the public method name›
if (tenants.length === 1) {
  await recordAuthEvent({
    tenantId: tenants[0].tenantId,
    actorUserId: user.id,
    action: "password.reset.complete",
    entityType: "user",
    entityId: user.id,
    ipAddress: input.ipAddress ?? null,
  });
} else {
  await recordPlatformAuthEvent({
    action: "password.reset.complete",
    actorUserId: user.id,
    ip: input.ipAddress ?? null,
  });
}
```

`recordAuthEvent`'s `AuditEntryInput` is `{ tenantId, workspaceId?, actorUserId?, action, entityType, entityId?,
metadata?, ipAddress?, userAgent?, originDomain? }` (`packages/db/src/repositories/auditRepository.ts:54-64`) —
`action` is typed `AuditAction`, and `password.reset.complete` is already a member (`billing.ts:121`), so it
type-checks. Both calls are `await`ed (the sinks swallow, so they cannot break the flow) and add negligible
latency; if measured latency matters, switch to `void` fire-and-forget, matching `flow.ts:217`.

### 5. `packages/auth/src/app/reset/actions.ts` (`apps/auth`) — thread `ip`

`completePasswordReset` is called at `apps/auth/src/app/reset/actions.ts:47`; the action already computes `ip`
(it passes it to `recordCredentialFailure`). Pass it through:
`await completePasswordReset({ email, code, newPassword: password, ipAddress: ip })`.

### 6. Coverage bookkeeping (the drift guards — both must move together or the test fails)

- `packages/types/src/auditCoverage.test.ts`: move `"password.reset.complete"` from `PENDING` → `WRITTEN`
  (it now has a writer on the tenant-resolved path). **Leave** `"password.reset.request"` in `PENDING` — it is
  defined in the tenant `auditAction` enum but is intentionally routed to `platform_audit_log`, never
  `audit_log`; keep the existing "pre-tenant (→ platform_audit_log)" note (line 90-91).
- `packages/types/src/platformAuditCoverage.test.ts` *(new)*: mirror `auditCoverage.test.ts` for
  `platformAuditAction` — classify `password.reset.request`, `password.reset.complete` as WRITTEN (to
  `platform_audit_log`); the staff actions + remaining tenant-less events as PENDING until their flows land.
- `docs/planning/audit-log-enum.md §5`: flip `password.reset.complete` to WRITTEN and annotate
  `password.reset.request` as platform-routed (resolves part of the §5.2 backlog the doc tracks to OQ-D).

## Tests

- **Unit (`bun test`, no DB):** the two coverage drift-guards above.
- **Integration (`*.itest.ts`, own process):** add to / mirror `packages/db/test/platformAuditLog.itest.ts`:
  1. `requestPasswordReset` for an existing user writes exactly one `platform_audit_log` row with
     `action='password.reset.request'`, `actor_user_id=user.id`, `tenant_id IS NULL`.
  2. `requestPasswordReset` for an **unknown** email writes **no** row (non-enumeration) and still returns
     `{ sent: true }`.
  3. `completePasswordReset` for a user in exactly one tenant writes a `audit_log` row
     (`action='password.reset.complete'`, that tenant); for a user in 0 or ≥2 tenants writes a
     `platform_audit_log` row instead.
  4. **Swallow:** with the audit insert forced to fail (e.g. revoke insert, or a bad action), the reset still
     succeeds and nothing throws.
  5. **Lockdown unchanged:** the existing `platformAuditLog.itest.ts` deny-all + append-only assertions still
     pass (the new sink must use the owner connection, not grant `leadwolf_app`).

## Security checklist (truepoint-security)

- **Access / Visibility / Authorization:** unchanged — no new tenant-scoped read/write; `recordPlatformEvent`
  runs on the owner connection exactly like `withPlatformTx`, and must **not** add any `leadwolf_app` grant
  (the `platformAuditLog.itest.ts` deny-all proves this stays true).
- **Identity / non-enumeration:** the unknown-email path emits **no** row and keeps the neutral `{ sent: true }`
  shape (ADR-0031 §4 / ADR-0020). `password.reset.complete` reveals nothing user-facing.
- **Input:** no new external input reaches a query — `action` is a closed enum (typed, optionally
  `.parse()`d); `actorUserId`/`tenantId` are UUIDs from the resolved identity, not the request.
- **Secrets / data exposure:** `metadata` carries **no** code/token/PII — only the action and the UUID actor.
  Logging on failure is the action name only.
- **Abuse:** the `/forgot` and `/reset` edges are already Turnstile- + rate-limited; this change adds no new
  surface.
- **Compliance:** identity events land in the log designed to be tenant-independent and append-only; tenant
  `audit_log` exports stay free of platform-only values (ADR-0032 rationale).

## Gates (run before commit)

```
bun run typecheck
biome check && biome format --write
bun run lint:boundaries
bun test packages/types/src/auditCoverage.test.ts packages/types/src/platformAuditCoverage.test.ts
bun test packages/db/test/platformAuditLog.itest.ts        # + the new reset-audit itest
```

All green → commit on a feature branch (e.g. `feat/auth-pretenant-audit-events`). Do **not** push from an
environment without credentials; flag the push step.
