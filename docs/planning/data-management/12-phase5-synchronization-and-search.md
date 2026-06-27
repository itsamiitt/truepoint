# 12 — Phase 5: Synchronization & Search (execution spec)

> **Gate:** PLAN / execution spec. **Posture:** reconcile-and-cite — composes `07-sync.md` (CRM
> conflict resolution) + `06-storage-and-scale.md` (search) + ADR-0008 (ICP scoring) + `08 §5` (bulk
> COPY). **Converts** the incoming brief *"06 — Phase 5: Synchronization & Search."* Builds on
> `06`/`07`/`08`/`09`. **Depends on** Phases 1–4. **No source code is modified by this gate.**

## 1. Objective (and how much already exists)

The brief asks for bi-directional CRM sync with deterministic conflict resolution, activity write-back,
webhook propagation, a scalable exact-vs-ranked search layer, ICP scoring, and resumable bulk ops.

**Sync conflict resolution is designed (`07`); search exists (Postgres-native) with the engine path
deferred (`06`/PLAN_05); ICP scoring is shipped (ADR-0008); webhooks are built.** The genuine gaps are
the **CRM-sync build**, **activity write-back**, **true ranked search + projections**, **per-workspace
ICP tuning**, and the **bulk COPY pipeline** — each cited to its design (§5), not redesigned.

## 2. Premise corrections (reported refuted / misstated, with `file:line`)

| Brief premise | Verdict | Evidence |
|---|---|---|
| "Bulk ops: COPY-based engine (the same one **consolidated in Phase 1**)" | **Wrong** | Phase 1 is **row-by-row** (`runImport.ts`); the COPY-staging engine is **designed-but-unbuilt** (ADR-0036; `08 §5`). Nothing was consolidated in Phase 1. |
| "ranked-text path" (implying relevance ranking today) | **Misstated** | today's text search is **ILIKE-contains** (`searchRepository.ts:169-174,:365`), not relevance ranking. True ranked search is the **deferred** OpenSearch path (ADR-0035 / PLAN_05; `06 §3`). |
| ICP scoring to "build" | **Already built** | ADR-0008: `scores`/`intent_signals`/`priority_score` + the `scoring` worker (`computeScore`). Per-workspace tuning/model-registry is the net-new. |
| "Option B: field-level source-of-truth + provenance-aware merge" | **Already designed** | this **is** `07 §2.1-2.2` (field-level SoT + LWW tiebreak + review queue + dedup-on-write + `pin`). |

Per the gate's faithful-reporting rule (`01 §6`, DM3), the spec plans on the **actual** state below.

## 3. Current state

- **Sync: greenfield** — CRM names appear only as import `source_name` (`schema/contacts.ts:269`); the
  full bi-directional design lives in `07-sync.md` (unbuilt).
- **Webhooks: built** — outbound subscriptions + deliveries, signed, retries, DLQ, `ssrfGuard`
  (`core/src/webhooks/*`; `26 §4`).
- **Search: built (Postgres-native)** — `searchRepository`: exact-identity via dedup keys
  (`findByDedupKeys`, Phase 1); faceted/name/typeahead via ILIKE (`:48-80,:169-174,:365`); exact
  `select-all` count for "select all N results" (`:289`); workspace-isolated via RLS. The
  OpenSearch/ClickHouse engine + projections are deferred (PLAN_05).
- **ICP / lead scoring: built** — `scores` (versioned `icp_fit`/intent/engagement/composite +
  `score_breakdown`), `intent_signals` (weight 1–10, typed), `contacts.priority_score` (AFTER-INSERT
  trigger), `scoring` worker → `computeScore`; **workspace-private, not a billable reveal** (ADR-0008).
- **Bulk: row-by-row** — the COPY pipeline is `08 §5` / ADR-0036 (unbuilt).

## 4. Brief → real-model mapping (do not fork the schema)

| Brief artifact | Real model | Where |
|---|---|---|
| `sync.connection` (creds, mappings, direction) | `07` `integrations` (OAuth, KMS) + `sync_field_policy` (per-field direction + SoT) | `07 §3` |
| `sync.cursor` | `07` `sync_state` (external_id, last_synced_at, cursor) | `07 §3` |
| `sync.conflict_log` | `07` `sync_conflicts` (review/exception queue) | `07 §3` |
| `sync.activity_writeback` | **net-new** (calls/emails/sequence events → CRM) | `07`/`26 §2` |
| `search(query, scope)` | `SearchPort` / `searchRepository` (exact + ILIKE today; ranked deferred) | `06 §3` |
| `scoreICP(entity, workspaceICP)` | `computeScore` → `scores.icp_fit_score` | ADR-0008 |
| bulk COPY engine | ADR-0036 staging pipeline | `08 §5` |

**Do not introduce a `sync.*` namespace — use `07`'s tables.**

## 5. The genuine net-new (cite the design)

1. **CRM-sync build** (`07` design → code): field-level source-of-truth conflict resolution +
   **dedup-on-write via the deterministic match keys** (upsert on a stable key) + per-field direction +
   `field_provenance.pin` protecting human edits + echo prevention + rate-limit/batch (`07 §2`).
2. **Activity write-back** — push calls/emails/sequence events to the CRM (`07`/`26 §2`), suppression-
   and reveal-gated like export.
3. **True ranked search + projection layer** — OpenSearch (ranked, `search_after`) + ClickHouse facets
   + the namespace-versioned projection read-model (`proj.*_search` + `search_outbox`); deferred scale
   track (PLAN_05 / `06 §3`). The exact-identity path stays a direct indexed lookup.
