---
title: Platform Admin — Users Tab Audit
tab: users
status: fully-wired
last_audited: 2026-06-29
owner: platform-admin
---

# Platform Admin — Users Tab Audit

## 1. Executive Summary

The **Users** tab is the cross-tenant global user directory for TruePoint platform staff. It is **fully wired**: a searchable, keyset-paginated, capability-gated directory at route `/users` (`apps/admin/src/features/users/`, ~292 LOC across 6 files) backed by three audited API endpoints in `apps/api/src/features/admin/routes.ts`. Staff can search by email/name, page forward with a keyset cursor, and deactivate/reactivate a global user behind a mandatory reason dialog (min 5 chars). Every mutation runs inside `withPlatformTx(...)` so the `platform_audit_log` row and the `users.status` write commit or roll back together. Two lockout rails protect the platform: a caller cannot deactivate **themselves** (422, pre-tx, no audit row) and a platform-staff target is refused **in-tx** (audit rolls back). Authorization is layered: `authn` → `platformAdmin` → `requireCapability("users:deactivate")`, granted to `super_admin` and `support`.

The implementation is correct and safe for what it does, but it is **the thinnest viable identity surface for an enterprise admin console**. The dominant gap is **account-security primitives**: the directory cannot reset MFA, force a password reset, or revoke active sessions — the most common reasons a support engineer touches a user account during an incident. Those primitives already exist in `packages/auth` (`session.ts`, `passwordReset.ts`, `refresh.ts`) but are not wired into the platform path. Secondary gaps: no status filter (search is email/name only), free-text reason with no enumerated categories, no per-user audit/login/session history, and no bulk actions. This audit specifies the closure of each, in priority order, ending with a flag-gated security phase that exposes the account-security primitives only behind JIT elevation.

## 2. Current Implementation Audit

### Frontend — `apps/admin/src/features/users/`

| File | LOC | Responsibility |
|---|---|---|
| `components/UsersPage.tsx` | ~222 | The directory page: `DataTable` of users, server-side search form, `StateSwitch` four-state render, per-row deactivate/reactivate action gated on `canMaybe("users:deactivate")`, reason `Dialog` (min 5 chars). |
| `hooks/useUsers.ts` | ~70 | Loads `GET /admin/users`, holds active search + next cursor, separate `loading` vs `loadingMore` flags, `applySearch` / `loadMore` / `reload`. |
| `api.ts` | ~55 | The seam: `fetchUsers(search?, cursor?)`, `deactivateUser(id, reason)`, `reactivateUser(id, reason)` via `fetchWithAuth`. RFC 9457 `detail`/`title` surfaced as toast text. |
| `types.ts` | ~12 | `PlatformUser { id, email, fullName, status, isPlatformAdmin }`. |
| `format.ts` | ~21 | `statusTone(status)` → monochrome `StatusTone` badge. |
| `index.ts` | ~2 | Public surface export. |

The slice is idiomatic vanilla-React-with-`fetchWithAuth` (no TanStack Query), matching the codebase convention. The action column logic (`UsersPage.tsx:101-123`) is precise: suspended → Reactivate; active non-staff → Deactivate; active staff → `—` (protected, the API also refuses); whole column hidden when the caller lacks the capability.

### Backend — `apps/api/src/features/admin/routes.ts`

| Endpoint | Gate | Audit action | Repo |
|---|---|---|---|
| `GET /api/v1/admin/users?search=&cursor=&limit=` | `platformAdmin` (coarse) | `admin.list_users` (read string) | `platformAdminRepository.listUsers` |
| `POST /api/v1/admin/users/:id/deactivate` | `requireCapability("users:deactivate")` | `user.deactivate` | `platformAdminWriteRepository.setUserStatus(...,"suspended",{blockPlatformAdmin:true})` |
| `POST /api/v1/admin/users/:id/reactivate` | `requireCapability("users:deactivate")` | `user.reactivate` | `setUserStatus(...,"active",{blockPlatformAdmin:false})` |

Read: `listUsers` (`platformAdminReads.ts:204-232`) — `ilike(email)` OR `ilike(fullName)`, keyset `lt(users.id, cursor)` ordered `desc(users.id)`, `limit+1` probe → `toPage`, capped at `PLATFORM_READ_LIMIT=500`. Query Zod is `platformListQuerySchema` (`packages/types/src/platformAdmin.ts`): `search` ≤120 chars, `cursor` ≤256, `limit` 1–100 default 50.

