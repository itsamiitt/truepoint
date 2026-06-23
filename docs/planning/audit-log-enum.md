# Audit-log Action Enum — Living Reference

> The single consolidated view of TruePoint's closed `audit_log.action` vocabulary: what it is **today**
> (as built in code), the convention every value follows, the G-CMP-1 history, the write-path coverage,
> and the values future milestones will add. This is a **reference/index doc** — it records and links the
> decisions already made in [08 §5](./08-compliance.md), [03 §7](./03-database-design.md), and the ADRs;
> it does not itself make new decisions.

## 1. Purpose & scope

`audit_log` is the append-only, monthly range-partitioned, tenant-scoped table that records every
**mutating, externally-meaningful action** — the contract stated in [02 §6](./02-architecture.md). Its
`action` column is a **closed** set (no free text) so that the vocabulary is immutable and exhaustively
switchable in TypeScript, SOC 2 evidence is enumerable, and DSAR/export tooling can reason over a known
set. It is distinct from `platform_audit_log` — the **separate**, immutable table for staff/admin
cross-tenant actions ([ADR-0011](./decisions/ADR-0011-platform-admin-and-privileged-access.md), [13](./13-platform-admin.md)),
which has its own (currently unspecified) vocabulary; see §6 and §9.

Why a single reference: the same vocabulary lives in five locations that must stay in lockstep (§2.1).
Gap **G-CMP-1** (audit coverage of record/settings mutations) was closed at the **vocabulary** level in
**M5 / Remediation Pass 1**, but **write-path coverage is still partial** (§5). This doc tracks both the
value set *and* who actually writes each value, milestone by milestone, so the [02 §6] contract is kept
honest and the gap does not silently reopen.

## 2. Current state (as built)

### 2.1 Canonical sources — keep in lockstep

| Layer | Location | Role |
|---|---|---|
| **Spec (prose)** | [08 §5](./08-compliance.md) | Authoritative enumerated list + per-value rationale |
| **Schema prose** | [03 §7](./03-database-design.md) (`audit_log` entry) | Mirrors the list in the DB-design doc |
| **TS source of truth** | `packages/types/src/billing.ts` → `auditAction` (Zod enum) + `AuditAction` type | Compile-time enforcement |
| **DB mirror** | `packages/db/src/schema/billing.ts` → `varchar('action',{length:50})` + CHECK `audit_log_action_enum` | Runtime enforcement |
| **Applied migration** | `packages/db/src/migrations/0000_sleepy_absorbing_man.sql` (`CREATE TABLE audit_log` + the CHECK) | Materialized state |

**Mechanism note (important):** this is **not** a Postgres `pgEnum` / `CREATE TYPE … AS ENUM`. It is a
`varchar(50)` constrained by a named **`CHECK` constraint** (`audit_log_action_enum`) that mirrors a **Zod
enum**. There is no `AUDIT_ACTIONS` array, and no type literally named `audit_action`. The Zod list and the
CHECK list are two **hand-maintained** lists that must match (see §7).

### 2.2 The value set — 78 values, four groups

Exactly as declared in `auditAction` (`packages/types/src/billing.ts`). In the prose docs (08 §5, 03 §7)
shared prefixes are slash-compressed (`contact.create/update/delete`); the code carries the fully-expanded
literals shown here.

**A. Data / money / compliance (18)** — the original money-loop + DSAR/consent/membership set.

| Value | Covers |
|---|---|
| `reveal` | Contact reveal charged, or free re-reveal of an owned copy |
| `reveal.blocked` | Reveal aborted by the in-tx suppression gate (no charge) |
| `export` | CSV / bulk export of revealed fields |
| `send` | Outreach step send (post-suppression, CAN-SPAM-gated) |
| `enroll` | Contact enrolled in a sequence |
| `unsubscribe` | Unsubscribe / one-click List-Unsubscribe recorded |
| `suppression.add` / `suppression.remove` | Suppression-list entry added / removed |
| `consent.record` / `consent.withdraw` | Consent recorded / withdrawn (withdraw auto-adds global suppression) |
| `dsar.access` / `dsar.delete` / `dsar.rectify` | DSAR access / erasure / rectification |
| `member.add` / `member.update` / `member.remove` | Workspace/tenant membership change |
| `apikey.use` | Public API key authenticated a metered action |
| `credit.adjust` | Any non-reveal/non-top-up balance change: admin grant, chargeback reversal, **bounce credit-back** ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)) |

