# 11 — Phase 4: Access, Governance & Compliance (execution spec)

> **Gate:** PLAN / execution spec. **Posture:** reconcile-and-cite — this is the **access/governance
> execution layer** that composes `05-compliance.md` (the law: Art.14/DPDP/TCPA-DNC) with the shipped
> suppression / erasure / audit and the RBAC model. **Converts** the incoming brief *"05 — Phase 4:
> Access, Governance & Compliance."* Builds on `05`/`08`/`09`/`10`. **Depends on** Phases 1–3.
> **No source code is modified by this gate.** *(Likely the final phase of the incoming brief set.)*

## 1. Objective (and how much already exists)

The brief asks for RBAC + owner-scoped access, immutable access/export audit, consent + suppression
before outreach, retention + soft delete, and right-to-erasure / DSAR export.

**Suppression, erasure, and audit are shipped; the compliance-law net-new is already designed in `05`.**
The access/governance layer this doc adds is mostly **composition** of existing primitives, plus a few
genuinely-unbuilt pieces (RBAC `org_role` build, the retention engine, CRM-erasure propagation, a
"litigator" suppression category) — each cited to its design, not redesigned.

## 2. Premise corrections (reported refuted / misstated, with `file:line`)

| Brief premise | Verdict | Evidence |
|---|---|---|
| `gov.role` / `gov.permission` / `gov.role_grant` (generic RBAC) | **Forks the real model** | RBAC is duty-separated: `tenant_members.org_role` (owner/billing_admin/security_admin/compliance_admin/member, ADR-0030) ⟂ workspace role (owner/admin/member/viewer) ⟂ `team_role` (ADR-0022); platform staff separate (ADR-0011). Custom permission-sets are **explicitly deferred** (ADR-0030 *Revisit if*). |
| `gov.access_log` — "who **viewed**/exported which records" | **Reconcile to action-level** | the closed `audit_log.action` enum records `reveal`/`export`/`dsar.*`/`consent.*` per entity, append-only (`audit-log-enum.md`); staff cross-tenant → `platform_audit_log`. Per-customer **view** logging is not done (RLS bounds reads; per-view rows are infeasible at scale). Staff record-level access = **break-glass impersonation** (D2). |
| "Option B: materialized suppression + hard non-bypassable gate" | **Already the shipped design** | `assertNotSuppressed` runs **inside** the reveal-tx **and** the send-tx, tri-scoped (`08 §3`; `rls/billing.sql:62-81`). |
| Erasure model (soft-delete + tombstone + proof) | **Already built** | `compliance/deleteFanout.ts` — find-everywhere → tombstone → global suppression → verification scan gates `completed`. |

Per the gate's faithful-reporting rule (`01 §6`, DM3), the spec plans on the **actual** model below.

## 3. Current state — the shipped access/governance machinery

- **RBAC layers:** `org_role` (ADR-0030, M11 — `compliance_admin` ⊇ suppression/DSAR/consent/retention/
  audit-export); workspace role (shipped); `team_role` (ADR-0022, designed); platform staff (ADR-0011).
- **Audit:** closed `audit_log.action` enum, append-only (the `reveal.blocked` exception is written in
  its own tx after rollback); per entity (`reveal` `revealContact.ts:172`, `dsar.access`
  `assembleAccessReport.ts:48`, `export`, `consent.*`, `suppression.remove`). Staff →
  `platform_audit_log` (`rls/platform.sql`, deny-all to the app role).
- **Suppression + consent:** `assertNotSuppressed` unbypassable in-tx, tri-scoped `suppression_list`
  (`08 §3`); `consent_records` per subject × jurisdiction; objection/opt-out → auto global suppression
  (`08 §2`); ingest-time set-based screen (`08 §3.1`).
- **Erasure / DSAR:** `deleteFanout.ts` (built, idempotent, `withPrivilegedTx`, verification scan);
  `assembleAccessReport` (DSAR access, built); `dsar` worker queue.