Write: `setUserStatus` (`platformAdminWrites.ts:89-106`) selects `isPlatformAdmin` first; if missing → `{found:false}`; if `blockPlatformAdmin && isPlatformAdmin` → `{blockedPlatformAdmin:true}`; else `UPDATE users SET status, updatedAt`. The route validates UUID and self-deactivation **before** the tx (`routes.ts:113-115`), so those failures never write an audit row. Body Zod `userStatusChangeSchema` (`packages/types/src/userAdmin.ts`): `reason` 5–500 chars; status is implied by the endpoint, never trusted from the body.

Audit vocabulary: `user.deactivate` / `user.reactivate` are in the `platformAuditAction` enum (`packages/types/src/platformAudit.ts:14-15`) and attested WRITTEN in `platformAuditCoverage.test.ts:24-25`. Capability `users:deactivate` is in `staffCapability.ts:19`, bundled to `support` (`:39`) and implied by `super_admin`.

## 3. Enterprise Benchmark Research

| Product | Capability this tab lacks | Source |
|---|---|---|
| **Okta** | Per-user **Clear user sessions → Clear Sessions & Revoke Tokens**, **Reset Authenticators** (per-factor MFA reset), and **Sign out user** on all devices as part of a password reset — three first-class lifecycle actions beyond enable/disable. | help.okta.com — "Reset multifactor authentication" / "Clear user sessions" |
| **Salesforce** | A distinct **Freeze** (temporary login block, account stays in workflows/queues) separate from **Deactivate** (permanent, frees the license) — TruePoint's single "suspended" status conflates both. Salesforce **Summer '24** further split **Monitor Login History** and **Freeze Users** into granular permissions, decoupled from full "Manage Users". | help.salesforce.com — "Freeze or Unfreeze User Accounts"; "Monitor Login History and Freeze Users… (Summer '24)" |
| **Google Workspace** | **Suspend resets sign-in cookies** (forces sign-out of live sessions) and **Require password change** on next sign-in are built into the suspend flow; admins can also see and act on a user's security/login state from the same screen. | support.google.com/a — "Manage a user's security settings" / "Reset a user's password" |
| **AWS CloudTrail / Datadog** (audit) | Every identity action is queryable per-principal with a retained, exportable trail; TruePoint has the `platform_audit_log` row but **no per-user timeline view** surfacing it in the console. | Well-known product behaviour (CloudTrail event history; Datadog Audit Trail). |

**Takeaway:** the three IAM/admin leaders all treat *deactivate* as one of **five** routine per-user actions — deactivate/suspend, reset MFA, force password reset, revoke sessions, and view login/audit history. TruePoint ships one of the five.

## 4. Gap Analysis

| # | Gap | Severity | Benchmark |
|---|---|---|---|
| G1 | No **reset-MFA / force-password-reset / revoke-sessions**. Primitives exist in `packages/auth` (`session.ts`, `passwordReset.ts`, `refresh.ts`) but are not on the platform path. | High | Okta, Google Workspace |
| G2 | No **status filter** — `listUsers` filters only `ilike(email/name)`; staff cannot list "all suspended". | Medium | Salesforce, Okta |
| G3 | **Free-text reason**, no enumerated categories → weak audit analytics, inconsistent justifications. | Medium | OneTrust/Okta admin-reason patterns |
| G4 | No **per-user audit/login/session history** in the console (the rows exist; no view). | High | Salesforce Login History; CloudTrail |
| G5 | No **bulk** deactivate/reactivate. | Low | Okta "Reset MFA for Multiple Users" |
| G6 | **Suspend semantics undefined** — does `status='suspended'` revoke live sessions/refresh tokens? Today it only flips a column; sessions persist until expiry. | High (security) | Google Workspace cookie reset; Salesforce Freeze |
| G7 | No **Idempotency-Key** on the mutation endpoints (double-submit could write two audit rows for the same intent). | Medium | Stripe idempotent writes |
| G8 | Keyset `lt(users.id)` orders by **id desc**, not by a stable activity/created order; new-user discovery is by raw UUID order, not recency. | Low | — |

## 5. Functional Improvements

