# 10 — Phase 3: Quality, Storage & Modeling (execution spec)

> **Gate:** PLAN / execution spec. **Posture:** reconcile-and-cite. **Converts** the incoming brief
> *"04 — Phase 3: Quality, Storage & Modeling."* Builds on data-management `06-storage-and-scale.md`
> (+ `02`/`04`). **Depends on** Phases 1–2 (`08`/`09`). **No source code is modified by this gate.**

## 1. Objective (and how much already exists)

The brief asks for a normalized, constraint-enforced, multi-tenant model with owner-scoped visibility,
projection tables for fast retrieval, and continuous quality measurement.

The **isolation model, index strategy, identity uniqueness, and the visibility model are settled** (the
last by ADR-0022, which the brief misstates — §2). The genuine gaps are the **per-workspace quality
dashboard**, the **ADR-0022 teams/visibility build**, and the **projection layer** (deferred PLAN_05) —
all already designed and cited here (§5), not redesigned.

## 2. Premise corrections (reported refuted / misstated, with `file:line`)

| Brief premise | Verdict | Evidence |
|---|---|---|
| "Owner-scoped by default (record visible to uploader) … **this is the established Closo model**" | **Inverted** | ADR-0022 is canonical: `visibility ∈ {workspace, team, owner}` with **default `workspace`** — records are **workspace-visible by default**; owner/team-private is **opt-in**. Today: workspace-isolated via RLS with `owner = coalesce(owner_user_id, revealed_by_user_id)` as a soft **facet** (`searchRepository.ts:41,:90,:206`), not a wall. |
| "list-based sharing for cross-owner access" (`core.list_share`) | **Contradicts D4** | `list-plan` **D4**: "my lists is a filter, **not** an access wall." Cross-team access is ADR-0022 `visibility`, not a list ACL. Drop `list_share`. |
| Projection tables to "build" | **Designed, deferred** | `proj.*_search` + namespace-versioned read-model = PLAN_05 (CQRS, `search_outbox`, RYOW); deferred scale track (`06 §3`). |
| "NOT NULL on identity spine" | **It's a CHECK, not column-NOT-NULL** | a contact needs **≥1 of** email / LinkedIn / sales-nav (`runImport.ts:93` throws when all three are absent); each column is individually nullable by design. |

Per the gate's faithful-reporting rule (`01 §6`, DM3), the spec plans on the **actual** model below.

## 3. Current state — the shipped model

- **Tenant isolation (hard wall):** every overlay table is `ENABLE`+`FORCE` RLS on the fail-closed
  workspace GUC (`rls/contacts.sql`), set tx-local by `withTenantTx` (`client.ts`); Layer-0 by access
  path (DM4). This is DB-enforced and **cannot drift** — stronger than any app helper.
- **Owner/visibility (today):** records are workspace-visible; `owner_user_id` (+ `revealed_by_user_id`)
  drive the soft "my prospects" facet (`searchRepository.ts:41,:90,:206`). `assigned_team_id`/
  `visibility`/`teams`/`team_members` are **designed (ADR-0022) but unbuilt** (`prospect-company-data` C10).
- **IDOR guard:** client-supplied IDs are re-filtered through `contactRepository.visibleContactIds()`
  inside the RLS tx before any mutation (`bulkActions.ts`); role-checked `assignOwner`.
- **Index strategy:** consolidated in `06 §2` — `idx_contacts_ws_owner`, partial `priority_score`, GIN
  `custom_fields`, account rollup, per-workspace dedup uniques; master keys at Layer 0.
- **Identity uniqueness:** per-workspace partial-unique blind-index constraints + `(workspace_id,
  domain)` account unique (`schema/contacts.ts`); the "≥1 identity key" CHECK is enforced in code
  (`runImport.ts:93`).
- **Quality (per record):** `data-health/dataQualityScore.ts` + `dataHealth.ts` (field health/decay);
  `data_quality_rules` + DQ targets in `22`. **No per-workspace metric rollup table** yet.