- **Retention:** `retentionSweep.ts` — narrow (idempotency-key/email reclaim, leader-locked, batched).

## 4. Brief → real-model mapping (do not fork the schema)

| Brief artifact | Real model | Where |
|---|---|---|
| `gov.role` / `gov.permission` / `gov.role_grant` | `org_role` + workspace role + `team_role` + `platform_staff` (custom roles deferred) | ADR-0030/0022/0011 |
| `gov.access_log` | `audit_log` (customer, action-level, per-entity) + `platform_audit_log` (staff) | `audit-log-enum.md`; ADR-0011/0032 |
| `gov.consent` | `consent_records` (subject × jurisdiction) | `08 §2` |
| `suppress.entry` (channel, reason, scope) | `suppression_list` (tri-scoped; `match_type` incl. phone) | `rls/billing.sql:62-81` |
| `gov.retention_policy` | `08 §7` + ADR-0025 retention/decay — **net-new engine** | `08 §7` |
| `gov.erasure_request` | `dsar_requests` + `deleteFanout` | `deleteFanout.ts` |
| `assertNotSuppressed(channel, identity, scope)` | **shipped** (in-tx, reveal + send) | `08 §3` |

**Do not introduce `gov.*`/`suppress.*` namespaces.**

## 5. The genuine net-new (cite the design)

1. **RBAC `org_role` build** — ADR-0030 migration (compat-alias `is_tenant_owner ⇔ org_role='owner'`,
   then drop) + the billing/security/compliance capability mapping; lands M11. Custom permission-sets
   remain deferred.
2. **TCPA/DNC pre-dial + line-type gate** — `assertNotSuppressed('phone')` + National/state/internal
   DNC scrub (≥31-day) + reassigned-numbers + line-type consent gate → cite `05 §4` (+ the `09 §2.3`
   line-type port; one lookup serves verification *and* the consent gate). The dialer is greenfield;
   this gate must exist before it ships.
3. **GDPR Art.14 source-notice + India DPDP module** → cite `05 §2/§3` (already designed; verified
   research `01 §5`).
4. **Per-data-class retention/decay-purge engine** → cite `08 §7` + ADR-0025 (TTL + action per data
   class); `retentionSweep` is the narrow existing piece, not the engine.
5. **Erasure propagation to projections / CRM** — forward (Phase-7 sync, `07`); **today** the global
   suppression row already blocks re-monetization via source/sync/re-enrichment (`deleteFanout.ts:53-54`).
   When projections (`10`/PLAN_05) and CRM sync (`07`) ship, the cascade extends to them, tracked to
   completion.