**B. Record / config mutations (19)** — *added by the G-CMP-1 remediation* (§4) so the [02 §6] contract is
expressible.

| Value | Covers |
|---|---|
| `contact.create` / `contact.update` / `contact.delete` | Contact CRUD (import or manual) |
| `account.create` / `account.update` / `account.delete` | Account CRUD |
| `list.create` / `list.update` / `list.delete` | List CRUD |
| `sequence.create` / `sequence.update` / `sequence.delete` | Outreach sequence CRUD |
| `template.create` / `template.update` / `template.delete` | Message template CRUD |
| `settings.update` | Any workspace/tenant settings write ([29](./29-settings-administration-architecture.md)) |
| `automation.rule.create` / `automation.rule.update` / `automation.rule.delete` | Automation rule CRUD ([ADR-0026](./decisions/ADR-0026-workflow-automation-engine.md)) |

**D. Record-customization / automation-lifecycle / AI mutations (21)** — *added per
[ADR-0032 Addendum](./decisions/ADR-0032-platform-audit-action-vocabulary.md)* resolving §6 OQ-A and OQ-C toward
dedicated `entity.verb` actions for the new entity types of [ADR-0028](./decisions/ADR-0028-record-customization-layer.md)
(M8), the automation **lifecycle** verbs of [ADR-0026](./decisions/ADR-0026-workflow-automation-engine.md) (M16),
and the AI moderation actions of [ADR-0023](./decisions/ADR-0023-ai-provider-and-intelligence-architecture.md) (M14).

| Value | Covers |
|---|---|
| `custom_field.create` / `custom_field.update` / `custom_field.delete` | Custom-field definition CRUD ([ADR-0028](./decisions/ADR-0028-record-customization-layer.md)) |
| `tag.create` / `tag.update` / `tag.delete` | Tag definition CRUD ([ADR-0028](./decisions/ADR-0028-record-customization-layer.md)) |
| `tag.assign` / `tag.unassign` | Tag attached to / removed from a record |
| `pipeline_stage.create` / `pipeline_stage.update` / `pipeline_stage.delete` | Custom pipeline-stage CRUD ([ADR-0028](./decisions/ADR-0028-record-customization-layer.md)) |
| `pipeline_stage.assign` | Record moved to a pipeline stage |
| `saved_search.create` / `saved_search.update` / `saved_search.delete` | Saved-search / segment CRUD ([ADR-0028](./decisions/ADR-0028-record-customization-layer.md)) |
| `automation.rule.enable` / `automation.rule.disable` / `automation.rule.run` | Automation rule lifecycle: toggled on/off, manual run ([ADR-0026](./decisions/ADR-0026-workflow-automation-engine.md)) |
| `ai.config.update` | AI configuration write ([ADR-0023](./decisions/ADR-0023-ai-provider-and-intelligence-architecture.md)) |
| `ai.draft.approve` / `ai.draft.reject` | Human moderation of an AI-generated draft ([ADR-0023](./decisions/ADR-0023-ai-provider-and-intelligence-architecture.md)) |

**C. Auth events (20)** — owned by [17 §9](./17-authentication.md); carried on `audit_log` with `origin_domain`.

| Value | Covers |
|---|---|
| `login.success` / `login.failure` / `login.locked` | Sign-in outcomes / progressive lockout |
| `mfa.challenge` / `mfa.success` / `mfa.failure` | MFA step outcomes |
| `password.reset.request` / `password.reset.complete` | Password-reset lifecycle |
| `sso.initiated` / `sso.callback` | SSO handoff |
| `token.issued` / `token.refresh` / `token.revoke` | Access/refresh token lifecycle |
| `device.trusted` / `device.revoked` | Trusted-device changes |
| `session.revoked` | Session revoked |
| `code.issued` / `code.exchanged` | PKCE code lifecycle |
| `signup` | Registration |
| `oauth.link` | OAuth identity linked |

### 2.3 The `audit_log` row (real column names)