- **Search:** Postgres-native faceted + keyset, inside `withTenantTx` (`searchRepository.ts`). No
  projection tables yet.

## 4. Brief → real-model mapping (do not fork the schema)

| Brief artifact | Real model | Where |
|---|---|---|
| `core.person` / `core.company` | overlay `contacts`/`accounts` + golden `master_persons`/`master_companies` | `02 §1`; ADR-0021 |
| `core.list` / `core.list_member` | `lists` / `list_members` (already shipped) | `schema/lists.ts` |
| `core.list_share` | **drop** — use ADR-0022 `visibility` (`workspace\|team\|owner`); D4 keeps lists as filters | ADR-0022; D4 |
| `proj.person_search` / `proj.company_search` / `core.workspace_search_state` | PLAN_05 projections + `search_outbox` + RYOW versioning (deferred) | PLAN_05; `06 §3` |
| `quality.metric_snapshot` | **net-new** per-workspace rollup (fill·bounce·conflict·freshness) | `22`; `11 §4.5` |
| `scopeFor(tenant, owner, viaLists)` | RLS (hard wall) + app-layer ADR-0022 visibility filter + `visibleContactIds` | `client.ts`; ADR-0022; `bulkActions.ts` |

**Do not introduce `core.*`/`proj.*`/`quality.*` namespaces or `list_share`.**

## 5. The genuine net-new (cite the existing design)

1. **Quality metric-snapshot** — a per-workspace periodic rollup of **fill rate** (per field),
   **verification outcomes** (valid/invalid/catch_all/unknown trend), **conflict rate** (fields with
   disagreeing sources — feeds the provenance review), and **freshness distribution** (drives the
   Phase-2 re-enrichment cadence, `09 §5`). → cite `22-data-quality-freshness-lifecycle.md` (DQ rules
   + targets) + reports `11 §4.5`; aggregates read off replicas/ClickHouse (`18 §6`), never the OLTP
   writer. This is the one clearly-net-new *table* this phase introduces.