### 5.1 Account-security action menu (reset MFA / force password reset / revoke sessions)
- **Current state:** Only deactivate/reactivate exist (`api.ts`, `routes.ts:111-154`). The auth primitives sit unused in `packages/auth`.
- **Problem:** The most common support intervention (compromised/locked-out account) is impossible from the console; staff must use raw DB or out-of-band tooling, defeating the audited path.
- **Enterprise best practice:** Okta exposes Reset Authenticators, Clear sessions + revoke tokens, and password reset with force-signout as one-click per-user actions.
- **Recommended implementation:** Add three endpoints — `POST /admin/users/:id/reset-mfa`, `/force-password-reset`, `/revoke-sessions` — each a new audited mutation (recipe: Zod in `@leadwolf/types` userAdmin.ts → `platformAuditAction` enum entries `user.reset_mfa` / `user.force_password_reset` / `user.revoke_sessions` → `platformAuditCoverage` PENDING→WRITTEN → `platformAdminWriteRepository` methods calling the `packages/auth` primitives in-tx → `withPlatformTx` route → `requireCapability` gate → an "Account security" dropdown in `UsersPage.tsx`). Gate behind a **new** capability `users:security` (not the broad `users:deactivate`) and **require a JIT elevation in-tx** (these are sensitive).
- **Expected impact:** Closes the #1 identity-admin gap; moves incident remediation onto the audited, capability-gated, elevation-consuming path.
- **Dependencies:** `packages/auth` session/refresh/passwordReset surface must expose a tx-aware revoke; new capability + elevation wiring; design of the dropdown.
- **Priority:** High

### 5.2 Status filter on the directory
- **Current state:** `listUsers` filters only on `ilike(email/name)`; `platformListQuerySchema` has no status field.
- **Problem:** Staff cannot answer "show me every suspended account" — a routine audit/triage question.
- **Enterprise best practice:** Salesforce/Okta directories filter by user status as a primary facet.
- **Recommended implementation:** Add `status?: enum` to a `userListQuerySchema` (extend `platformListQuerySchema`), push `eq(users.status, ...)` into `listUsers` conds, render a status `<select>` in `UsersPage.tsx` driving `applySearch`. Read-only; no audit change.
- **Expected impact:** Faster triage; supports the suspended-account review workflow.
- **Dependencies:** None beyond the Zod/repo/UI touch.
- **Priority:** Medium

### 5.3 Enumerated reason categories
- **Current state:** `reason` is free-text 5–500 chars (`userAdmin.ts:11-13`).
- **Problem:** Inconsistent justification text makes audit analytics and compliance review unreliable.
- **Enterprise best practice:** Admin actions carry a structured reason code plus optional free text.
- **Recommended implementation:** Add `reasonCode: z.enum([...])` (e.g. `abuse`, `fraud`, `customer_request`, `security_incident`, `other`) alongside free-text `reason`; persist `reasonCode` in `withPlatformTx` metadata. UI: dropdown + textarea.
- **Expected impact:** Queryable audit; consistent compliance evidence.
- **Dependencies:** `withPlatformTx` metadata already accepts arbitrary JSON — additive only.
- **Priority:** Medium

## 6. Backend Improvements

### 6.1 Define and enforce suspend semantics (revoke sessions on deactivate)
- **Current state:** `setUserStatus` flips `users.status` only (`platformAdminWrites.ts:104`). Live sessions/refresh tokens are untouched.
- **Problem:** A "deactivated" user keeps a valid access token until it expires and can mint new ones from a live refresh token — the deactivation is not security-effective until token TTL.
- **Enterprise best practice:** Google Workspace suspend **resets sign-in cookies**; Okta deactivate revokes tokens.
- **Recommended implementation:** In the deactivate tx, after the status update call the `packages/auth` refresh-revocation primitive for that user (same tx). Document that `status='suspended'` ⇒ all sessions revoked. Add an isolation test asserting a deactivated user's refresh token is rejected.
- **Expected impact:** Deactivation becomes immediate and security-effective; closes G6.
- **Dependencies:** tx-aware revoke in `packages/auth/refresh.ts`.
- **Priority:** High

### 6.2 Idempotency-Key on the mutation endpoints
- **Current state:** No idempotency handling; a retried POST re-runs the tx and writes a second audit row.
- **Problem:** Double-submit / client retry produces duplicate `user.deactivate` audit entries for one intent.
- **Enterprise best practice (DEFERRED platform primitive):** Stripe-style `Idempotency-Key` keyed dedupe.
- **Recommended implementation:** Once the platform idempotency middleware lands, require `Idempotency-Key` on `/deactivate`, `/reactivate`, and the §5.1 security endpoints; key on `(actor, endpoint, userId, key)`. **Needs the shared idempotency infra — do not build per-endpoint.**
- **Expected impact:** Exactly-once audited mutations.
- **Dependencies:** Shared Idempotency-Key middleware (deferred platform work).
- **Priority:** Medium

