# 15 — Future Enhancements

> **Series:** [Database Management](./README.md) · **Type:** Vision · **Status:** ✅ Authored ·
> **Prev:** [`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md) · **Next:**
> [`README`](./README.md)

## Objective

This document describes the long-horizon program for TruePoint's data platform — the capabilities that
sit **beyond** the four canonical phases laid out in [14-Implementation-Roadmap](./14-Implementation-Roadmap.md).
Phase 3+ (Govern & Scale) is the last *committed* tier; everything here is the **vision tail** that follows
it. These are not speculative greenfields — every theme is grounded in primitives that already exist on
branch `feat/data-mgmt-01-research-brief` (the master graph, `match_links`, `field_provenance`, the audited
`withPlatformTx` path, the retention engine, the daily snapshot rollup, the audit ledger). The job of this
document is to show **where the existing rails go** once the control panel ([04-Control-Panel-Architecture](./04-Control-Panel-Architecture.md))
is mature, and to keep each future bet honestly sequenced against the roadmap so we never promise a Phase-5
capability on a Phase-1 foundation.

Six themes:

1. [CRM bidirectional sync console](#1-crm-bidirectional-sync-console)
2. [Probabilistic ER at scale](#2-probabilistic-entity-resolution-at-scale)
3. [Record version-history, temporal model & rollback](#3-record-version-history-temporal-model--rollback)
4. [Automation & rules engine](#4-automation--rules-engine)
5. [Residency & multi-region operations](#5-residency--multi-region-operations)
6. [AI-assisted data ops](#6-ai-assisted-data-ops)

Each theme follows the same skeleton: **Enterprise best practice** (cited to
[02-Enterprise-Research](./02-Enterprise-Research.md)) → **Recommended direction** → **Dependencies** →
**Sequencing relative to [14](./14-Implementation-Roadmap.md)** → **Open questions**.

### Reading the status badges

| Badge | Meaning in this doc |
|---|---|
| `Shipped` | Already in the codebase and reachable. |
| `Dark` | Built but flag-gated off (e.g. bulk import, verification). |
| `Inert` | Built but does nothing yet (e.g. retention shadow mode). |
| `Partial` | Some of it exists; the rest is the future bet here. |
| `Planned` | Committed inside [14](./14-Implementation-Roadmap.md), Phase 0–3+. |
| `Missing` | Does not exist; this doc proposes it as a future bet. |

### Precedence reminder (carried from `CLAUDE.md`)

Nothing in this vision relaxes the platform invariants. Every cross-tenant write still goes through
`withPlatformTx` (audited, owner connection behind a verified `pa` claim) — see
[12-Security-and-Compliance](./12-Security-and-Compliance.md). Every customer-scoped write still goes
through `withTenantTx` (RLS, fail-closed). **Security has final say on safety; Platform owns the tenancy
mechanism, the API contract, and scale; Data owns the model and ownership semantics.** A future feature that
needs an un-audited or un-scoped write is not a feature — it is a bug that has not been caught yet.

---

## 1. CRM bidirectional sync console

> **Status:** `Missing` (console) over a `Planned` engine — the engine is fully specified in
> `docs/planning/crm-sync/00-enterprise-implementation-plan.md`; this section adds the **staff operating
> surface** for it.

The single largest post-roadmap surface. The CRM sync *engine* (connector abstraction, sync loop, conflict
resolution, erasure propagation) has its own enterprise implementation plan at
`docs/planning/crm-sync/00-enterprise-implementation-plan.md:140` (architecture) and
`:243` (data model). This theme is about the **Data-management console surface** that operates it: the
9th sub-area under the admin Data management nav group defined in
[04-Control-Panel-Architecture](./04-Control-Panel-Architecture.md).

### Enterprise best practice

[02 §4.21 Operational tooling](./02-Enterprise-Research.md#421-operational-tooling) is explicit that mature
data platforms ship **bidirectional merge-sync and deletion-sync** as first-class operational tooling, not
as a fire-and-forget integration: a merge in TruePoint must propagate to the connected CRM, and a deletion
in either direction must propagate to the other. [02 §4.11 Audit logs](./02-Enterprise-Research.md#411-audit-logs)
demands that **source/workflow provenance attach to every record** so a synced field can be traced to the
CRM write that produced it. [02 §4.19 Error handling](./02-Enterprise-Research.md#419-error-handling) governs
the write-back loop: **never fail the whole batch** — per-record status, separate failed-results artifact,
idempotency keys that replay the first response, backoff+jitter on 429/5xx. The sync engine is a
**background-job + webhook** system ([02 §4.17](./02-Enterprise-Research.md#417-background-jobs)) running in a
**dedicated lane below interactive traffic** ([02 §4.18](./02-Enterprise-Research.md#418-queue-management)),
and **field-level Source-of-Truth** survivorship ([02 §4.14 Data governance](./02-Enterprise-Research.md#414-data-governance))
decides which side wins per attribute.

### Recommended direction

A `features/crm-sync/` feature folder in `apps/admin`, following the
`features/retention/*` template (Tabs + read+write + super-admin gate). It composes new
`/api/v1/admin/data/crm-sync/*` read endpoints over the engine's tables. The engine itself lives in
`apps/workers` (a `crm-sync` queue with its `.dlq` partner, registered in `apps/workers/src/register.ts`
alongside `enrichment`/`dedup`).

**Console layout (four tabs, mirroring `features/retention`'s Tabs pattern):**

```
┌─ Data management ▸ CRM Sync ───────────────────────────────────────────────┐
│ [ Connections ]  [ Field Mapping & SoT ]  [ Run Monitor ]  [ Conflicts ]   │
├────────────────────────────────────────────────────────────────────────────┤
│ CONNECTIONS                                                                 │
│ ┌────────────┬───────────┬──────────┬───────────┬─────────────┬──────────┐ │
│ │ Tenant     │ Provider  │ State    │ Last sync │ Lag (rows)  │ Health   │ │
│ ├────────────┼───────────┼──────────┼───────────┼─────────────┼──────────┤ │
│ │ Acme Corp  │ Salesforce│ ●active  │ 2m ago    │ 14          │ healthy  │ │
│ │ Globex     │ HubSpot   │ ◐paused  │ 3h ago    │ 1,208       │ degraded │ │
│ │ Initech    │ Salesforce│ ○error   │ 1d ago    │ —           │ down     │ │
│ └────────────┴───────────┴──────────┴───────────┴─────────────┴──────────┘ │
│  StatusBadge tones: healthy=success, degraded=warning, down=danger          │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Connections** — `DataTable<CrmConnection>` from `@leadwolf/ui`, one row per tenant connection. Columns:
  tenant, provider (`salesforce`|`hubspot`), connection state, last successful sync, **sync lag** (rows
  pending each direction), OAuth-token health. Row actions (gated by `data:manage` + JIT elevation for
  high-risk): pause/resume sync, force full re-sync, rotate OAuth token, disconnect. Each action is a
  `withPlatformTx` write that records a `platform_audit_log` row in the same transaction (see
  `crm-sync/00:707` Security & multi-tenancy).
- **Field Mapping & SoT** — the **field-level Source-of-Truth matrix** per
  [02 §4.14](./02-Enterprise-Research.md#414-data-governance). For each mapped field, show which side wins
  (`truepoint`|`crm`|`most_recent`|`most_complete`) and the survivorship rule. This is the console face of
  `field_provenance` (`contacts.field_provenance`, `schema/contacts.ts`) extended with a `crm_source`
  dimension — when CRM is SoT for a field, the provenance winner-map records the connector as the source.
- **Run Monitor** — per [02 §4.20 Monitoring dashboards](./02-Enterprise-Research.md#420-monitoring-dashboards):
  job state + record counts per sync run, **per-direction** (inbound CRM→TruePoint, outbound
  TruePoint→CRM). Drill into a run to a per-record status array (the failed-results artifact from
  [02 §4.19](./02-Enterprise-Research.md#419-error-handling)), reusing the import drill-down component
  from [05-Upload-Pipeline-Design](./05-Upload-Pipeline-Design.md) (chunks/rows/rejects).
- **Conflicts** — a steward queue for write-back conflicts the engine could not auto-resolve (both sides
  changed the same SoT field between syncs). Two-threshold disposition exactly as the ER review queue
  ([07-Deduplication-and-Linking](./07-Deduplication-and-Linking.md)): auto-resolve / steward-review /
  hold. Bias to **not** clobbering CRM data (the [02 §4.9](./02-Enterprise-Research.md#49-manual-review-queues)
  false-negative bias).

**Deletion-sync** is the security-critical leg. A DSAR deletion (`packages/core/src/compliance/deleteFanout.ts`)
or a retention `enforce` delete ([06 of the retention engine](./12-Security-and-Compliance.md)) must
**propagate to the connected CRM** as an erasure instruction, and an inbound CRM deletion must enqueue a
TruePoint suppression. This is `crm-sync/00:707` erasure propagation — it is owned by Security and is not
optional.

### Dependencies

| Needs | Why | State |
|---|---|---|
| CRM sync engine (`crm-sync/00`) | The console operates the engine; no engine, nothing to operate. | `Planned` (separate task) |
| `crm-sync` queue + `.dlq` in `register.ts` | Background lane below interactive ([02 §4.18](./02-Enterprise-Research.md#418-queue-management)). | `Missing` |
| `field_provenance` extended with `crm_source` | SoT matrix + provenance audit trail. | `Partial` (provenance shipped) |
| Maker/checker approval ([09-Review-and-Approval-System](./09-Review-and-Approval-System.md)) | Force-resync / disconnect are high-risk cross-tenant ops. | `Planned` (Phase 2) |
| `withPlatformTx` audited path | Every connection mutation is a cross-tenant write. | `Shipped` (`packages/db/src/client.ts:121`) |
| Erasure/deletion fanout | Deletion-sync both directions; Security-owned. | `Shipped` (`deleteFanout.ts`), needs CRM leg |
| `data:manage` staff capability | Gate on connection mutations. | `Planned` (Phase 1, `packages/types/src/staffCapability.ts`) |

### Sequencing relative to [14](./14-Implementation-Roadmap.md)

**After Phase 3+.** [14](./14-Implementation-Roadmap.md) already names "CRM bidirectional sync console" as a
Phase 3+ enterprise item, but it is the *console* that is Phase 3+; the *engine* is a parallel program. The
realistic order: (a) ship the maker/checker approval system (Phase 2) and the monitoring dashboards
(Phase 2) first — the console reuses both; (b) ship the engine's Phase-1 slice (`crm-sync/00:1096`, one
direction, one provider) behind a flag; (c) then build this console on top. The console is **post-roadmap**
because it presupposes the engine, which is itself a multi-phase effort.

### Open questions

- **Q1.** Does write-back conflict resolution reuse the ER `match_links.review_status` machinery, or does it
  need its own `crm_sync_conflicts` table? (Leaning: separate table — a sync conflict is field-level, an ER
  conflict is entity-level.)
- **Q2.** Is deletion-sync **synchronous within the DSAR transaction** (risk: CRM API latency blocks the
  erasure) or **enqueued with a guaranteed-delivery DLQ + reconciliation sweep**? Security must rule; leaning
  enqueued-with-reconciliation so a CRM outage never blocks a legal erasure.
- **Q3.** Per-tenant rate-limit budget against the CRM API — does it live in the same metered-spend model as
  enrichment (`provider_configs` monthly budget), or a separate quota? See
  [13-Performance-and-Scaling](./13-Performance-and-Scaling.md).

---

## 2. Probabilistic entity resolution at scale

> **Status:** `Partial` — deterministic ER is `Shipped`; Splink + the clerical retune loop are deferred
> (ADR-0021); `masterGraphMatcher` is a `STUB`
> (`packages/core/src/enrichment/bulk/masterGraphMatcher.ts`).

[07-Deduplication-and-Linking](./07-Deduplication-and-Linking.md) ships the deterministic-first half. This
theme **graduates the probabilistic tail**: Splink-style Fellegi–Sunter scoring on the residue
deterministic rules cannot resolve, run over the **global master graph** (`master_persons`,
`master_companies`, `master_employment`, `match_links`), with a **clerical retune loop** so steward decisions
feed back into the model.

### Enterprise best practice

[02 §4.6 Record linking](./02-Enterprise-Research.md#46-record-linking) is the spine: pairwise comparisons are
**not** entities — you build nodes+edges then take **connected components** via Union-Find/DSU at scale;
**Fellegi–Sunter m/u probabilities** sum to match weights (TF-adjusted for rare values); and the **weight
decomposition is the audit trail** (the Splink model). [02 §4.22 Scalability](./02-Enterprise-Research.md#422-scalability-strategies)
names **blocking** as the load-bearing decision — `n(n-1)/2` all-pairs is fatal at master-graph scale, so
OR-combined strict blocking rules must be measured *before* a run, and DSU clustering runs on a distributed
engine. [02 §4.9 Manual review queues](./02-Enterprise-Research.md#49-manual-review-queues) defines the
**two-threshold** disposition (auto-merge / steward-review / auto-reject, the D&B Confidence Code) with a
**bias to false-negatives over Frankenstein merges**, and the **flag → correction-queue-with-SLA → retune**
loop. [02 §4.10 Quality scoring](./02-Enterprise-Research.md#410-quality-scoring) reinforces **numeric
confidence, not boolean** — which is exactly `match_links.match_probability`.

### Recommended direction

The schema is **already shaped for this** — `match_links` carries `cluster_id` (golden entity id),
`match_probability`, `match_method` (`deterministic`|`splink`|`manual`), `is_duplicate_of` (survivor link),
and `review_status` (`auto`|`pending`|`confirmed`|`rejected`). The deferred work:

1. **Splink scoring stage.** Replace the `masterGraphMatcher` STUB with a real Fellegi–Sunter scorer. It runs
   on the residue: records deterministic rules left at `review_status='pending'`. Output is a
   `match_probability` and a **weight decomposition** (per-comparison contribution) persisted as JSON so the
   steward console can show *why* two records scored together — the [02 §4.6](./02-Enterprise-Research.md#46-record-linking)
   audit-trail mandate.

   ```sql
   -- new column on match_links (migration 0035+), additive, nullable
   ALTER TABLE match_links
     ADD COLUMN weight_decomposition jsonb,   -- [{field, m, u, weight, agreed}]
     ADD COLUMN blocking_rule_id     text,    -- which OR-rule produced the candidate pair
     ADD COLUMN model_version        text;    -- the resolution-rule version (see Theme 3 / §4.12)
   ```

2. **Blocking as an explicit, measured artifact.** A `er_blocking_rules` registry (OR-combined strict rules:
   same `email_blind_index`, same `linkedin_public_id`, same normalized name + `email_domain`). Each rule's
   **candidate-pair fan-out is measured before a run** ([02 §4.22](./02-Enterprise-Research.md#422-scalability-strategies))
   and surfaced in the console so an operator never launches an all-pairs catastrophe.

3. **DSU clustering pass.** Connected-components over confirmed edges to assign `cluster_id`. At master-graph
   scale this is the distributed-engine step from [02 §4.6](./02-Enterprise-Research.md#46-record-linking) —
   a `master-er-sweep` queue (leader-locked, like `master-backfill-sweep` in `register.ts`).

4. **Company-first anchoring.** Per [02 §4.7](./02-Enterprise-Research.md#47-company-person-relationships)
   (ZoomInfo "Super Six"): resolve `master_companies` on `domain` **first**, then attach `master_persons`
   via `master_employment` edges (email/LinkedIn URL), distrusting raw company-name strings.

5. **Clerical review console + retune loop.** The "Validation, Dedup & Linking" sub-area
   ([04](./04-Control-Panel-Architecture.md)) gains a **probabilistic review queue** keyed on
   `match_links.review_status='pending' AND match_method='splink'`. Steward dispositions
   (`confirmed`/`rejected`) are **labeled training data**; a periodic job recomputes m/u probabilities from
   the growing labeled set — the [02 §4.9](./02-Enterprise-Research.md#49-manual-review-queues) retune loop.
   The console shows **FP/FN against the labeled set** ([02 §4.20](./02-Enterprise-Research.md#420-monitoring-dashboards)).

```
┌─ Data management ▸ Linking ▸ Clerical Review ──────────────────────────────┐
│ Candidate pair  •  match_probability 0.71  •  method splink  •  v2.3        │
│ ┌──────────────────────────┬──────────────────────────┐                    │
│ │ master_person A          │ master_person B          │  weight breakdown  │
│ ├──────────────────────────┼──────────────────────────┤  ─────────────────  │
│ │ Jane R. Doe              │ Jane Doe                 │  name      +4.1 ✓   │
│ │ jdoe@acme.com            │ j.doe@acme.com           │  email     +2.0 ~   │
│ │ VP Eng @ Acme            │ VP Engineering @ Acme    │  employer  +3.8 ✓   │
│ │ linkedin.com/in/janedoe  │ (none)                   │  linkedin   0.0 –   │
│ └──────────────────────────┴──────────────────────────┘  Σ = +9.9 → 0.71   │
│  [ Confirm match ]  [ Reject ]  [ Hold ]   ← writes review_status (audited) │
└────────────────────────────────────────────────────────────────────────────┘
```

**Non-destructive throughout** ([02 §4.13 Rollback](./02-Enterprise-Research.md#413-rollback-mechanisms)):
the cluster is a *derived* view over preserved `source_records` + `match_links` edges; a wrong merge is undone
by flipping the edge's `review_status` and re-deriving, never by destroying rows. This is the seam into
Theme 3.

### Dependencies

| Needs | Why | State |
|---|---|---|
| Deterministic ER + dedup write-path | Splink runs only on the residue. | `Shipped` (`prospect/dedup.ts`) |
| `match_links` golden-record schema | Edges, probabilities, cluster ids, review status. | `Shipped` |
| Clerical review console | Steward dispositions feed the retune loop. | `Planned` (Phase 1, [07](./07-Deduplication-and-Linking.md)) |
| Distributed clustering engine / leader-locked sweep | DSU at master-graph scale. | `Partial` (`leaderLock.ts` exists; engine choice open) |
| `withErTx` (role `leadwolf_er`) | Master-graph reads/writes off the RLS overlay. | `Shipped` (`client.ts:56`) |
| Labeled-set FP/FN reporting | Monitor model quality. | `Missing` ([10-Monitoring-and-Observability](./10-Monitoring-and-Observability.md)) |

### Sequencing relative to [14](./14-Implementation-Roadmap.md)

**Phase 3+ → post-roadmap.** [14](./14-Implementation-Roadmap.md) lists "probabilistic ER at scale (Splink) +
clerical retune loop" inside Phase 3+. The honest read: the **clerical review console** (deterministic) lands
in Phase 1; the **Splink scorer + retune loop** is the Phase 3+/post-roadmap tail because it needs (a) a
labeled set, which only exists *after* stewards have worked the deterministic queue for a while, and (b) a
distributed clustering decision that depends on master-graph volume we will not have until self-service import
(Phase 2) is widely adopted. **Do not** build Splink before there is labeled data to fit it — that is the
[02 §4.8](./02-Enterprise-Research.md#48-enrichment-pipelines) "test 25–50 rows first" discipline applied to
ER.

### Open questions

- **Q1.** Splink in-process (Python sidecar / DuckDB) vs. a managed offering — TruePoint is a Bun monorepo;
  ER is the one workload that resists Bun. A `master-er` worker that shells to a Python+Splink service is the
  pragmatic seam. [13](./13-Performance-and-Scaling.md) owns this call.
- **Q2.** How long is the steward-labeled set retained, and is it itself PII subject to DSAR? (It is — labeled
  pairs are `master_persons`; the retune corpus must be DSAR-aware.) Security owns this.
- **Q3.** Does `model_version` pin make a re-derivation reproducible? (Required for Theme 3 rollback — you must
  be able to re-run resolution at a historical rule version.)

---

## 3. Record version-history, temporal model & rollback

> **Status:** `Missing` — version history / rollback is called out as Missing in
> [01 §10](./01-Current-State-Analysis.md). The **foundation** (non-destructive golden record,
> `field_provenance`, preserved `source_records`) is `Shipped`.

### Enterprise best practice

[02 §4.12 Version history](./02-Enterprise-Research.md#412-version-history) is unambiguous: the golden record
is a **DERIVED, RECOMPUTABLE view over preserved source rows** (Salesforce Data Cloud's "key ring"), with
**per-field last-validated timestamps**, and you **version the resolution RULES too**.
[02 §4.13 Rollback](./02-Enterprise-Research.md#413-rollback-mechanisms) follows: resolution must be
**NON-DESTRUCTIVE** so you roll back a merge by **re-deriving** (contrast HubSpot's destructive merge), and
jobs must be **idempotent + checkpointed** so a failed import rolls *forward*.
[02 §4.14 Data governance](./02-Enterprise-Research.md#414-data-governance) supplies the survivorship that the
temporal model records: **attribute-level** per-field source-priority/recency/frequency/completeness with
cascading fallbacks.

### Recommended direction

TruePoint is **architecturally primed** for this — the golden record is *already* derived:
`master_persons`/`master_companies` are recomputed from `source_records` via `match_links` edges, and
`contacts.field_provenance` already stores a per-field winner-map (source/confidence). The future bet is to
make the derivation **temporal and reversible**:

1. **Value-level field history.** An append-only `field_history` ledger capturing every field transition with
   its provenance and validation timestamp — the [02 §4.12](./02-Enterprise-Research.md#412-version-history)
   per-field last-validated clock. This is the granular complement to `contacts.last_verified_at` (record-level)
   and `field_provenance` (current-winner only).

   ```sql
   -- migration 0035+; append-only, UPDATE/DELETE blocked by trigger (mirror audit_log)
   CREATE TABLE field_history (
     id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     tenant_id       uuid NOT NULL,
     workspace_id    uuid NOT NULL,                 -- denormalized for RLS scope
     entity_type     text NOT NULL,                 -- 'contact' | 'account'
     entity_id       uuid NOT NULL,
     field_path      text NOT NULL,                 -- 'email_enc' | 'custom_fields.foo'
     old_value_hash  text,                          -- hash, never plaintext PII
     new_value_hash  text,
     source          text NOT NULL,                 -- provider | import | crm | manual | dedup
     confidence      numeric,
     resolution_rule_version text,                  -- the versioned rule that picked the winner
     validated_at    timestamptz,                   -- per-field last-validated clock
     changed_at      timestamptz NOT NULL DEFAULT now(),
     changed_by      uuid,                           -- staff or user; null = system
     job_id          uuid                            -- import/enrichment/dedup job provenance
   );
   -- RLS: workspace_id = NULLIF(current_setting('app.current_workspace_id',true),'')::uuid
   ```

   Note the **hash, never plaintext** discipline — PII (`email_enc`/`phone_enc`) is AES-GCM bytea; the history
   ledger stores hashes so it is not a second PII store. Security owns this constraint
   ([12-Security-and-Compliance](./12-Security-and-Compliance.md)).

2. **Versioned resolution rules.** A `resolution_rule_versions` registry so the survivorship logic
   ([02 §4.14](./02-Enterprise-Research.md#414-data-governance)) is itself versioned. `match_links.model_version`
   (Theme 2) and `field_history.resolution_rule_version` both pin to it. This is what makes a re-derivation
   *reproducible*: "re-derive this record as it would have resolved under rules v2.3."

3. **Non-destructive rollback / undo.** Because the golden record is derived, "undo a merge" = flip the
   offending `match_links` edge to `review_status='rejected'` and re-run the DSU + survivorship derivation —
   no row is destroyed. "Undo a bulk op" (e.g. a bad enrichment run that wrote 40k fields) = a
   **checkpointed, idempotent reversal**: each `enrichment_jobs`/`import_jobs` row already carries counters and
   chunk/row ledgers (`enrichment_job_rows`, `import_job_rows`); a reversal job walks the ledger and
   re-derives each touched field from `field_history` to its prior winner. This is the
   [02 §4.13](./02-Enterprise-Research.md#413-rollback-mechanisms) "roll back by re-deriving" applied to the
   bulk path.

4. **Temporal point-in-time view.** A staff-only "as-of" reader in the control panel: render a contact/account
   *as it was* at timestamp T by replaying `field_history` up to T. Drives the operational root-cause tooling
   in [10-Monitoring-and-Observability](./10-Monitoring-and-Observability.md) — "when did this field go wrong,
   and which job did it?"

```
┌─ Contact ▸ Field History: email_enc ───────────────────────────────────────┐
│ as-of [ 2026-06-29 ▾ ]                                                       │
│ ┌──────────────┬─────────────┬───────────┬────────────┬────────────────────┐ │
│ │ changed_at   │ source      │ confidence│ rule ver   │ job                │ │
│ ├──────────────┼─────────────┼───────────┼────────────┼────────────────────┤ │
│ │ 2026-06-28   │ provider:zi │ 0.94 ★win │ v2.3       │ enrich#a91 [↶ undo] │ │
│ │ 2026-05-02   │ import      │ 0.70      │ v2.1       │ import#7f2          │ │
│ │ 2026-04-10   │ manual      │ 1.00      │ —          │ staff:amit          │ │
│ └──────────────┴─────────────┴───────────┴────────────┴────────────────────┘ │
│  [↶ undo] re-derives to the prior winner (non-destructive, audited)         │
└────────────────────────────────────────────────────────────────────────────┘
```

### Dependencies

| Needs | Why | State |
|---|---|---|
| Non-destructive golden-record model | Rollback = re-derive, not delete. | `Shipped` (derived master graph) |
| `field_provenance` winner-map | The current head that `field_history` versions. | `Shipped` (`contacts.field_provenance`) |
| Checkpointed/idempotent jobs + ledgers | Reverse a bulk op by walking the row ledger. | `Shipped` (`import_job_rows`, `enrichment_job_rows`) |
| Versioned resolution rules | Reproducible re-derivation; pins Theme 2's `model_version`. | `Missing` |
| Append-only ledger + block-mutation trigger | History integrity (mirror `audit_log`). | `Partial` (pattern exists in `schema/billing.ts:169`) |
| AES-GCM PII handling | History stores hashes, not plaintext. | `Shipped` (`email_enc`/`phone_enc`) |

### Sequencing relative to [14](./14-Implementation-Roadmap.md)

**Phase 3+ → post-roadmap.** [14](./14-Implementation-Roadmap.md) places "record version-history/rollback"
in Phase 3+. Sub-sequencing: **versioned resolution rules** must land *with or before* the Splink scorer
(Theme 2) because `model_version` is a shared dependency. **Value-level `field_history`** can begin as a
shadow ledger (write-only, no reader) the moment the enrichment/import/dedup writers are touched — cheap to
start, expensive to backfill, so start the write side early even if the reader/undo UI is Phase 4. The
**bulk-undo** capability is genuinely post-roadmap: it presupposes both `field_history` density and the
maker/checker approval system (an undo of 40k fields is a high-risk op requiring elevation).

### Open questions

- **Q1.** Retention vs. history tension: `field_history` is append-only PII-adjacent (hashes), but DSAR
  ([06 retention engine](./12-Security-and-Compliance.md)) must be able to erase. Resolution: DSAR tombstones
  the *entity* and the history rows become orphaned hashes (no re-identification possible) — but Security must
  confirm hash-only is sufficient under DPDP/GDPR.
- **Q2.** Storage cost of value-level history at master-graph scale — is `field_history` partitioned by month
  and aged into cold storage? [13](./13-Performance-and-Scaling.md) owns the partitioning strategy.
- **Q3.** Does "as-of" need to be exposed to **customers** (Surface 2 self-service) or staff-only? Leaning
  staff-only initially (it is operational root-cause tooling), customer-facing field history a later bet.

---

## 4. Automation & rules engine

> **Status:** `Missing` (declarative engine) over `Shipped` primitives — scheduled sweeps
> (`*-sweep` queues, leader-locked) and the validation framework already exist as the building blocks.

### Enterprise best practice

[02 §4.4 Data validation](./02-Enterprise-Research.md#44-data-validation) defines the **ordered validation
stages** (file → schema → row-level: required/type/format/range/uniqueness/referential/business/cross-field →
aggregation) that a rules engine would express *declaratively* rather than in imperative code.
[02 §4.10 Quality scoring](./02-Enterprise-Research.md#410-quality-scoring) wants **recompute on every
change** with per-dimension sub-scores — a trigger condition for the engine.
[02 §4.21 Operational tooling](./02-Enterprise-Research.md#421-operational-tooling) calls for **tools over the
audit/decision logs** that drive **auto-remediation** (Apollo Duplicate Analyzer → root cause → fix), and
[02 §4.17 Background jobs](./02-Enterprise-Research.md#417-background-jobs) supplies the async + scheduled
substrate.

### Recommended direction

A **declarative data-ops automation engine** — scheduled and event-triggered jobs that evaluate rules and run
remediations, all on top of the existing queue + sweep infrastructure. Three layers:

1. **Declarative quality rules** (from [06-Data-Validation-Framework](./06-Data-Validation-Framework.md)). The
   validation stages become **data**, not code: a `data_quality_rules` table of
   `{scope, field, predicate, severity, action}` rows. Rules are versioned (Theme 3) and tenant-overridable.
   The validation framework's row-level checks (required/type/format/range/uniqueness/referential/business/
   cross-field) are the predicate vocabulary.

   ```sql
   CREATE TABLE data_quality_rules (
     id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     scope        text NOT NULL,        -- 'global' | tenant_id
     entity_type  text NOT NULL,        -- 'contact' | 'account'
     field_path   text NOT NULL,
     predicate    jsonb NOT NULL,       -- {op:'matches', regex:'...'} | {op:'in', set:[...]}
     severity     text NOT NULL,        -- 'info' | 'warn' | 'block'
     action       jsonb,                -- {type:'enqueue', queue:'reverification'} | {type:'flag'}
     enabled      boolean NOT NULL DEFAULT false,  -- fail-closed
     rule_version text NOT NULL,
     created_by   uuid
   );
   ```

2. **Triggers & schedules.** Two firing modes, both on existing rails:
   - **Scheduled** — a leader-locked sweep (`data-automation-sweep`, modeled on `data-quality-snapshot-sweep`
     and `data-retention-sweep` in `register.ts`) that evaluates rules on a cadence.
   - **Event-triggered** — the fan-out points already exist: on `imports` completed the system fans out
     `enqueueDedup + enqueueFirmographics + enqueueMasterBackfill` (`register.ts`); add a rule-evaluation
     hook at the same seam (and on enrichment/verification completion).

3. **Auto-remediation** ([02 §4.21](./02-Enterprise-Research.md#421-operational-tooling)). A rule whose
   predicate fails fires an `action`: enqueue re-verification (`enqueueReverification`), enqueue re-scoring
   (`enqueueScoring`), enqueue enrichment (`enqueueEnrichment`), flag for steward review (write
   `match_links.review_status='pending'`), or **suppress-and-alert**. Remediations that mutate data go through
   the audited path; high-impact remediations (e.g. auto-enrich a whole segment, which *spends money*) require
   **maker/checker pre-approval** ([09](./09-Review-and-Approval-System.md)) and a
   **pre-computed worst-case spend** ([02 §4.16 Approval workflows](./02-Enterprise-Research.md#416-approval-workflows)).

**Console** — an "Automation" sub-tab under Data management: a rule list (`DataTable`), a rule builder
(`Combobox` field-picker + predicate form), a **dry-run** mode (evaluate against current data, show *what
would fire* without acting — the [02 §4.8](./02-Enterprise-Research.md#48-enrichment-pipelines) "test 25–50
rows first" discipline), and a run history.

```
┌─ Data management ▸ Automation ─────────────────────────────────────────────┐
│ [ Rules ]  [ Schedules ]  [ Run History ]            [ + New rule ]         │
├────────────────────────────────────────────────────────────────────────────┤
│ #  Rule                              Trigger        Action          State   │
│ 1  email_status=catch_all > 30d      schedule daily reverify        ●on     │
│ 2  account.domain missing            on import done flag-review      ●on     │
│ 3  priority_score=0 & is_revealed    schedule daily rescore         ◐dry-run │
│  ⚠ Rule 4 (auto-enrich stale segment) → spend gate: needs approval ($1,240) │
└────────────────────────────────────────────────────────────────────────────┘
```

### Dependencies

| Needs | Why | State |
|---|---|---|
| Data validation framework | Supplies the predicate vocabulary. | `Planned` (Phase 1, [06](./06-Data-Validation-Framework.md)) |
| Leader-locked sweep infra | Scheduled rule evaluation. | `Shipped` (`leaderLock.ts`, `*-sweep` queues) |
| Job fan-out seams | Event-triggered evaluation. | `Shipped` (`register.ts` completion fan-out) |
| Maker/checker approval + spend pre-compute | Money-spending / high-impact remediations. | `Planned` (Phase 2, [09](./09-Review-and-Approval-System.md)) |
| Versioned rules | Reproducibility; ties to Theme 3 `rule_version`. | `Missing` |
| `enqueue*` producers | Remediation actions. | `Shipped` (`register.ts`) |

### Sequencing relative to [14](./14-Implementation-Roadmap.md)

**Post-roadmap, after Phase 3+.** The engine is deliberately *last* among the data-ops bets because it is a
**force multiplier over everything else** — it should not be built until the validation framework (Phase 1),
the approval system (Phase 2), and the monitoring dashboards (Phase 2) are mature, because a rules engine is
only as safe as the gates it fires through. Building auto-remediation before maker/checker exists would let a
declarative rule spend money or delete data without a human — a precedence violation. Start with **read-only
rules** (severity `info`/`warn`, action `flag` only); graduate to `block` and to mutating remediations once the
approval rails are proven.

### Open questions

- **Q1.** Rule-evaluation cost at scale — does every rule re-scan, or does the engine maintain incremental
  materialized predicates? [13](./13-Performance-and-Scaling.md) owns this; leaning incremental, evaluated at
  the same point `data_quality_snapshots` are computed.
- **Q2.** Tenant-authored rules (Surface 2) vs. staff-only (Surface 1)? A customer authoring a `block` rule on
  their own workspace is in-scope (RLS-safe via `withTenantTx`); a customer authoring a *spending* remediation
  needs the same spend gate as a bulk enrich.
- **Q3.** How do rule versions interact with the resolution-rule versions in Theme 3? Shared registry or
  separate? Leaning shared `*_rule_versions` namespace so "which logic produced this state" has one answer.

---

## 5. Residency & multi-region operations

> **Status:** `Missing` — single-region today. The tenancy mechanism (`tenant_id`/`workspace_id`, RLS) and
> the deletion fanout are the primitives a residency layer extends.

### Enterprise best practice

This theme is governed by [12-Security-and-Compliance](./12-Security-and-Compliance.md) and the
PII/residency mandates in `CLAUDE.md` (security owns residency). The enterprise pattern is **per-region data
planes** with **sovereign deletion** — a tenant's data physically resides in its jurisdiction's region, and an
erasure executes *within that region* with proof. [02 §4.11 Audit logs](./02-Enterprise-Research.md#411-audit-logs)
(provenance on every record) and the deletion-sync leg of
[02 §4.21](./02-Enterprise-Research.md#421-operational-tooling) extend across regions: an erasure must
propagate to every plane that holds the tenant's data (overlay region + any CRM via Theme 1).

### Recommended direction

1. **Per-region data planes.** Each region (`in`, `eu`, `us`, …) runs its own overlay database with the same
   schema and RLS roles (`leadwolf_app`, `leadwolf_er`). A tenant is **pinned to a home region** at
   provisioning (`tenants.home_region`); `withTenantTx` resolves the region from the verified tenant scope and
   connects to that region's pool. The two-tier tenancy already isolates tenants *logically*; residency adds a
   *physical* dimension on top of the same `tenant_id` axis.

2. **Master graph regionality.** The Layer-0 master graph (`master_companies`, `master_persons`, …) is
   system-owned and not RLS-scoped — the open design question is whether it is **global** (one shared graph,
   cross-region reads) or **per-region** (a graph per plane, no cross-region linkage). The privacy-conservative
   answer Security will likely mandate: **per-region master graphs** for person data (PII), with a **global**
   company graph (firmographics are not personal data). This bounds entity resolution (Theme 2) to within a
   region for persons.

3. **Sovereign deletion.** A DSAR/retention erasure
   (`packages/core/src/compliance/deleteFanout.ts`) executes **within the tenant's home region** and emits a
   **regional erasure certificate** (an append-only `audit_log` row + a signed proof). The deletion fanout
   extends to: the overlay plane, the regional master graph, the search index for that region, and — via Theme
   1 — the connected CRM. No data crosses a region boundary during erasure.

4. **Region-aware control panel.** The admin Data-Ops Overview ([10](./10-Monitoring-and-Observability.md))
   gains a region dimension — queue depths, run tallies, and quality snapshots **per region**. A staff member
   in one region cannot operate on another region's tenants without explicit cross-region elevation (a
   stronger JIT gate).

```
┌─ Data management ▸ Overview ──────────────  region: [ all ▾ ]──────────────┐
│  ┌── in (Mumbai) ──┐  ┌── eu (Frankfurt) ─┐  ┌── us (Virginia) ─┐          │
│  │ tenants    412  │  │ tenants     88    │  │ tenants     —    │          │
│  │ queue lag  14   │  │ queue lag   2     │  │ (no plane yet)   │          │
│  │ DSAR open  3    │  │ DSAR open   1     │  │                  │          │
│  └─────────────────┘  └───────────────────┘  └──────────────────┘          │
│  ⓘ erasure certificates are regional — no cross-region data movement        │
└────────────────────────────────────────────────────────────────────────────┘
```

### Dependencies

| Needs | Why | State |
|---|---|---|
| Two-tier tenancy + RLS | The logical axis residency makes physical. | `Shipped` (`withTenantTx`, `client.ts:74`) |
| Deletion fanout | Sovereign erasure extends it per-region. | `Shipped` (`deleteFanout.ts`) |
| Per-region connection routing | `withTenantTx` resolves region → pool. | `Missing` (single pool today) |
| `tenants.home_region` + provisioning | Pin a tenant to a region. | `Missing` |
| Per-region search planes | Search is per-region (`SearchPort` per region). | `Partial` (`SearchPort` seam exists, in-memory only) |
| CRM deletion-sync (Theme 1) | Erasure crosses to the CRM plane. | `Missing` |

### Sequencing relative to [14](./14-Implementation-Roadmap.md)

**Post-roadmap, latest of the six.** [14](./14-Implementation-Roadmap.md) names "residency/multi-region ops"
in Phase 3+, and it is the **deepest** Phase 3+ item — it touches connection routing, the master-graph design,
search, *and* deletion, so it presupposes the retention engine being in `enforce` (Phase 3+), the CRM
deletion-sync leg (Theme 1, post-roadmap), and probabilistic ER's per-region scoping decision (Theme 2). It is
sequenced **after Themes 1–2** and is **demand-driven**: build the second region only when a contractual
EU/US residency requirement is signed, not speculatively. The architecture (region as a dimension on the
existing `tenant_id` axis) should be *designed* early so it is not retrofitted, but the second plane is built
on demand.

### Open questions

- **Q1.** Global vs. per-region master graph for persons — Security decides. This is the load-bearing
  question; it determines whether ER (Theme 2) is global or regional and whether company firmographics can be
  shared. Leaning: per-region persons, global companies.
- **Q2.** Cross-region staff operations — does a `super_admin` in region `in` operate region `eu` at all, or is
  staffing itself regionalized? Likely a new cross-region elevation gate stronger than today's JIT.
- **Q3.** Where do the dark stores live — bulk-import object store (`BULK_IMPORT_STORAGE_DIR` today, prod
  object store on enable) and the verification vendor — must each be regional. The object-store adapter chosen
  in Phase 0 should be region-parameterizable from day one.

---

## 6. AI-assisted data ops

> **Status:** `Missing` — no AI layer today. Every input is the audit/decision logs, snapshots, and provenance
> that **already exist**; the AI is a *reader* over them, never a new write authority.

### Enterprise best practice

[02 §4.21 Operational tooling](./02-Enterprise-Research.md#421-operational-tooling) is the anchor: build
**tools over the audit/decision logs** (Apollo Duplicate Analyzer surfaces *root cause*) — AI is the natural
escalation of that idea, reading the same logs to surface patterns a human would miss.
[02 §4.20 Monitoring dashboards](./02-Enterprise-Research.md#420-monitoring-dashboards) (per-dimension quality
metrics, segment match-rate by size/geo/seniority) is the substrate for **anomaly detection**.
[02 §4.1 Data ingestion](./02-Enterprise-Research.md#41-data-ingestion) + the mapping-as-UI-step from
[02 §4.3 Import pipelines](./02-Enterprise-Research.md#43-import-pipelines) motivate **assisted column-mapping**.
[02 §4.9 Manual review queues](./02-Enterprise-Research.md#49-manual-review-queues) motivates **merge
suggestions** as a steward accelerator.

### Recommended direction

Three concrete, grounded assists. **Hard rule: AI never has write authority.** It produces *suggestions* that
land in the existing review/approval queues; a human (or a gated rule) commits. This keeps the precedence
intact — AI is a UX accelerator, not a security boundary.

1. **Anomaly detection on quality metrics.** The `data_quality_snapshots` table is a **daily per-workspace
   jsonb rollup** (`schema/dataQualitySnapshots.ts`, migration 0031) — a ready-made time series. A detector
   flags outliers (a tenant whose `email_status=valid` rate dropped 20pts overnight; a segment whose match
   confidence collapsed; a verification yield that fell off a provider). The detector writes an **alert**, not
   a mutation; the alert lands in the [10-Monitoring-and-Observability](./10-Monitoring-and-Observability.md)
   dashboard and (if severe) pages per [truepoint-operations]. This is the first AI assist to build because it
   is pure read over an existing series — zero new write surface, maximal safety.

2. **Assisted column-mapping + merge suggestions.** During import mapping
   ([05-Upload-Pipeline-Design](./05-Upload-Pipeline-Design.md)), an LLM proposes a `column_mapping` from
   header names + sampled values; the operator confirms (the [02 §4.3](./02-Enterprise-Research.md#43-import-pipelines)
   "mapping/validation as visible UI steps before persist" rule — AI fills the form, the human approves it).
   For ER, an LLM proposes merge dispositions in the Theme-2 clerical queue (a *suggestion* with rationale,
   alongside the deterministic weight decomposition) — the steward still clicks Confirm/Reject. The
   [02 §4.9](./02-Enterprise-Research.md#49-manual-review-queues) false-negative bias is preserved: a
   low-confidence AI suggestion defaults to "review", never "auto-merge".

3. **NL data-ops queries over the audit/decision logs.** A natural-language console over `audit_log`,
   `platform_audit_log`, `match_links`, and the job ledgers — "show every contact whose email was overwritten
   by provider X in the last week and later bounced", "which import job created the most duplicates last
   month" (the [02 §4.5](./02-Enterprise-Research.md#45-duplicate-detection) "instrument dup creation"
   provenance, now queryable in English). The NL layer **compiles to scoped, read-only, parameterized
   queries** executed through the existing audited read paths (`withPlatformTx` for cross-tenant reads,
   `withTenantTx` for scoped) — it never emits free-form SQL, and it never writes.

```
┌─ Data management ▸ Ask ────────────────────────────────────────────────────┐
│  ▸ "which import job created the most duplicates last month?"               │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Compiled (read-only, audited):                                             │
│    over import_job_rows + match_links where match_method='deterministic'    │
│  ┌──────────────┬──────────┬────────────┬──────────────────────────────┐    │
│  │ import_job   │ tenant   │ dupes      │ root cause                    │    │
│  ├──────────────┼──────────┼────────────┼──────────────────────────────┤    │
│  │ import#7f2   │ Acme     │ 1,204      │ CRM export, no dedup-on-write │    │
│  └──────────────┴──────────┴────────────┴──────────────────────────────┘    │
│  ⓘ result is a query, not an action. To remediate → Automation (gated).     │
└────────────────────────────────────────────────────────────────────────────┘
```

For Anthropic/Claude model selection, params, tool-use shape, and caching of these AI assists, consult the
`claude-api` skill at build time rather than hard-coding a model here.

### Dependencies

| Needs | Why | State |
|---|---|---|
| `data_quality_snapshots` time series | Anomaly detection substrate. | `Shipped` (migration 0031) |
| Audit + decision logs | NL query corpus; merge rationale. | `Shipped` (`audit_log`, `platform_audit_log`, `match_links`) |
| Monitoring dashboards | Where anomaly alerts surface. | `Planned` (Phase 2, [10](./10-Monitoring-and-Observability.md)) |
| Clerical review queue | Where merge suggestions land. | `Planned` (Phase 1, [07](./07-Deduplication-and-Linking.md)) |
| Import mapping UI | Where column-mapping suggestions land. | `Planned` (Phase 0/1, [05](./05-Upload-Pipeline-Design.md)) |
| Scoped read paths | NL queries compile to audited reads only. | `Shipped` (`withPlatformTx`/`withTenantTx`) |

### Sequencing relative to [14](./14-Implementation-Roadmap.md)

**Post-roadmap, but **incrementally insertable** earlier than the other themes.** Anomaly detection over
`data_quality_snapshots` is the cheapest, safest AI bet — it could land **as an enhancement to the Phase 2
monitoring dashboards** the moment those exist, because it adds no write surface. Assisted column-mapping and
merge suggestions slot in **after** their host surfaces ship (import mapping in Phase 0/1; clerical queue in
Phase 1) — they make those surfaces faster but must not gate them. NL data-ops query is the most ambitious and
is genuinely post-Phase-3+ (it needs the full corpus of audit/decision logs to be useful and a hardened
read-only query compiler Security signs off on). **Order:** anomaly detection → assisted mapping/merge → NL
query.

### Open questions

- **Q1.** PII exposure to the model — does the NL layer/merge-suggester ever send `email_enc`/`phone_enc`
  plaintext to a model? It must not. Suggestions operate on hashes/structural features; if any plaintext is
  required, Security gates it and a no-train/zero-retention vendor posture is mandatory.
- **Q2.** Anomaly-detector false-positive budget — an over-eager detector that pages nightly is worse than
  none. Start as a *dashboard signal*, graduate to *paging* only after a tuning period
  ([truepoint-operations] owns the alert threshold).
- **Q3.** Does the NL query compiler reuse the existing search/repository seam
  (`packages/db/src/repositories/searchRepository.ts`) or need a constrained query DSL? Leaning: compile to a
  small allowlisted DSL over the audited repositories, never free SQL.

---

## Cross-theme sequencing summary

How the six themes layer **after** the [14-Implementation-Roadmap](./14-Implementation-Roadmap.md) Phase 3+
boundary:

```
14 Phase 0  Observe & Enable     ─┐
14 Phase 1  Validate/Dedup/Enrich │  (committed roadmap)
14 Phase 2  Approve/Export/Self   │
14 Phase 3+ Govern & Scale       ─┘
                │
   ┌────────────┴───────────────────────────────────────────────┐
   ▼                                                             ▼
 Theme 6a  AI anomaly detection      (insertable @ Phase 2 monitoring — safest, read-only)
 Theme 2   Probabilistic ER + retune (needs labeled set from Phase-1 clerical queue)
 Theme 3   Version-history/rollback  (write-side starts early as shadow; undo is post-roadmap)
   │
   ▼
 Theme 1   CRM sync console          (needs engine + Phase-2 approval + monitoring)
 Theme 6b  Assisted mapping/merge    (after host surfaces ship)
   │
   ▼
 Theme 4   Automation & rules engine (force-multiplier — last, needs all gates mature)
 Theme 5   Residency & multi-region  (demand-driven — design early, build on contract)
 Theme 6c  NL data-ops query         (needs full audit corpus + hardened read compiler)
```

**Invariants that hold across every theme** (none is a future bet — they are load-bearing today): cross-tenant
writes via `withPlatformTx` (audited, `pa`-gated); scoped writes via `withTenantTx` (RLS, fail-closed); PII as
AES-GCM bytea, hashes in any derived ledger; non-destructive golden record (derive, never destroy); high-risk
ops behind JIT elevation + maker/checker; security has final say on safety. The vision extends the rails — it
never removes the guard.

---

## See also

- [01-Current-State-Analysis](./01-Current-State-Analysis.md) — §10 status table (what is Shipped/Dark/Inert).
- [02-Enterprise-Research](./02-Enterprise-Research.md) — the 23 cited dimensions every theme builds on.
- [03-Gap-Analysis](./03-Gap-Analysis.md) — the gap register these futures eventually close.
- [04-Control-Panel-Architecture](./04-Control-Panel-Architecture.md) — the Data management nav group each
  console extends.
- [09-Review-and-Approval-System](./09-Review-and-Approval-System.md) — the maker/checker gate Themes 1, 4 ride.
- [11-Roles-and-Permissions](./11-Roles-and-Permissions.md) — the `data:*` capabilities these surfaces gate on.
- [12-Security-and-Compliance](./12-Security-and-Compliance.md) — owns residency (Theme 5) and PII posture.
- [13-Performance-and-Scaling](./13-Performance-and-Scaling.md) — owns the scale calls (ER engine, history
  partitioning, rule-eval cost).
- [14-Implementation-Roadmap](./14-Implementation-Roadmap.md) — the committed phases this vision follows.
- `docs/planning/crm-sync/00-enterprise-implementation-plan.md` — the engine Theme 1's console operates.
