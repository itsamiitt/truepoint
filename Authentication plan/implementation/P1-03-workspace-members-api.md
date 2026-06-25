# P1-03 — Workspace Members API (invite / role / remove)

## Goal

Build the workspace **Members** API — the only remaining workspace-admin gap now that the Sessions API ships.
`apps/web`'s `MembersPanel` is fully built but every mutation hits a non-existent route and falls back to a
"Not available yet" toast (`api.ts` → `/workspaces/current/members*`, `‹confirm exact paths›`). The Sessions
API (`apps/api/src/features/workspaces/sessionRoutes.ts`, mounted `app.ts:71`) is the exact pattern to mirror.

## Design — mirror `sessionRoutes.ts`

Add `workspaceMembersRoutes` (a new router, or extend `workspaceSecurityRoutes`) under `/api/v1/workspaces`,
gated identically: `authn` → `tenancy` → `requireRole("owner", "admin")`. Core logic in `@leadwolf/core`,
request/response schemas in `@leadwolf/types`, the DB writes in `workspaceRepository` (which already manages
`tenantMembers`/`workspaceMembers` — see `workspaceRepository.ts:169-235`).

| Route | Core fn | Notes |
|-------|---------|-------|
| `GET /members` | `listWorkspaceMembers` | email, name, role, status (active/invited). Reuse the org-list query shape. |
| `POST /members/invite` | `inviteMember` | body `{ email, role }`; reuse the existing **invitations** flow (`packages/auth/src/invitations.ts` — token hash, 7-day TTL) + mailer. |
| `PATCH /members/:userId/role` | `changeMemberRole` | body `{ role }`; **role allowlist** = `workspaceRole` enum. |
| `DELETE /members/:userId` | `removeMember` | cannot remove the workspace **owner** (the panel already disables this client-side — enforce server-side). |

## Security checklist (truepoint-security) — this is the load-bearing part

- **Authorization:** `requireRole("owner","admin")` + the core layer re-verifies (same as `sessionRoutes.ts`);
  the workspace id comes from the **tenancy** middleware/session, never the request body.
- **Privilege / mass-assignment → [`../09-threat-model.md`](../09-threat-model.md) "Mass-assignment & field
  allowlisting":** `role` is validated against the `workspaceRole` enum; a member can never set `owner`,
  `tenant_id`, `user_id`, or escalate beyond the caller's own role; **a non-owner cannot grant owner**.
- **Tenant isolation:** all writes are `tenant_id` + `workspace_id` scoped, enforced by RLS — an invite/role/
  remove can only ever touch a member of the **caller's** workspace (add the cross-tenant isolation test).
- **Idempotency:** invite is idempotent on `(workspace, email)`; re-invite refreshes the token rather than
  duplicating (reuse the invitations onConflict pattern).
- **Abuse:** rate-limit invites (an unbounded invite endpoint is a spam/enumeration vector).

## Audit (wire the PENDING actions)

`member.add`, `member.update`, `member.remove` are defined in the tenant `auditAction` enum but **PENDING**
(`auditCoverage.test.ts:50-52`). Wiring them here moves them PENDING→WRITTEN (same bookkeeping discipline as
**P0-01**): emit via the in-tx `writeAudit` on each mutation, and move the three actions to `WRITTEN` in
`auditCoverage.test.ts` + `audit-log-enum.md §5`.

## Frontend

`MembersPanel` already renders the table, invite form, role dropdowns, and remove dialog; it just needs the
routes live. Once they are, the `notWired()` toast and the "Members API not connected" empty state become dead
fallbacks (exactly as happened for `SessionsPanel`). Confirm `api.ts` paths/methods match the new routes.

## Tests

- Integration (mirror the session-route tests): owner/admin can list/invite/change-role/remove; a `member`
  role is 403'd; **cross-tenant isolation** — an actor cannot touch another workspace's member; removing the
  owner is rejected; invite is idempotent; each mutation writes its audit row.

## Gates

```
bun run typecheck && biome check && bun run lint:boundaries
bun test packages/types/src/auditCoverage.test.ts          # member.* moved to WRITTEN
bun test apps/api/...workspace-members route tests + the cross-tenant isolation itest
```

Branch e.g. `feat/workspace-members-api`. Well-scoped — closest-to-shovel-ready of the P1 items.