`id · tenant_id · workspace_id?(null = tenant-level) · actor_user_id?(null = system) · action ·
entity_type · entity_id · metadata jsonb · ip_address inet · user_agent · origin_domain · occurred_at`
— append-only (UPDATE/DELETE blocked by a trigger in `packages/db/src/rls/billing.sql`), monthly
range-partitioned.

Note the names differ from a naive guess: the actor column is **`actor_user_id`** (not `actor_id`) and the
timestamp is **`occurred_at`** (there is **no** `created_at`). `entity_type` is free-form (no CHECK).
`origin_domain` records the acting origin (`auth.truepoint.in` vs the originating app origin) per [17 §9].

## 3. Naming convention (the closed-enum rules)

Any new value MUST follow the established style — do not introduce a second convention.

- **Dotted, lowercase, `domain.verb` / `entity.verb`.** Present-tense verb for CRUD: `contact.create`,
  `contact.update`, `contact.delete` — **not** past tense (`*.created`).
- **Compound/lifecycle verbs** take a second dot: `password.reset.request`, `automation.rule.create`.
- **Domain noun + action** for money/compliance: `credit.adjust`, `suppression.add/remove`,
  `consent.record/withdraw`, `dsar.access/delete/rectify`.
- **A few bare tokens are intentional** for high-level events: `reveal`, `export`, `send`, `enroll`,
  `unsubscribe`, `signup`.
- **Closed set:** no free text; **one** value set, for the tenant `audit_log` only. Staff/admin actions are
  a **separate** vocabulary on `platform_audit_log` (§6, §9).

**Common look-alikes that are NOT in the enum** (and the real token):

| Looks plausible | Actual value |
|---|---|
| `contact.created` / `*.created` | `contact.create` / `*.create` |
| `api_key.created` / `api_key.used` | `apikey.use` |
| `credit_back.issued` | `credit.adjust` (bounce credit-back) |
| `enrollment.created` | `enroll` |
| `send.delivered` / `send.attempted` | `send` (per-send detail → `outreach_log`, see §6 / OQ-B) |
| `import.started/completed/failed` | (none — import audits via `contact.create` / `account.create`) |
| `audit_log.exported` | `export` (per [29](./29-settings-administration-architecture.md)) |

## 4. G-CMP-1 — the gap and how it was closed

- **The gap.** [28 §3.17](./28-enterprise-readiness-audit.md) **G-CMP-1** (also drift finding **F-8**)
  flagged that the closed `action` enum omitted record CRUD, settings, and list/sequence/automation admin
  events — contradicting the [02 §6] "every mutating, externally-meaningful action is audited" contract,
  and a SOC 2 evidence gap. Owner milestone **M5**; graded **Critical**.
- **The fix (vocabulary).** **Remediation Pass 1 (2026-06-10)** extended the closed enum with the
  record/config mutation actions (group **B**, §2.2). Landed in [08 §5], mirrored in [03 §7], and in code
  (the `auditAction` group commented `// record/config mutations (28 G-CMP-1)`).
- **Scope note.** [28 §3.17]'s *recommendation* also floated `ai.config.*` and `report.export`; Pass 1
  intentionally did **not** adopt these — AI was audited via existing values / `ai_requests` (OQ-C) and
  audit-log / report export via the existing `export` action (§3, §6). The landed group **B** was therefore
  narrower than the original gap recommendation. **A later pass (2026-06-17,
  [ADR-0032 Addendum](./decisions/ADR-0032-platform-audit-action-vocabulary.md)) then added the dedicated
  `ai.config.update`/`ai.draft.*` actions** (resolving OQ-C) plus the record-customization and
  automation-lifecycle actions (group **D**, §2.2; resolving OQ-A); `report.export` is still folded into
  `export`.
