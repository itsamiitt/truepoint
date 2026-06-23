# ADR-0034 — Bootstrap platform super-admin via a flag on the customer identity

- **Status:** Accepted (interim). Diverges from [ADR-0011](./ADR-0011-platform-admin-and-privileged-access.md) /
  [13-platform-admin.md](../13-platform-admin.md) for the bootstrap case.
- **Date:** 2026-06-16
- **History:** Renumbered from a duplicate **ADR-0032** (2026-06-16); **0033** is reserved for the
  RLS-by-default decision (in-flight `fix/rls-app-role-runtime` branch, not yet on main).

## Context

We need an immediately-usable platform **super-admin** (the "Bootstrap Admin") that signs in through the
normal `auth.*` IdP and has cross-tenant access. ADR-0011 / doc 13 mandate a **separate** internal staff app
(`apps/admin` + `staff_users`) with its own auth, deliberately isolated from the customer app. That separate
app does not exist yet, and the immediate need is a working super-admin login.

## Decision

Implement the bootstrap super-admin as a **flag on the global customer identity**, not a separate staff app:

- **`users.is_platform_admin`** — server-set only, never user-editable.
- Threaded into the **signed** access JWT as the **`pa`** claim (login → single-use code binding → token mint).
- The api gates `/api/v1/admin/*` on `pa === true` via a **deny-by-default `platformAdmin` guard**, with **no**
  tenancy/workspace scoping.
- Cross-tenant data access uses a dedicated **audited** path, **`withPlatformTx`**, which runs as the DB
  **owner** (the RLS bypass on Neon, where `leadwolf_admin` lacks `BYPASSRLS`) and records every access in a
  separate **`platform_audit_log`** table. The tenant request flow is unchanged — RLS for every other caller
  still stands (`withTenantTx` drops to the non-bypassing `leadwolf_app` role).
- The admin is **seeded** (email-verified + active + no MFA → immediate login) with a home TruePoint
  org/workspace; MFA stays **opt-in** (enrolling a method later enforces it), per the existing model.
- **`.env` is the source of truth (provisioning is repeatable, not one-shot).** `provisionBootstrapAdmin`
  keys off a stable **`users.is_bootstrap_admin`** marker (migration 0009), not the email. `deploy.sh` runs
  the `bootstrap` profile automatically **after migrate on every deploy** (guarded; skipped with a notice if
  the two creds are unset). Each run re-hashes the password and, if `BOOTSTRAP_ADMIN_EMAIL` changed, **renames
  the same record** (rather than orphaning the old admin + creating a second super-admin). A rename onto an
  address already owned by a different account fails closed with a clear message. This is the permanent fix
  for "changed `.env` credentials but the bootstrap admin still can't log in" — the stale-hash root cause was
  that the one-shot job was never re-run.

## Consequences

- Fast, and uses the login the user expects. **Diverges** from ADR-0011's blast-radius isolation: the
  super-admin path now shares the customer-app surface.
- **Mitigations:** server-only flag; trust the **signed** claim only (never the request); deny-by-default
  guard (unit-tested); every cross-tenant access audited; bounded (limit-500) queries.
- **Follow-up — hardening for production:** migrate to the separate staff app (`apps/admin` + `staff_users` +
  JIT elevation + mandatory MFA/SSO + IP allowlist) per doc 13; add a `platform_audit_log` read/export
  surface and the admin web console; rotate the bootstrap credential off the built-in default.