6. **"Litigator"/known-complainant suppression category** — a new `suppression_list.reason` value (the
   brief's "litigator") + its **sourcing/maintenance** (open question §10). The gate mechanism is the
   existing `assertNotSuppressed`.

## 6. Compliance flows (reconciled)

- **Pre-dial:** `assertNotSuppressed('phone', identity, scope)` + DNC scrub + line-type/consent check →
  block or proceed, audited (`05 §4`). *(Dialer pending.)*
- **Pre-send:** `assertNotSuppressed('email', …)` + CAN-SPAM suppression → block/proceed, audited
  (`08 §3/§6`). *(Send path shipped.)*
- **Right-to-erasure:** `deleteFanout` — soft-delete → tombstone (PII null) → purge dependents → global
  suppression → per-copy `dsar.delete` proof → verification scan → (forward) propagate to projections +
  synced CRMs.
- **DSAR export:** `assembleAccessReport` + **per-field provenance** (`field_provenance.src` +
  `source_records.lawful_basis_snapshot`, `04 §2.2`) = the Art.14 "source of data" obligation.

## 7. Migration & rollout (reconciled)

- **Expand** — `consent_records`/`suppression_list`/`dsar_requests` shipped; add the retention-policy
  table + (ADR-0030) `org_role`. All additive.
- **Shadow** — run any **new** suppression reason (litigator) / the pre-dial gate in log-only first;
  measure would-be blocks. (The core suppression gate is already enforced — not re-shadowed.)
- **Cutover** — enable the pre-dial gate with the dialer; RBAC via the ADR-0030 compat-alias.
- **Rollback** — gates **fail closed** (block on uncertainty); rollback = revert a *new* gate to
  log-only only on a false-positive storm; **never silently disable the shipped suppression gate**.

## 8. Gate-compliance checklist (mapped to real mechanisms)

- [x] **Tenant isolation** — `suppression_list`/`consent_records`/`audit_log` tenant/workspace-scoped;
  global-scope rows are staff-managed; cross-workspace erasure runs under `withPrivilegedTx` (audited).
- [x] **Bounded queries** — suppression lookups are blind-index + channel keyed (`08 §3`), indexed.
- [x] **Pool safety** — erasure/retention batched in workers (`deleteFanout` idempotent;
  `retentionSweep` batched).
- [x] **Online-safe migrations** — additive tables; `org_role` compat-alias; erasure off-peak batched.
- [x] **Cache correctness** — suppression cache invalidated on new entry; **fail closed** if
  stale/unavailable (money/permission never served stale, `18 §5`).

## 9. Acceptance criteria (reconciled — already-met vs net-new)

- [x] **No send path bypasses the suppression gate** (in-tx, `08 §1`); **dial path** gate is net-new
  (pending the dialer, `05 §4`).
- [x] **Access + export audited, append-only** (`audit_log`/`platform_audit_log`).
- [x] **Erasure removes PII + verification scan** (`deleteFanout`); **projection/CRM propagation** is
  net-new (forward).
- [x] **DSAR export includes per-field provenance** (`assembleAccessReport` + `field_provenance`/
  `source_records`).
- [ ] **RBAC `org_role` enforced** (ADR-0030 build) — net-new.
- [ ] **Per-data-class retention enforced + auditable** (ADR-0025/`08 §7` engine) — net-new.
- [ ] **Litigator/known-complainant list** wired + maintained — net-new.

## 10. Scale-gate · Failure modes · Open questions

**Scale-gate:** erasure find-everywhere at billions of copies → blind-index lookup is O(matches); the
verification scan bounds completion; runs off the OLTP hot path under `withPrivilegedTx`.

**Failure modes:** (F1) a send/dial path skips `assertNotSuppressed` → release blocker (the gate is
in-tx and unbypassable by design, `08 §1`). (F2) suppression cache stale → **fail closed** (block).
(F3) erasure leaves residual PII → the verification scan refuses `completed` until clean
(`deleteFanout.ts:63-70`). (F4) generic RBAC drift → use the typed `org_role`/workspace/team model, not
free-form grants.

**Open questions:** (1) **Erasure-to-CRM** is eventual and must be **tracked to completion** — owner:
Phase-7 sync (`07`). (2) **LI-vs-consent posture per jurisdiction** → legal sign-off (`05 §9`; DPDP has
no LI basis, `01 §5.1`). (3) **Litigator/known-complainant list sourcing + maintenance** (new) — owner:
`truepoint-operations` + legal. (4) Suppression-cache fail-closed semantics + the per-view audit
boundary (action-level vs view-level) — owner: security.

## Sources

Code (verified): `packages/core/src/compliance/{deleteFanout,writeAudit,assembleAccessReport}.ts`,
`packages/core/src/reveal/revealContact.ts`, `packages/db/src/rls/{billing,platform}.sql`,
`apps/workers/src/queues/{retentionSweep,dsar}.ts`, `docs/planning/audit-log-enum.md`. Design:
data-management `05`/`04`/`01 §5/§6`; `08-compliance.md`; ADR-0030 (org roles), ADR-0011/0032 (platform
admin/audit), ADR-0022 (team roles), ADR-0025 (retention/freshness), ADR-0021 (deletion cascade); `07`
(CRM-erasure propagation); `list-plan` D2 (break-glass).