## 7. Database Improvements

### 7.1 No new table required for status/security actions; one optional projection table
- **Current state:** Writes target the existing `users` table (`status`, `updatedAt`). History lives only in `platform_audit_log` (raw table, BYPASSRLS owner connection).
- **Problem:** A per-user timeline (G4) requires querying `platform_audit_log` by `target_id` — fine for reads, but there is no index guarantee documented for `(target_type, target_id)`.
- **Enterprise best practice:** Audit stores are indexed by principal/target for per-entity timelines.
- **Recommended implementation:** Confirm/add a `platform_audit_log (target_type, target_id, created_at desc)` index in `bootstrapAdmin.ts` (the raw DDL owner). No Drizzle migration — this table is owner-managed. If a denormalized last-action projection is later wanted, add it via the new-platform-table recipe (`schema/platformOps.ts` → `bun generate` → `rls/platformOps.sql` deny-all → REVOKE in `applyMigrations.ts`).
- **Expected impact:** Fast per-user history reads at 10x audit volume.
- **Dependencies:** `bootstrapAdmin.ts` DDL change; verify on a fresh bootstrap.
- **Priority:** Medium

## 8. API Improvements

### 8.1 `GET /admin/users/:id` detail + per-user history endpoint
- **Current state:** Only the list read exists; the row carries 5 fields and no detail/history route.
- **Problem:** The console cannot show a user's full lifecycle (status changes, who/when/why, last login) — G4.
- **Enterprise best practice:** Salesforce Login History; CloudTrail per-principal event history.
- **Recommended implementation:** `GET /admin/users/:id` (audited `admin.get_user`) returning profile + tenant memberships; `GET /admin/users/:id/audit` (audited `admin.list_user_audit`) returning `platform_audit_log` rows where `target_id=:id`, keyset-paged, `PLATFORM_READ_LIMIT`-bounded. Both reads, no enum mutation.
- **Expected impact:** Investigations stay in-console and on the audited path.
- **Dependencies:** §7.1 index for history performance.
- **Priority:** High

### 8.2 Status filter param (see §5.2) — additive to `GET /admin/users`
- **Current state / Problem / Best practice / Implementation:** as §5.2.
- **Expected impact:** Server-side status triage.
- **Dependencies:** None.
- **Priority:** Medium

## 9. Dependency Mapping

- **DB tables:** `users` (read + `status`/`updatedAt` write), `platform_staff` (role/capability resolution), `platform_audit_log` (raw, owner-written audit), `jit_elevations` (consumed by the §5.1 sensitive actions). For §5.1/§6.1 also `sessions`/refresh-token store owned by `packages/auth`.
- **Services / repositories:** `platformAdminRepository.listUsers` (read), `platformAdminWriteRepository.setUserStatus` (write), `withPlatformTx` (`packages/db/src/client.ts`), `actorOf(c)`, `decodeIdCursor`/`toPage`/`PLATFORM_READ_LIMIT` (`platformAdminReads.ts`).
- **API endpoints:** `GET /api/v1/admin/users`, `POST /api/v1/admin/users/:id/deactivate`, `POST /api/v1/admin/users/:id/reactivate` (+ proposed `:id`, `:id/audit`, `:id/reset-mfa`, `:id/force-password-reset`, `:id/revoke-sessions`).
- **Event flow:** UI dialog → `fetchWithAuth` (in-memory access token) → Hono `authn`→`platformAdmin`→`requireCapability` → UUID/self-guard (pre-tx) → `withPlatformTx(actor, action, fn, {targetType:"user", targetId, metadata:{reason}})` → `setUserStatus` UPDATE + `platform_audit_log` INSERT (atomic) → JSON `{ok,userId,status}` → toast + `reload()`.
- **Background workers / queues:** **None.** All actions are synchronous request-path mutations. (A future async "session revocation fan-out" would be the only candidate; not present.)
- **Permission / capability dependencies:** `users:deactivate` (→ `support`, `super_admin`); proposed `users:security` for §5.1. Coarse `pa===true` gate first; `requireCapability` re-checked **per request** (no JWT staleness on revoke).
- **Feature-flag dependencies:** **None today.** §5.1/§6.1 security actions should ship behind a flag (e.g. `platform.users.security_actions`) per the flag-heavy final phase.
- **External integrations:** None directly; §6.1/§5.1 depend on the internal `packages/auth` session/refresh/passwordReset subsystem (not an external IdP — staff SSO/MFA enforcement is deferred F2).
- **Cross-module dependencies:** `@leadwolf/types` (`platformAdmin`, `userAdmin`, `platformAudit`, `staffCapability`); `@leadwolf/ui` (`DataTable`, `Dialog`, `StateSwitch`, `StatusBadge`, `TpButton/Input/Textarea`, `useToast`); `lib/staffMe` (`useStaffMe().canMaybe`); `lib/authClient` (`fetchWithAuth`); `packages/auth` (for §5.1/§6.1).

