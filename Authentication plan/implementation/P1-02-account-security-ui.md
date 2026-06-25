# P1-02 — `/account/security` user self-service UI

## Goal

Build the **Absent** per-user account-security surface on the auth origin
(`auth.truepoint.in/account/security`). Today `apps/web`'s `SecurityPanel` only **deep-links** to this route
and shows a hard-coded MFA list (`enrolled: false`) — the route does not exist. This is the biggest end-user
experience gap: users cannot change their password, manage MFA, view/revoke their **own** sessions, or see
login history in-product.

> **Where it lives:** the auth origin (`apps/auth`), not `apps/web` — account-security is served where the
> durable session + refresh cookie live (ADR-0016). `apps/web`'s `SecurityPanel` keeps deep-linking here.

## Sections (each an `apps/auth/src/app/account/security/...` SSR view + server action)

| Section | Backing | Notes |
|---------|---------|-------|
| **Password change** | new server action → re-auth (verify current password), `assertPasswordAcceptable` (**P0-02**), `hashPassword`, `userRepository.setPassword`, then `revokeAllSessionsForUser` **except the current session** | Step-up: require the current password (and MFA if enrolled) before the change. |
| **MFA methods** | enroll TOTP (reuse the **P1-01 §A** enroll flow), regenerate recovery codes, disable a method (step-up required); WebAuthn/passkey deferred to P3 | Replaces the hard-coded `SecurityPanel` list with a real `GET` of enrolled methods. |
| **Active sessions (own)** | a **user-scoped** read of `user_sessions` + revoke — the per-user analogue of the workspace-admin `listMemberSessions`/`revokeMemberSession` (`@leadwolf/core` `adminSessions.ts`); reuse `session.ts` revoke primitives | Show device (UA-parsed), IP, last-seen, "this device"; revoke one or all-others. |
| **Login history** | the user's recent `user_sessions` (+ resolved-tenant `audit_log` auth events where available) | The cross-tenant pre-tenant-event view is limited — scope to sessions + the resolved tenant's events; `‹confirm the read source›`. |

## New endpoints/actions (mirror the existing auth-origin server-action style)

- `GET  /account/security` (+ subsection routes) — SSR, prefilled from a user-scoped read.
- `POST` server actions: `changePassword`, `enrollTotp` / `verifyTotp` / `disableMethod` / `regenerateRecoveryCodes`,
  `revokeOwnSession` / `revokeAllOtherSessions`.
- All behind `sessionGuard` (authenticated user only); state-changing ones require step-up re-auth.

## Acceptance criteria (the gaps this closes)

- **WCAG 2.2 AA + i18n** (mandated, and the gap analysis flagged the auth flows as unassessed): label/error
  association, focus management, the recovery-code copy affordance, and **localizable** copy — make AA + i18n a
  **ship gate** for these views.
- **CSP no-regression → [`../09-threat-model.md`](../09-threat-model.md) "Session / CSRF / CSP / cookie
  invariants":** the net-new client JS preserves the strict nonce-CSP (no inline scripts); WebAuthn lib (P3)
  vetted to run under it.
- **Step-up + audit:** every mutation re-proves identity and emits its audit event (`password.reset.*` analogue
  for change; `device.*` / `session.revoked` via the P0-01 sink as those land).
- **Replaces the placeholder:** once the methods `GET` lands, update `apps/web` `SecurityPanel` to read real
  enrollment state instead of the hard-coded list.

## Security checklist

- **Access:** all reads/writes are scoped to the authenticated `userId` from the session — never an id from the
  request (a user can only manage their **own** account).
- **Mass-assignment → [`09`](../09-threat-model.md):** the change-password/profile writes allowlist fields;
  email-immutability and any latent settable column are excluded.
- **Secrets:** TOTP secrets encrypted (`secrets.ts`); recovery codes shown once, stored hashed; never logged.
- **Abuse:** step-up + rate-limit on password change, MFA disable, and recovery-code regeneration.

## Gates

```
bun run typecheck && biome check && bun run lint:boundaries
bun test apps/auth/...account-security tests
# manual: WCAG 2.2 AA pass (axe / keyboard-only) on each subsection before ship
```

Branch e.g. `feat/account-security-ui`. Large — land per section (password → MFA → sessions → history).