2. **ADR-0022 teams/visibility build** — `teams`/`team_members` + overlay `assigned_team_id` +
   `visibility` (default `workspace`) + the **app-layer authz filter** (and optional extra RLS
   predicate) for `team`/`owner` records. Consolidate the app-layer filter into a single **`scopeFor`**
   helper so the owner/team/list filter is defined **once** (the brief's anti-IDOR-drift intent) —
   layered **on** RLS, never replacing it. → cite ADR-0022 + C10.
3. **Projection layer** — `proj.*_search` + namespace-versioned read-model, shadow-built, parity-checked
   → cite PLAN_05 (CQRS, `search_outbox`, RYOW; OpenSearch/ClickHouse). Deferred scale track; the
   Postgres-native search serves until a workspace overlay crosses the Typesense envelope (`06 §3`).

## 6. Constraints & identity-spine (reconciled)

- **Identity spine** = "≥1 of email / LinkedIn / sales-nav" — a **CHECK / app-invariant**
  (`runImport.ts:93`), not column NOT-NULL (each is nullable so a URN-poor CSV row can land on any one
  key). If a DB-level CHECK is desired, add it; do not make the columns individually NOT NULL.
- **Unique identity key per tenant** — already enforced by the per-workspace partial-unique blind-index
  constraints + the account `(workspace_id, domain)` unique. Layer-0 adds the global uniques.
- **FK integrity** — `contacts.account_id`, `master_*_id` bridges, `list_members` FKs already in place.
- **Net-new is only**: any missing CHECK, added via the **`NOT VALID` → `VALIDATE CONSTRAINT`** online
  pattern so validating on large existing tables takes no long lock.

## 7. Migration & rollout (reconciled)

- **Expand** — add the `metric_snapshot` table + (ADR-0022) `teams`/`team_members`/`assigned_team_id`/
  `visibility` columns, all additive; add CHECKs `NOT VALID`.
- **Shadow** — build projections (PLAN_05) without serving; compute metric snapshots without surfacing;
  `VALIDATE CONSTRAINT` online.
- **Backfill** — populate projections + initial metric snapshots in bounded off-peak batches; verify
  parity vs core.
- **Cutover** — switch reads to projections behind a flag; enable the quality dashboard; monitor parity
  + latency (`18 §2`).
- **Rollback** — projections/snapshots are **derived** (safe to drop); the flag reverts reads to core;
  ADR-0022 columns default to `workspace` (no behaviour change if the authz filter is off).

## 8. Gate-compliance checklist (mapped to real mechanisms)

- [x] **Tenant isolation** — RLS (hard wall, `withTenantTx`) + ADR-0022 visibility authz (`scopeFor`)
  for team/owner records; `visibleContactIds` blocks IDOR; no cross-tenant resolution.
- [ ] **Bounded queries** — projection + metric reads indexed and limited (PLAN_05 / `06 §2`); no full
  scans (build responsibility).
- [x] **Pool safety** — projection + snapshot builds are batched in workers, off replicas (`18 §6`).
- [x] **Online-safe migrations** — `NOT VALID`→`VALIDATE`; shadow-built projections; additive columns;
  no hot-table locks.
- [x] **Cache correctness** — projection cache namespace-versioned (`workspace_search_state` ≡ PLAN_05
  versioning), bumped on write; money/permission never stale (`18 §5`).

## 9. Acceptance criteria (reconciled — already-met vs net-new)

- [x] **Identity spine unique per (workspace) + ≥1 key** — enforced (blind-index uniques +
  `runImport.ts:93`).
- [x] **No IDOR** — RLS + `visibleContactIds`; workspace isolation itest gates merge.
- [ ] **`scopeFor` is the single app-layer visibility predicate** — net-new (consolidate owner/team/
  list filter once; RLS remains the hard wall).
- [ ] **Projection parity verified vs core; search latency within `18 §2`** — net-new (PLAN_05).
- [ ] **Quality dashboard live** (fill/bounce/conflict/freshness) — net-new (`22`/`11`).

## 10. Scale-gate · Failure modes · Open questions

**Scale-gate:** projection build + divergence at billions → deferred PLAN_05 (OpenSearch/ClickHouse,
CDC); the per-workspace metric rollup runs off replicas/ClickHouse, not OLTP.

**Failure modes:** (F1) projection/core divergence → RYOW + `search_outbox` reconcile + a self-heal
sweep (PLAN_05). (F2) `scopeFor` drift / a path bypassing it → RLS is the **DB-enforced** backstop, so
a missed app filter narrows visibility-within-workspace but **cannot** cross the workspace wall. (F3)
constraint `VALIDATE` lock on a large table → `NOT VALID` first, validate online, batched/monitored.

**Open questions:** (1) projection cost-vs-query-gain — **measure before committing** (PLAN_05 trigger,
owner: `truepoint-operations`). (2) Divergence-detection + self-heal cadence — owner: PLAN_05. (3)
Quality-metric snapshot frequency + retention — owner: `22`/`19`. (4) The **visibility-default
decision is settled by ADR-0022** (workspace-default) — recorded, not reopened.

## Sources

Code (verified): `packages/db/src/repositories/searchRepository.ts` (`:41,:90,:206`),
`packages/db/src/rls/contacts.sql`, `packages/db/src/client.ts`, `packages/core/src/prospect/bulkActions.ts`
(+ `contactRepository.visibleContactIds`), `packages/core/src/data-health/dataQualityScore.ts`,
`packages/db/src/schema/{contacts,lists}.ts`, `packages/core/src/import/runImport.ts:93`. Design:
ADR-0022/0006/0021/0035; data-management `06`/`02`/`04`/`01 §6`; `prospect-company-data` PLAN_04/PLAN_05
(+ C10); `22-data-quality-freshness-lifecycle.md`; `11`/`24`; `list-plan` D4.