## 10. Security Review

- **Tenant isolation:** This is an intentionally cross-tenant surface; reads go through the BYPASSRLS-bounded platform path with `PLATFORM_READ_LIMIT=500`. Platform tables are RLS deny-all to `leadwolf_app` + REVOKE ALL. Correct.
- **Authorization:** Layered `authn`→`platformAdmin`→`requireCapability("users:deactivate")`, re-checked per request. The UI gate (`canMaybe`) is defence-in-depth only; the API is authoritative. Correct.
- **Lockout rails:** Self-deactivation blocked **pre-tx** (422, no audit noise); platform-staff target blocked **in-tx** (audit rolls back). Both correct and tested-shaped.
- **Audit integrity:** Mutations are atomic with the audit row via `withPlatformTx`; reads recorded as `admin.list_users`. Drift guard (`platformAuditCoverage.test.ts`) enforces enum coverage.
- **Findings / risks:**
  - **R1 (High):** Deactivation does not revoke live sessions/refresh tokens (G6/§6.1) — a deactivated user retains access until token TTL. **Fix in §6.1.**
  - **R2 (High):** The §5.1 security actions (reset MFA, force reset, revoke sessions) are **sensitive** — they MUST consume a JIT elevation in-tx (403 `elevation_required` otherwise), exactly like `credit.adjust`/`tenant.suspend`, and use a dedicated `users:security` capability rather than overloading `users:deactivate`.
  - **R3 (Low):** No Idempotency-Key (G7) → duplicate audit rows on retry; **mitigate via §6.2 once shared infra lands** (deferred).
  - **DEFERRED:** Staff SSO/MFA/IP-allowlist enforcement (F2) and peer-approval (approved_by_user_id exists, not enforced) are platform-wide; this tab inherits whatever F2 lands.

## 11. Performance Review

- **Read:** `listUsers` is a single indexed scan: `ilike` on email/name (ensure trigram/`gin` or btree-pattern index on `users.email`/`fullName` for the `%term%` ILIKE — a leading-wildcard ILIKE is **not** index-eligible on a plain btree and will seq-scan at scale; this is the main perf risk). Keyset `lt(users.id)` + `limit+1` is O(page), correct — no OFFSET. Capped at 500.
- **Write:** Two statements (select `isPlatformAdmin`, then UPDATE) + one audit INSERT, all in one short tx. No N+1, no fan-out.
- **Frontend:** Append-on-`loadMore`, no full re-fetch; `DataTable` client-sorts the already-bounded page. Fine to 500 rows; beyond that the page cap protects it.
- **Recommendation:** Add a `pg_trgm` GIN index on `users.email` and `users.full_name` to make search ILIKE index-eligible (Medium). Confirm the `platform_audit_log (target_type, target_id)` index before shipping the §8.1 history read.

## 12. UX/UI Improvements

### 12.1 Status filter control + recency ordering
- **Current state:** Only a search box; order is `users.id desc` (UUID order, not recency).
- **Problem:** No way to scope by status; "newest users" is meaningless under UUID ordering.
- **Enterprise best practice:** Status facet + sort-by-recency are table-stakes in IAM directories.
- **Recommended implementation:** Add a status `<select>` (§5.2) and switch the keyset to `created_at desc, id desc` (stable compound cursor) so the directory reads newest-first.
- **Expected impact:** Faster triage; intuitive ordering.
- **Dependencies:** Repo cursor change (compound keyset); additive.
- **Priority:** Medium