4. **Per-workspace ICP tuning / model registry** — ADR-0008 *Revisit if* (the AI/ICP features `05 §16`
   compute against the existing `scores` model); the engine + storage already exist.
5. **Bulk COPY pipeline** — ADR-0036 / `08 §5` (chunked, resumable, three-way accounting) — the real
   "lakh-row import/export" engine the brief assumes; it is the Phase-1 spec's net-new, **not** already
   consolidated.

## 6. Sync algorithm (reconciled)

1. **Incremental pull** via `sync_state` cursor.
2. **Map external → canonical identity** via the Phase-1 resolver (`matchKeys` / `resolveForImport`) —
   the same deterministic ladder, no second resolver (DM1).
3. **Per-field conflict resolution** via provenance/confidence/source-of-truth: `field_provenance.src`
   priority + `conf` + `pin` (human-edited never overwritten); LWW only as a tiebreak on enrichment-
   owned fields; contested → `sync_conflicts` review (`07 §2.1-2.2`).
4. **Governance gate** — suppressed/erased records **never** sync out: reuse the `08 §3.2` export
   anti-join + the `deleteFanout` global-suppression row (`deleteFanout.ts:53-54`); honor consent.
5. **Push canonical changes + activity write-back**; log conflicts; **webhook propagation** for
   downstream consumers (`26 §4`).

## 7. Migration & rollout (reconciled)

- **Expand** — `07` sync tables (`integrations`/`sync_field_policy`/`sync_state`/`sync_conflicts`)
  additive; ICP-tuning + projection tables additive.
- **Shadow** — **dry-run sync** (log diffs, **no CRM writes**); shadow search compared to current
  (PLAN_05 parity).
- **Cutover** — enable per-tenant, **one CRM at a time**; monitor `sync_conflicts` + drift; switch reads
  to projections behind a flag.
- **Rollback** — disable the connection per tenant; search reverts to the Postgres-native path via flag;
  projections are derived (safe to drop).

## 8. Gate-compliance checklist (mapped to real mechanisms)

- [x] **Tenant isolation** — sync creds/cursors per tenant (KMS, server-side); resolver runs under
  `withErTx`/`withTenantTx` (never crosses tenants); **suppressed/erased excluded from outbound sync**
  (`08 §3.2`).
- [ ] **Bounded queries** — search paths indexed/limited; bulk chunked + resumable (PLAN_05 / ADR-0036).
- [x] **Pool safety** — sync + bulk in workers, short tx, per-tenant rate limits/quotas (`18 §9`).
- [x] **Online-safe migrations** — additive sync/projection tables; bulk backfills off-peak.
- [x] **Cache correctness** — search cache namespace-versioned, bumped on entity write (PLAN_05 / `18 §5`).

## 9. Acceptance criteria (reconciled — already-met vs net-new)

- [x] **ICP scoring per workspace** — `computeScore`/`scores` (ADR-0008).
- [x] **Exact-identity path** — dedup-key lookup (`findByDedupKeys`).
- [x] **Suppressed/erased never leave via export** — `08 §3.2`; **extends to sync** (§6 step 4).
- [ ] **Field-level conflict resolution deterministic + logged** — net-new (`07` build → `sync_conflicts`).
- [ ] **Exact + ranked search within latency at lakh scale** — net-new (PLAN_05 ranked/projections).
- [ ] **Bulk import/export resumable** — net-new (ADR-0036).
- [ ] **Per-workspace ICP tuning** — net-new (ADR-0008 *Revisit if*).

## 10. Scale-gate · Failure modes · Open questions

**Scale-gate:** ranked search + facets at billions → deferred OpenSearch/ClickHouse (PLAN_05); CRM
write fan-out → per-tenant queue quotas + batch/upsert (`07 §2.5`, `18 §9`).

**Failure modes:** (F1) **bi-directional echo / ping-pong** — prevented by per-field direction + a
time-threshold LWW tiebreak; never sync back a field that just arrived (`07` F3). (F2) duplicate created
in the customer CRM → dedup-on-write upsert-on-stable-key (`07 §2.3`). (F3) suppressed/erased record
leaks via sync → the governance anti-join + global suppression (§6 step 4). (F4) a second resolver for
sync → forbidden (DM1; reuse `matchKeys`).

**Open questions:** (1) CRM **rate limits vs sync freshness** — batch/backoff + freshness SLO (`07 §2.5`;
owner: platform). (2) **ICP model inputs + per-workspace tuning** — ADR-0008 *Revisit if* (owner:
product/data). (3) Unified-API (Merge.dev) vs hand-built connectors (`07` OQ2). (4) Projection
cost-vs-gain trigger (`10`/PLAN_05; owner: `truepoint-operations`).

## Sources

Code (verified): `packages/db/src/repositories/searchRepository.ts` (`:48-80,:169-174,:289,:365`),
`apps/workers/src/queues/scoring.ts` (+ core `computeScore`), `packages/db/src/schema/intel.ts`
(`scores`/`intent_signals`), `packages/core/src/import/{runImport,matchKeys}.ts`,
`packages/core/src/compliance/deleteFanout.ts`, `packages/core/src/webhooks/*`. Design: data-management
`07` (CRM sync), `06` (search), `08 §5` (bulk COPY), `09`/`01`; ADR-0008 (scoring), ADR-0035 + PLAN_05
(ranked search/projections), ADR-0036 (bulk), ADR-0021/0037 (resolver); `26 §2` (CRM/activity);
`08 §3.2` (export anti-join).