- **Status.** G-CMP-1 / F-8 are **closed for the vocabulary** ("the contract is expressible within the
  closed enum"). **Residual:** vocabulary ≠ coverage — see §5. Full write-path coverage is milestone-gated
  as the owning services land.
- **No "Phase 0."** This corpus has no `30-implementation-roadmap.md`, no P0–P6 phases, and no
  "fix-first/Phase 0" concept. Remediation is tracked as **Pass 1 / Pass 2** ([28 §11/§12]); the roadmap is
  [10-roadmap.md](./10-roadmap.md) with milestones **M0–M16 (no M6)**.

## 5. Write-path coverage (as built + residual gaps)

The single writer **today** (for core-mediated mutations) is **`writeAudit(tx, entry)`**
(`packages/core/src/compliance/writeAudit.ts`), called **inside the mutation's own transaction** so the
action and its audit row commit or roll back together → `auditRepository.insert` (append-only). *(One
intentional exception: `reveal.blocked` is written in its own transaction after the reveal rolls back, so
the blocked-attempt proof survives.)* Because `packages/auth` cannot import `core` (dependency graph:
`auth → db/types/config`, never `core`), auth events use a **separate sink — `recordAuthEvent`**
(`packages/auth/src/auditEvent.ts`, [ADR-0031](./decisions/ADR-0031-auth-event-audit-tenancy.md)): its own
`withTenantTx`, swallow-on-failure, wired for the **tenant-resolved** events (§5.1).

### 5.1 Written today — verified call-sites (18 of 78)

| Action | Call-site |
|---|---|
| `reveal` | `packages/core/src/reveal/revealContact.ts:172` |
| `reveal.blocked` | `packages/core/src/reveal/revealContact.ts:197` |
| `send` | `packages/core/src/outreach/sendStep.ts:90` |
| `enroll` | `packages/core/src/outreach/enrollContact.ts:73` |
| `sequence.create` | `packages/core/src/outreach/createSequence.ts:32` |
| `sequence.update` | `packages/core/src/outreach/createSequence.ts:78` |
| `suppression.add` | `consent.ts:77`, `handleBounce.ts:54`, `apps/api/src/features/compliance/routes.ts:73` |
| `credit.adjust` | `packages/core/src/outreach/handleBounce.ts:71` |
| `consent.record` | `packages/core/src/compliance/consent.ts:32` |
| `consent.withdraw` | `packages/core/src/compliance/consent.ts:60` |
| `dsar.access` | `packages/core/src/compliance/assembleAccessReport.ts:48` |
| `dsar.delete` | `packages/core/src/compliance/deleteFanout.ts:41` |
| `login.success` | `packages/auth/src/flow.ts` `finalizeLogin` — via `recordAuthEvent`, covers password/magic/SSO |
| `signup` | `apps/auth/src/app/signup/actions.ts` `completeSignup` |
| `sso.initiated` | `apps/auth/src/app/sso/actions.ts` `initiateSso` |
| `sso.callback` | `apps/auth/src/lib/completeSso.ts` `completeSso` |
| `token.issued` | `apps/auth/src/app/token/exchange/route.ts` POST |
| `code.exchanged` | `apps/auth/src/app/token/exchange/route.ts` POST |

### 5.2 Defined but not yet wired — the residual coverage backlog (60 of 78)

These values exist in the closed enum but have **no writer call-site yet** (`writeAudit` for core,
`recordAuthEvent` for auth); they land as their owning services / milestones do:

- **Auth events (14)** — the tenant-resolved auth events are now wired via `recordAuthEvent` (§5.1). These
  **14 remain pending**: *pre-tenant* (`login.failure`, `mfa.challenge/success/failure`,
  `password.reset.request/complete` → `platform_audit_log`, OQ-D), *high-volume* (`token.refresh`),
  *redundant* (`code.issued` — the same finalize moment as the wired `login.success`), or *no flow yet*
  (`login.locked`, `token.revoke`, `session.revoked`, `device.trusted/revoked`, `oauth.link`). See
  [ADR-0031](./decisions/ADR-0031-auth-event-audit-tenancy.md).
- **Record/config mutations (17)** — `contact.*`, `account.*`, `list.*`, `template.*`, `settings.update`,
  `automation.rule.create/update/delete`, and `sequence.delete`. Their services are partly unbuilt (no list,
  settings, membership, or template service writes audit today). Coverage tracks **M8** (record customization /
  [ADR-0028](./decisions/ADR-0028-record-customization-layer.md)) and **M16** (automation).
- **Record-customization / automation-lifecycle / AI (21)** — the group **D** additions (§2.2,
  [ADR-0032 Addendum](./decisions/ADR-0032-platform-audit-action-vocabulary.md)): `custom_field.*`, `tag.*`
  (incl. `assign`/`unassign`), `pipeline_stage.*` (incl. `assign`), `saved_search.*`,
  `automation.rule.enable/disable/run`, `ai.config.update`, `ai.draft.approve/reject`. Their owning services
  (M8 / M16 / M14) are unbuilt, so none has a writer yet.
- **Other (8)** — `export`, `unsubscribe`, `suppression.remove`, `member.add/update/remove`, `apikey.use`,
  `dsar.rectify`.

This §5.2 set is the live backlog for the [02 §6] contract; §8 proposes the CI gate that keeps it shrinking
rather than silently forgotten.

## 6. Future milestone additions (planned)

Every capability below traces to a real ADR / milestone (zero invented scope). The key design point: the
enum is kept **deliberately small** — most new capabilities are audited via an **existing** value, not a
new one. "New value" is flagged only where granularity genuinely requires it (and as an open question).

| Milestone (ADR) | Capability | Audit handling today | New value? |
|---|---|---|---|
| **M7** ([ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md)) | Sales Navigator capture (HITL) | Captured leads land as imported contacts → `contact.create` | *Optional* `salesnav.capture` (OQ-A); legacy `sales_nav.link_added` was **not** adopted |
| **M8** ([ADR-0028](./decisions/ADR-0028-record-customization-layer.md)) | Custom fields / tags / pipeline stages / saved searches | Now have **dedicated** actions: `custom_field.*`, `tag.*` (incl. `assign`/`unassign`), `pipeline_stage.*` (incl. `assign`), `saved_search.*` (group **D**, §2.2). Pending writers (§5.2) until the M8 services land | **Yes — resolved (was OQ-A):** dedicated `entity.verb` actions added per [ADR-0032 Addendum](./decisions/ADR-0032-platform-audit-action-vocabulary.md) |
| **M9** ([ADR-0009]/[ADR-0013]) | Outreach send engine, bounces, unsubscribe | Covered: `enroll`, `send`, `unsubscribe`; bounce → `suppression.add` + `credit.adjust` | **No** `bounce.*`/`enrollment.*`/`credit_back.*` — by design; per-send detail → `outreach_log` (OQ-B) |
| **M10** ([26](./26-integrations-data-delivery.md)) | CRM sync / public API / webhooks | Config → `settings.update`; metered API reveal → `apikey.use` | **No** `integration.*`/`crm_sync.*`/`webhook.*`; sync runs → integration/sync logs |
| **M11** ([ADR-0030](./decisions/ADR-0030-granular-tenant-org-roles.md)/[ADR-0018](./decisions/ADR-0018-auth-policy-and-mfa-enforcement-model.md)) | SSO / SCIM / domain / policy / org-roles / audit-log export | Auth events (`sso.*`, …) already in enum ([17 §9]); SCIM/domain/policy/role changes → `settings.update` / `member.update`; audit-log export → `export` | **No** dedicated `scim.*`/`domain.*`/`auth_policy.*`/`org_role.*`/`audit_log.exported` |
| **M14** ([ADR-0023](./decisions/ADR-0023-ai-provider-and-intelligence-architecture.md)) | AI intelligence layer | Every call → `ai_requests` (in DSAR scope, [08 §10]); material downstream actions still hit `audit_log` via existing values (e.g. approved AI draft sent → `send`). **Config writes + human draft moderation** now have dedicated actions | **Yes — resolved (was OQ-C):** `ai.config.update`, `ai.draft.approve`, `ai.draft.reject` added per [ADR-0032 Addendum](./decisions/ADR-0032-platform-audit-action-vocabulary.md); per-call telemetry stays in `ai_requests` |
| **M15** ([ADR-0022](./decisions/ADR-0022-departments-teams-intra-workspace-segmentation.md)) | Departments & teams | Team/role changes → `member.*` / `settings.update` | **No** dedicated `team.*` |
| **M16** ([ADR-0026]) | Automation engine | Rule CRUD covered (`automation.rule.create/update/delete`); **lifecycle** (enable/disable, manual run) now has dedicated `automation.rule.enable/disable/run`; in-rule actions still reuse the action they perform (e.g. enroll → `enroll`) | **Yes — added** `automation.rule.enable/disable/run` per [ADR-0032 Addendum](./decisions/ADR-0032-platform-audit-action-vocabulary.md); `automation_runs` keeps per-run telemetry |
| **Platform admin** ([ADR-0011]) | Staff / impersonation / tenant ops | Writes the **separate** `platform_audit_log`, **not** this enum | Separate `platform_audit_action` enum — [ADR-0032](./decisions/ADR-0032-platform-audit-action-vocabulary.md) (Proposed) |

## 7. Mechanism: TS ↔ DB alignment & how to add a value

- **Source of truth** = the Zod enum `auditAction` in `packages/types/src/billing.ts`;
  `export type AuditAction = z.infer<typeof auditAction>` is the compile-time type. `writeAudit`'s
  `entry.action` is typed `AuditAction` (via `AuditEntryInput`), so only declared values compile.
- **DB mirror** = `varchar('action',{length:50})` + the named CHECK `audit_log_action_enum` in
  `packages/db/src/schema/billing.ts`, identical to the constraint in migration `0000_sleepy_absorbing_man.sql`.
  The Zod list and the CHECK list must match exactly — drift means a value that compiles but the DB rejects
  (or vice-versa).
- **Not Drizzle `pgEnum`.** `drizzle-kit generate` will **not** auto-detect a value added to one list but
  not the other; lockstep is a manual discipline, CI-gated per §8.

```ts
// packages/types/src/billing.ts — source of truth
export const auditAction = z.enum([ "reveal", "reveal.blocked", /* … */ "oauth.link" ]);
export type AuditAction = z.infer<typeof auditAction>;
```
```sql
-- packages/db/src/schema/billing.ts → mirrored in migration 0000
CHECK ( action IN ('reveal','reveal.blocked', /* … */ , 'oauth.link') )  -- constraint: audit_log_action_enum
```

**To add or change a value (the lockstep edit):**

1. Add the literal to `auditAction` (in the right group, following §3).
2. Mirror it in the CHECK in `packages/db/src/schema/billing.ts`.
3. Author a new numbered migration under `packages/db/src/migrations/` that **drops and re-adds**
   `audit_log_action_enum` with the new member (re-runnable; guard with `IF EXISTS`). Because it is a CHECK,
   not a PG enum, this is an ordinary `ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT …` that **can run
   inside a normal transaction** (unlike `ALTER TYPE … ADD VALUE`, which cannot).
4. Wire the `writeAudit` call-site(s) (§5) and a coverage test (§8).
5. Propagate the prose in [08 §5] + [03 §7] and update §2/§5 of this doc.

### 7.1 Migration sequencing

| Migration | Milestone window | Audit-action change | Gate |
|---|---|---|---|
| `0000_sleepy_absorbing_man.sql` | M0–M5 | Initial `audit_log` + the full 57-value CHECK (incl. the G-CMP-1 record/config additions) | Applied; CI green |
| *(future, per §6)* | M8 / M11 / M14 / … | Only if an OQ resolves toward a **new** value (e.g. `custom_field.*`) — most milestones add **no** value | Milestone DoD + §8 gate |

> The initial schema already ships the complete extended vocabulary, so — unlike a from-scratch enum — most
> future milestones add **no** migration here; they add **writers** (§5) and tests (§8) for values that
> already exist.

## 8. Coverage gate

**Implemented — unit drift-guard.** `packages/types/src/auditCoverage.test.ts` (Bun test, no DB) asserts
the closed `auditAction` enum partitions exactly into the **WRITTEN** set (§5.1) and the **PENDING** set
(§5.2): `WRITTEN ∪ PENDING === auditAction.options`, the two sets are disjoint, and neither holds a stale
literal. Adding or removing an action without updating the bookkeeping fails the test, so the §5.2 backlog
stays visible and the [02 §6] contract can't silently regress. As each PENDING action lands a writer, move
it to WRITTEN there **and** in §5. Run with `bun test packages/types`.

**Future — DB-backed exercised-writer gate.** The stronger check — that each WRITTEN action actually
produces an `audit_log` row — belongs as an integration test in the `packages/db/test/*.itest.ts` harness
(needs Postgres), run after migrate / before build, once a CI pipeline exists (there is none today):

```ts
// packages/db/test/audit-coverage.itest.ts (proposed)
import { auditAction } from "@leadwolf/types";
const WRITER_PENDING = new Set([ /* the §5.2 backlog — shrinks as services land */ ]);
for (const action of auditAction.options) {
  it(`${action} is written or explicitly pending`, async () => {
    // exercise the action's writer and assert one audit_log row, OR assert it is on WRITER_PENDING
  });
}
```

## 9. Open questions & DoD

### 9.1 Open questions

| # | Question | Blocks | Owner |
|---|---|---|---|
| OQ-A | M8 record customization: add dedicated `custom_field.*`/`tag.*`/`pipeline_stage.*` actions, or fold into `settings.update`/`contact.update`? ADR-0028 adds new entity types for which [08 §5] lists no dedicated action. **Resolved** ([ADR-0032 Addendum](./decisions/ADR-0032-platform-audit-action-vocabulary.md)): added dedicated `custom_field.*`, `tag.*` (incl. assign/unassign), `pipeline_stage.*` (incl. assign), `saved_search.*` (group **D**, §2.2). | M8 DoD | M8 |
| OQ-B | Keep `audit_log` to compliance-significant `send` only, with per-send detail in `outreach_log`? (De-facto today — confirm.) | M9 | M9 |
| OQ-C | M14 AI: add first-class `ai.*` audit actions, or keep AI in `ai_requests` (+ DSAR scope) and only audit material downstream actions? **Resolved** ([ADR-0032 Addendum](./decisions/ADR-0032-platform-audit-action-vocabulary.md)): added `ai.config.update` + `ai.draft.approve`/`ai.draft.reject` for config writes and human draft moderation; per-call telemetry stays in `ai_requests`. | M14 DoD ("AI artifacts in DSAR scope") | M14 |
| OQ-D | `platform_audit_log` vocabulary: share this enum, or a separate `platform_audit_action`? **Proposed in [ADR-0032](./decisions/ADR-0032-platform-audit-action-vocabulary.md)** — a separate `platform_audit_action` enum covering staff actions + the tenant-less auth events. | Platform-admin track | [ADR-0032](./decisions/ADR-0032-platform-audit-action-vocabulary.md) |
| OQ-E | Retention/purge: is a retention-job partition delete itself an audited event? (No `audit_log.purge` value exists.) | Trust track | Trust track |
| OQ-F | **Auth audit sink + tenancy:** how do the 20 auth-event values get written given `audit_log.tenant_id` is `NOT NULL` but auth is pre-tenant (global identity)? The sink design + the resolved-vs-tenant-less split are proposed in [ADR-0031](./decisions/ADR-0031-auth-event-audit-tenancy.md) (**Proposed**); coupled to OQ-D. | M2 / M11 auth audit | [ADR-0031](./decisions/ADR-0031-auth-event-audit-tenancy.md) |

**Resolved (was the prompt's open question):** *Does DSAR fan-out scan by `entity_id` or `actor_id`?* —
**by neither directly:** [08 §4.2] resolves the data subject to the golden `master_person_id` and cascades
across every overlay copy by that identity, never by `actor_id`.

### 9.2 Definition of done (vocabulary vs. coverage)

- [x] Vocabulary closes the [02 §6] contract — record/config mutations in the closed enum (M5 / Pass 1).
- [x] Zod `auditAction` ↔ DB CHECK `audit_log_action_enum` in lockstep (verified).
- [ ] Every defined value has a writer or an explicit "pending" allowlist entry (§5.2 backlog cleared).
- [~] Auth audit sink (`recordAuthEvent`) landed; tenant-resolved auth events wired (§5.1, [ADR-0031]). Pre-tenant events await `platform_audit_log` (OQ-D); the `passwordReset.ts` TODO tracks that subset.
- [x] Coverage **drift-guard** unit test green (`packages/types/src/auditCoverage.test.ts`, §8).
- [ ] DB-backed exercised-writer gate + CI wiring (§8) — pending a CI pipeline.
- [ ] DSAR delete E2E proves removal across all copies + the relevant `audit_log` rows ([10 M5](./10-roadmap.md) DoD).

---

*Reference doc — consolidates [08 §5](./08-compliance.md), [03 §7](./03-database-design.md),
[28 §3.17](./28-enterprise-readiness-audit.md) (G-CMP-1 / F-8), and the code in
`packages/types/src/billing.ts` + `packages/db/src/schema/billing.ts`. Update it whenever the closed enum,
its writers, or a milestone's audit plan changes.*