### 12.2 Reason dropdown + clearer destructive confirmation
- **Current state:** Free-text textarea, min 5 chars; danger button for deactivate.
- **Problem:** Inconsistent reasons; no typed confirmation for an action that locks a user out of **all** orgs.
- **Enterprise best practice:** Structured reason code + explicit destructive confirmation.
- **Recommended implementation:** Reason-code dropdown (§5.3) above the textarea; keep the danger-variant button; surface the cross-org blast radius in the dialog description (already partially present at `UsersPage.tsx:186`).
- **Expected impact:** Better audit data; fewer mis-clicks.
- **Dependencies:** §5.3.
- **Priority:** Low

## 13. Automation Opportunities

- **Suspended-account review report:** A scheduled read (no new mutation) listing accounts suspended >N days for compliance review. Low priority; depends on §5.2 status filter.
- **Auto-revoke on deactivate (already in §6.1):** make session revocation an automatic consequence of deactivation rather than a separate manual step — the highest-value automation here.
- **Anomaly hook (future):** emit a platform event on bulk deactivations within a window for ops alerting (ties to Monitoring §14). No `ai_requests`/`automation_runs` ledger exists — do not assume one.

## 14. Monitoring & Logging

- **Today:** Every mutation produces a `platform_audit_log` row (actor, action, target, reason metadata). Reads logged as `admin.list_users`. This is the system of record.
- **Gaps / recommendations:**
  - Surface the per-user audit timeline in-console (§8.1) — the data exists, the view does not.
  - Emit a metric/log on `user.deactivate` rate per actor for abuse detection (a staff member mass-deactivating accounts). Wire to the ops alerting path (truepoint-operations), not a new table.
  - Ensure the §5.1 security actions are individually audited (distinct enum entries) so "reset MFA" is never invisible.

## 15. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Deactivation not session-effective (R1/G6) | High | High | §6.1 revoke-in-tx + isolation test |
| Sensitive §5.1 actions shipped without elevation gate (R2) | Medium | Critical | Require JIT elevation in-tx + `users:security` capability + flag |
| Leading-wildcard ILIKE seq-scans at scale | Medium | Medium | `pg_trgm` GIN index (§11) |
| Duplicate audit rows on retry (R3/G7) | Low | Low | §6.2 once shared Idempotency infra lands |
| Free-text reasons degrade compliance evidence | Medium | Low | §5.3 reason codes |

## 16. Technical Debt

- **Cursor ordering by `users.id` (UUID), not recency** — semantically odd for a directory; should be compound `created_at`-based (§12.1).
- **No `users/index.ts` re-export of `api`/`hooks`** beyond the page — minor; the slice is small enough that it doesn't yet hurt.
- **Status string is untyped** in `PlatformUser` (`status: string`) and in `format.ts` (`switch` over loose strings) — should reference the canonical `UserAccountStatus` enum from `@leadwolf/types` so the badge map and the directory agree on the closed set.
- **Reason handling duplicated** across deactivate/reactivate in both `api.ts` and the route; tolerable but a shared helper would DRY the §5.1 expansion.

## 17. Multi-Phase Implementation Plan

### Phase 1 — UX & correctness quick wins
- **Objectives:** Close the cheap, non-security gaps and align with the program's Phase-1 quick-win mandate.
- **Scope:** Status filter (§5.2/§8.2), recency ordering (§12.1), reason-code dropdown (§5.3), `UserAccountStatus` typing (§16), `pg_trgm` index (§11).
- **Deliverables:** `userListQuerySchema` with `status`; `listUsers` `eq(status)` + compound keyset; reason-code Zod + dropdown; trigram index migration.
- **Technical tasks:** extend Zod in `@leadwolf/types`; repo cond + cursor change; UI `<select>` + dropdown; add index in the appropriate migration path.
- **Risks:** Cursor change must stay backward-compatible (old cursors invalid → reset gracefully).
- **Dependencies:** None external.
- **Testing requirements:** repo unit tests for status filter + compound keyset; UI render test for the filter; explain-analyze the ILIKE post-index.
- **Estimated complexity:** Low.
- **Success criteria:** Staff can filter by status, see newest-first, pick a reason code; search is index-eligible.
- **Priority:** High.

### Phase 2 — User detail & per-user history (tab depth)
- **Objectives:** Make the tab investigable, not just actionable.
- **Scope:** `GET /admin/users/:id` (§8.1), `GET /admin/users/:id/audit`, in-console detail drawer + audit timeline, `(target_type,target_id)` audit index (§7.1).
- **Deliverables:** two audited read endpoints; detail/history UI; index in `bootstrapAdmin.ts`.
- **Technical tasks:** new read repos + `admin.get_user`/`admin.list_user_audit` strings; keyset over audit rows; drawer component; verify index on fresh bootstrap.
- **Risks:** audit-log read volume — must be keyset-bounded and indexed.
- **Dependencies:** Phase 1 (typing), §7.1 index.
- **Testing requirements:** read isolation tests (bounded, cross-tenant safe); pagination test on audit history.
- **Estimated complexity:** Medium.
- **Success criteria:** A staff user can open any account and see its full audited lifecycle in-console.
- **Priority:** High.

### Phase 3 — Flag-gated account-security actions (security phase, last)
- **Objectives:** Wire the `packages/auth` primitives to the platform path **safely** — behind a flag, a dedicated capability, and JIT elevation.
- **Scope:** `reset-mfa`, `force-password-reset`, `revoke-sessions` endpoints (§5.1); session revocation on deactivate (§6.1); Idempotency-Key (§6.2) if shared infra is ready; new capability `users:security`.
- **Deliverables:** three audited mutations consuming an elevation in-tx; deactivate→revoke-in-tx; flag `platform.users.security_actions`; "Account security" UI dropdown gated on `canMaybe("users:security")` + flag.
- **Technical tasks:** full new-audited-mutation recipe ×3 (Zod → enum `user.reset_mfa`/`user.force_password_reset`/`user.revoke_sessions` → coverage PENDING→WRITTEN → write-repo methods → `withPlatformTx` + elevation consume → `requireCapability` → UI); tx-aware revoke in `packages/auth`.
- **Risks:** **Highest** — these actions can lock out or de-MFA real users; require security sign-off, elevation gating, and the flag for staged rollout. Idempotency depends on deferred shared infra.
- **Dependencies:** `packages/auth` tx-aware revoke; JIT elevation (`jit_elevations`); feature-flag system; **security review sign-off**; (Idempotency-Key middleware — deferred).
- **Testing requirements:** elevation-required 403 tests; revoked-session-rejected isolation test; reset-MFA re-enrollment test; audit-coverage drift guard green; flag-off hides the dropdown and 403s the endpoints.
- **Estimated complexity:** High.
- **Success criteria:** Behind the flag, an elevated `users:security` holder can reset MFA / force reset / revoke sessions, every action audited and elevation-consuming; deactivation is immediately session-effective.
- **Priority:** Critical (gated) — ship only after security sign-off.

## 18. Final Recommendations

### 18.1 Make deactivation session-effective (do this first within security work)
- **Current state:** `status` flip only; sessions persist to TTL.
- **Problem:** Deactivation is not security-effective — the core correctness defect of the tab.
- **Enterprise best practice:** Google Workspace/Okta revoke tokens on suspend.
- **Recommended implementation:** §6.1 revoke-in-tx + isolation test.
- **Expected impact:** Deactivation becomes immediate.
- **Dependencies:** `packages/auth` tx-aware revoke.
- **Priority:** Critical.

### 18.2 Wire the account-security primitives behind elevation + flag
- **Current state:** primitives exist, unused on the platform path.
- **Problem:** Incident remediation can't happen in the audited console.
- **Enterprise best practice:** the five-action IAM baseline (Okta/Google/Salesforce).
- **Recommended implementation:** Phase 3 (§5.1) — dedicated `users:security` capability, JIT elevation in-tx, feature flag, distinct audit enums.
- **Expected impact:** Full, safe identity-admin parity.
- **Dependencies:** auth subsystem, elevation, flags, security sign-off.
- **Priority:** Critical (gated).

### 18.3 Ship the Phase-1 quick wins now
- **Current state:** search-only, UUID order, free-text reason.
- **Problem:** Routine triage is slower than it should be; weak audit analytics.
- **Enterprise best practice:** status facet + reason codes + recency order.
- **Recommended implementation:** §5.2/§5.3/§12.1/§11 as one low-risk batch.
- **Expected impact:** Immediate operator-experience and audit-quality lift at near-zero risk.
- **Dependencies:** None.
- **Priority:** High.
