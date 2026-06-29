# 03 — Gap Analysis

> **Series:** [Database Management](./README.md) · **Type:** Analysis · **Status:** ✅ Authored ·
> **Prev:** [`02-Enterprise-Research`](./02-Enterprise-Research.md) · **Next:**
> [`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md)

---

## 1. Objective

Convert the distance between **what enterprise data-management platforms do**
([`02-Enterprise-Research`](./02-Enterprise-Research.md), 23 dimensions) and **what TruePoint
ships today** ([`01-Current-State-Analysis`](./01-Current-State-Analysis.md), §10 status matrix)
into a single **prioritized gap register**. Each row is a discrete, fundable unit of work with a
severity, an effort, a canonical tier, its blocking dependencies, and the one design doc that will
own its full specification.

This register is the spine of the series: it is the input to the sequenced
[`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md) and the index every design doc
(04–13) is measured against. If a subsystem in [`01` §10](./01-Current-State-Analysis.md) is not
represented by at least one gap here, that is a defect in this document.

**Scope reminder — two surfaces, one model.** Every gap is framed against the target two-surface
design: **Surface 1** the internal staff **Data management** console in `apps/admin` (cross-tenant
ops, staff-RBAC-gated, every write through audited `withPlatformTx`), and **Surface 2** the
customer self-service control panel in `apps/web` (own-workspace only, `requireOrgRole`-gated, RLS
via `withTenantTx`). The architecture of those surfaces is owned by
[`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md); this doc only sizes the holes.

**Precedence reminder (from `CLAUDE.md`).** Severity scoring respects TruePoint precedence:
Security has final say on whether a gap is *safe to leave open*; Platform owns tenancy(RLS)/API/scale;
Data owns the model and ownership semantics. A multi-tenant write surface without an
RLS-enforced, ownership-checked, audited path is scored as a **bug (P0)**, never a style nicety.

---

## 2. Method

### 2.1 Derivation — `best_practice − current_state`

For each of the 23 dimensions in [`02`](./02-Enterprise-Research.md) we placed the corresponding
TruePoint subsystem on the [`01` §10](./01-Current-State-Analysis.md) status ladder and took the
**delta**:

| `01` §10 badge | Meaning | Default gap posture |
|---|---|---|
| **Shipped** | In prod, exercised | Gap only if a *best-practice facet* is missing (e.g. shipped dedup has no review UI) |
| **Partial** | Some of the capability exists | Gap = the missing portion |
| **Dark** | Code exists, gated off, unverified | Gap = the *enablement + verification* work, not a rebuild |
| **Inert** | Wired but a no-op by config (shadow) | Gap = the *graduation to enforce* work, with safety rails |
| **Missing** | No code, no framework | Gap = greenfield build |

A dimension can spawn **several** gaps (a Shipped engine with a missing console, a missing
capability, and a missing review queue are three rows), and one gap can satisfy **several**
dimensions. The mapping is deliberately many-to-many; the register's `Dimension` column cites the
primary `02` dimension(s) but the prose calls out secondary ones.

### 2.2 Severity (P0–P3)

Severity answers *"what does leaving this open cost?"*, weighted by TruePoint precedence:

- **P0 — Correctness/safety blocker or unblocks everything.** A would-be untrusted-write path, a
  missing isolation/audit guarantee, or the one capability/foundation that every other surface
  depends on. Security and Platform concerns dominate here.
- **P1 — Core product value or a hard dependency for a P1 cluster.** The feature a sales-intelligence
  data platform is *expected* to have; its absence is a visible product gap.
- **P2 — Materially improves trust/efficiency** but the product functions without it short-term.
- **P3 — Maturity / scale / enterprise-deal enabler;** matters at 10x or for a specific procurement.

### 2.3 Effort (S/M/L/XL) — calibrated to TruePoint's own units

- **S** — one feature folder *or* one capability/flag/route; days. (e.g. add `data:read` to
  `packages/types/src/staffCapability.ts` + gate one read router.)
- **M** — a feature folder **plus** a new `/api/v1/admin/data/*` sub-router **plus** a read model;
  ~1–2 weeks. (e.g. import drill-down into chunks/rows/rejects.)
- **L** — new engine/framework **plus** schema/migration **plus** UI **plus** worker wiring; weeks.
  (e.g. the data-validation framework; the ER clerical-review queue.)
- **XL** — multi-subsystem, external dependency, or org-process change; a quarter-scale effort.
  (e.g. maker/checker approval engine across all high-risk ops; probabilistic ER at scale.)

### 2.4 Tier — the **canonical** tiering (identical to [`14`](./14-Implementation-Roadmap.md))

These exact labels are reused in the [`14`](./14-Implementation-Roadmap.md) phases and in the
`Tier` column below. Do not rename them.

- **MVP** — *Phase 0, Observe & Enable.* Read-only fleet visibility + new `data:read` capability +
  import drill-down + flip the **Dark** bulk import on safely.
- **Medium-P1** — *Phase 1, Validate, Dedup-Review, Enrich.* Validation framework, ER clerical-review
  queue, enrichment console, `data:manage`/`data:review`, commercial email verifier.
- **Medium-P2** — *Phase 2, Approve, Export, Self-Serve.* Maker/checker approvals, audited export
  with `data:export`, per-pipeline monitoring, Surface-2 self-service.
- **Enterprise** — *Phase 3+, Govern & Scale.* Retention enforce rollout, version-history/rollback,
  SLOs/lineage, CRM bidirectional sync, Splink-at-scale + retune loop, residency/multi-region,
  rules engine.

---

## 3. Gap Register

> Status badges in **Current status** are quoted from [`01` §10](./01-Current-State-Analysis.md).
> **Best practice** cites the [`02`](./02-Enterprise-Research.md) dimension number (the 23 listed in
> that doc). **Owning doc** is the single design doc (04–13) that fully specifies the fix.

| ID | Gap | Dimension(s) | Current status | Best practice (02 #) | Sev | Effort | Tier | Dependencies | Owning doc |
|---|---|---|---|---|---|---|---|---|---|
| **G01** | No **Data management** nav group or cross-tenant **Data-Ops Overview** in `apps/admin`; signals (system-health queue depth, import/enrichment/retention runs, `data_quality_snapshots`) exist but are never composed into a fleet view | Monitoring (20) | **Missing** (fleet view) — "data quality = Shipped customer-only (no fleet view)"; "monitoring = Partial" | §20 job-state + record-count + quality dashboards | **P0** | M | **MVP** | G02 (capability gate) | [`04`](./04-Control-Panel-Architecture.md) |
| **G02** | No `data:read` staff capability; the closed 16-cap enum in `packages/types/src/staffCapability.ts:13` has **no `data:*`** — every Data-management read surface is currently ungateable | RBAC (15) | **Missing** — "staff RBAC = Shipped (no data:* capability)" | §15 scoped, ownership-checked, least-privilege auth surface | **P0** | S | **MVP** | — (root dependency) | [`11`](./11-Roles-and-Permissions.md) |
| **G03** | Import monitor is metadata-only; cannot drill `import_job_chunks` / `import_job_rows` / reject rows, and has no retry/cancel/pause controls | Ingestion (1), Error handling (19) | **Shipped** (monitor-only) — "standard import = Shipped (staff monitor-only)" | §1 get-job-info processed/failed/total; §19 per-record status array + row-level error report | **P1** | M | **MVP** | G02 | [`05`](./05-Upload-Pipeline-Design.md) |
| **G04** | Bulk-import **COPY FROM STDIN** path (`copyRows`) is unverified under Bun+PG; cannot be trusted in prod | Ingestion (1), Scalability (22) | **Dark** — "COPY FROM STDIN path copyRows UNVERIFIED needs Bun+PG spike" | §22 file-async for huge loads; staging-then-promote | **P0** | M | **MVP** | — | [`05`](./05-Upload-Pipeline-Design.md) |
| **G05** | No production object store; bulk import only has dev-disk `FileStore` (`BULK_IMPORT_STORAGE_DIR`, `env.ts:181`) | Bulk uploads (2), Background jobs (17) | **Dark** — "NO prod object store, only dev disk FileStore" | §2 file-async route + bounded download window | **P0** | M | **MVP** | — | [`05`](./05-Upload-Pipeline-Design.md) |
| **G06** | Bulk import dark behind `BULK_IMPORT_ENABLED` (`env.ts:174`, default false) + per-tenant `bulk_import_enabled`; needs idempotency_key + content_hash confirmation before per-tenant flip | Ingestion (1,3), Error handling (19) | **Dark** — "bulk import COPY = Dark … per-tenant flag false" | §3 idempotency-keyed staged drain; §19 idempotent replay | **P1** | M | **MVP** | G04, G05 | [`05`](./05-Upload-Pipeline-Design.md) |
| **G07** | No **data-validation framework**; validation is ad-hoc in `prepareContact`, not an ordered, visible stage pipeline with a reject ledger | Validation (4) | **Missing** — "data validation = Missing as a framework" | §4 ordered file→schema→row→aggregation stages; multi-valued email status | **P1** | L | **Medium-P1** | G03 | [`06`](./06-Data-Validation-Framework.md) |
| **G08** | Reject/triage has no UI; rejected import rows are countered but not inspectable or re-submittable | Validation (4), Error handling (19) | **Missing** (triage) — implied by validation Missing + monitor-only import | §19 separate failed-results artifact + correlation token | **P1** | M | **Medium-P1** | G03, G07 | [`06`](./06-Data-Validation-Framework.md) |
| **G09** | Within-workspace dedup runs auto-survivorship with **no review surface**; staff cannot see or override merge decisions | Duplicate detection (5), Manual review (9) | **Shipped** (no UI) — "within-ws dedup = Shipped (auto-survivorship, no UI)" | §5 return created-vs-matched, instrument dup creation; §9 two-threshold steward review | **P1** | M | **Medium-P1** | G02 | [`07`](./07-Deduplication-and-Linking.md) |
| **G10** | No **entity-resolution clerical-review / merge-split queue** over `match_links.review_status='pending'`; probabilistic ER deferred, `masterGraphMatcher` is a stub | Record linking (6), Manual review (9) | **Partial** — "entity resolution/merge review = Partial … Splink+review queue deferred, masterGraphMatcher stub" | §6 nodes+edges+connected-components, weight decomposition audit; §9 bias to false-negatives | **P1** | L | **Medium-P1** | G02, data:review (G19) | [`07`](./07-Deduplication-and-Linking.md) |
| **G11** | No **enrichment run console**: provider cost / hit-rate / attribution, re-run, and test-batch are invisible to staff despite a Shipped engine | Enrichment (8), Approval (16) | **Shipped** (no console) — "enrichment engine = Shipped"; provider-configs exist but no run-level view | §8 per-field waterfall visibility, charge-on-success, test 25–50 rows | **P1** | M | **Medium-P1** | G02, G19 | [`08`](./08-Data-Enrichment-Workflow.md) |
| **G12** | Email/phone **verification is Dark** — `passThroughVerifier` until `REACHER_*`/`TWILIO_*` creds; **no commercial email vendor chosen** | Validation (4), Quality scoring (10) | **Dark** — "verification = Dark (passThroughVerifier …); commercial email vendor not chosen" | §4 multi-valued email status (catch-all/unknown distinct, never auto-promote) | **P1** | L | **Medium-P1** | vendor selection (external) | [`06`](./06-Data-Validation-Framework.md) |
| **G13** | No `data:manage` and `data:review` capabilities — write/review surfaces for validation, dedup, ER, enrichment have no gate | RBAC (15) | **Missing** — extends G02 | §15 preview-vs-redeem privilege split as an auth surface | **P0** | S | **Medium-P1** | G02 | [`11`](./11-Roles-and-Permissions.md) |
| **G14** | No **maker/checker approval workflow** for high-risk ops (bulk merges, enforce flips, cross-tenant writes, exports) | Approval (16), Manual review (9) | **Missing** — "approval/maker-checker = Missing" | §16 preview-then-commit gate; pre-compute worst-case spend | **P1** | XL | **Medium-P2** | G13, G07, G10 | [`09`](./09-Review-and-Approval-System.md) |
| **G15** | No **audited bulk export** with approval + global-suppression check + `data:export` gate; current `/bulk/export` is workspace-scoped only, no staff cross-tenant audited path | Approval (16), RBAC (15), Operational tooling (21) | **Missing** (audited staff export) | §16 worst-case pre-compute; §2 bounded output window; §21 over-audit-log tooling | **P1** | M | **Medium-P2** | G14, data:export (G16), G23 | [`09`](./09-Review-and-Approval-System.md) |
| **G16** | No `data:export` capability; export privilege cannot be separated from `data:read`/`data:manage` | RBAC (15) | **Missing** — extends G02/G13 | §15 privilege split (preview vs redeem/export) | **P1** | S | **Medium-P2** | G02 | [`11`](./11-Roles-and-Permissions.md) |
| **G17** | **Per-pipeline monitoring dashboards** missing: only `system-health` queue depth exists; no per-dimension quality metrics, segment match-rate, FP/FN vs labeled set, per-tier verification yield | Monitoring (20), Quality scoring (10) | **Partial** — "monitoring = Partial (system-health queue depth only)" | §20 per-dimension quality, segment match-rate, FP/FN, per-tier yield | **P1** | L | **Medium-P2** | G01, G07, G11 | [`10`](./10-Monitoring-and-Observability.md) |
| **G18** | No **fleet (cross-tenant) data-quality view**; `data_quality_snapshots` is daily per-ws but only surfaced to the customer | Quality scoring (10), Monitoring (20) | **Shipped** (customer-only) — "data quality = Shipped customer-only (no fleet view)" | §10 per-dimension sub-scores; §20 fleet quality metrics | **P2** | M | **Medium-P2** | G01 | [`10`](./10-Monitoring-and-Observability.md) |
| **G19** | **Surface 2 self-service** is just the data-health dashboard; no own-workspace import wizard reuse, dedup review, enrichment usage, export, or DSAR-request control panel | RBAC (15), Self-serve facets of 1/5/8 | **Partial** — data-health page live, rest Missing | §15 tenant/workspace-scoped ownership-checked surface | **P2** | L | **Medium-P2** | G07, G09, G11 (engines), `requireOrgRole` | [`04`](./04-Control-Panel-Architecture.md) |
| **G20** | **Retention engine is Inert shadow** (`retention_engine_enabled` false + per-class `mode='shadow'`); deletes nothing; only low-risk classes wired; needs graduated enforce rollout with approvals | Data governance (14), Approval (16) | **Inert** — "retention engine = Inert shadow … deletes nothing; only low-risk classes wired" | §14 attribute-level survivorship & segmented SLAs; §16 approval gate on destructive ops | **P2** | L | **Enterprise** | G14 (approvals) | [`12`](./12-Security-and-Compliance.md) |
| **G21** | No **version history / rollback**; golden record is not a recomputable view over preserved source rows; merges are not non-destructively reversible | Version history (12), Rollback (13), Governance (14) | **Missing** — "version history/rollback = Missing" | §12 derived recomputable golden record + per-field last-validated; §13 non-destructive rollback | **P2** | XL | **Enterprise** | G10 (ER model), source_records preserved | [`07`](./07-Deduplication-and-Linking.md) |
| **G22** | No **SLOs, alerting, or data lineage**; no root-cause tooling over audit/decision logs | Monitoring (20), Operational tooling (21), Audit logs (11) | **Partial** — extends monitoring Partial; "audit = Shipped" but no tooling layer | §20 FP/FN tracking; §21 tools over decision logs (Duplicate-Analyzer pattern); §11 provenance | **P3** | L | **Enterprise** | G17 | [`10`](./10-Monitoring-and-Observability.md) |
| **G23** | **Global suppression/blocklist not enforced on the export path**; suppression list exists (compliance) but export is not suppression-checked at the staff surface | Security/Compliance, Error handling (19) | **Partial** — compliance suppression Shipped; export integration Missing | §19 bill/emit only valid; suppression as a hard gate | **P1** | S | **Medium-P2** | G15 | [`12`](./12-Security-and-Compliance.md) |
| **G24** | No **attribute-level survivorship governance UI**; `field_provenance` winner-map exists per record but rules are not configurable, segmented, or auditable | Data governance (14), Quality scoring (10) | **Partial** — provenance stored, not governed | §14 per-field source-priority/recency/frequency/completeness with cascading fallbacks; segmented SLAs | **P3** | L | **Enterprise** | G10, G21 | [`07`](./07-Deduplication-and-Linking.md) |
| **G25** | No **dedicated bulk queue lane / multi-window rate limits / quota headers** below interactive traffic; queues exist but no tiered admission control | Queue management (18), Scalability (22) | **Partial** — queues + DLQs exist; lane separation Missing | §18 dedicated bulk lane ~50% of single-endpoint limit; multi-window + 429 + reset headers | **P2** | M | **Enterprise** | G06 (bulk live) | [`13`](./13-Performance-and-Scaling.md) |
| **G26** | No **blocking-key strategy measured before run** for dedup/ER at scale; deterministic shipped but blocking rules unmeasured, DSU clustering not on a distributed engine | Scalability (22), Performance (23), Record linking (6) | **Partial** — deterministic Shipped; scale-out deferred | §22 blocking is load-bearing; DSU on distributed engine; §23 normalize-before-compare, dedupe-before-enrich | **P3** | XL | **Enterprise** | G10 | [`13`](./13-Performance-and-Scaling.md) |
| **G27** | No **probabilistic ER (Splink) + clerical retune loop**; m/u probabilities and weight decomposition not implemented | Record linking (6), Manual review (9) | **Partial** — "Splink … deferred" | §6 Fellegi-Sunter m/u → summed weights; §9 flag→correction-queue→retune | **P3** | XL | **Enterprise** | G10, G17 (labeled set) | [`07`](./07-Deduplication-and-Linking.md) |
| **G28** | No **CRM bidirectional sync / deletion-sync console**; dup creation provenance (~90% from CRM imports per §5) not instrumented | Operational tooling (21), Duplicate detection (5) | **Missing** — separate CRM-sync plan exists, no console | §21 bidirectional merge-sync / deletion-sync; instrument dup creation provenance | **P3** | XL | **Enterprise** | G09, G14 | [`15`](./15-Future-Enhancements.md) |
| **G29** | No **residency / multi-region ops** for the data-management surfaces (cross-tenant staff ops cross regions) | Governance (14), Security/Compliance | **Missing** — not in §10; enterprise-deal gate | Residency-aware processing; segmented governance | **P3** | XL | **Enterprise** | platform residency model | [`12`](./12-Security-and-Compliance.md) |
| **G30** | No **automation / rules engine** for validation→routing→survivorship→retention decisions; everything is hand-wired per pipeline | Governance (14), Validation (4) | **Missing** | §14 rule-versioned governance; §12 version the resolution rules | **P3** | XL | **Enterprise** | G07, G21, G24 | [`15`](./15-Future-Enhancements.md) |
| **G31** | **Quality scoring** is single composite (`priority_score` 0–100) with no per-dimension sub-scores (accuracy/completeness/consistency/timeliness/validity/uniqueness) and is not recomputed on every change | Quality scoring (10) | **Partial** — score Shipped, sub-scores Missing | §10 numeric confidence not boolean; per-dimension sub-scores; recompute on every change; recency top feature | **P2** | M | **Medium-P2** | G07 (validity inputs) | [`10`](./10-Monitoring-and-Observability.md) |
| **G32** | **Idempotency/replay not proven on bulk + export endpoints**; money endpoints have `Idempotency-Key` but bulk-import and export idempotent-replay-of-first-response (incl failures) not verified | Error handling (19), Background jobs (17) | **Partial** — idempotency Shipped on money paths; bulk/export unverified | §19 idempotency keys replay first response incl failures; §17 idempotent webhook receivers | **P2** | M | **Medium-P2** | G06, G15 | [`05`](./05-Upload-Pipeline-Design.md) |

**Coverage check against [`01` §10](./01-Current-State-Analysis.md):** import drill-down (G03);
bulk-import enablement (G04–G06, G32); validation framework (G07–G08); verification vendor (G12);
within-ws dedup auto-vs-review (G09); ER/merge UI (G10, G26, G27); enrichment console (G11);
fleet quality view (G18, G31); retention enforce (G20); monitoring depth (G17, G22); version
history/rollback (G21); approvals/maker-checker (G14); `data:*` capability (G02, G13, G16);
audited export (G15, G23); self-service (G19); plus scale/governance enablers (G24, G25, G28–G30).
**32 gaps; every §10 subsystem represented.**

---

## 4. Prioritization Rationale

### 4.1 Why **MVP / Phase 0** is what it is (G01–G06)

The MVP tier is deliberately **"Observe & Enable" — no new business-logic writes**. The reasoning:

- **G02 (`data:read`) is the keystone.** Per CLAUDE.md precedence, *Platform/Security own the gate*.
  Nothing in the Data-management console can be exposed until there is a capability to gate it
  (`requireCapability("data:read")` on the new `/api/v1/admin/data/*` routers). It is **S** effort and
  **P0** purely because it unblocks the entire surface — a textbook "do this first."
- **G01 (Data-Ops Overview) is pure composition.** It reuses already-Shipped signals
  (system-health queue depth, import/enrichment/retention run tables, `data_quality_snapshots`)
  through audited read paths. No new mutation, so the blast radius is read-only — the safest way to
  put a new console in front of staff and learn the surface.
- **G03 (import drill-down)** is read-only too, and turns the existing **Shipped** monitor into the
  thing operators actually need (rows/rejects), at **M** effort.
- **G04–G06 (bulk enable)** are P0/P1 because the code is *already written and Dark*: the value is
  high and the work is **verification + a production object-store adapter + flag confirmation**, not
  a rebuild. Critically, these are *enablement* gaps — flipping a per-tenant flag behind two
  existing gates — so they belong in Phase 0 even though they touch a write path, because the write
  path itself already went through review when it was built.

**Net:** Phase 0 ships a usable staff console and a productionizable bulk pipeline while introducing
**zero new un-reviewed mutation logic** — maximal learning, minimal risk.

### 4.2 Why **Medium-P1** (Validate, Dedup-Review, Enrich)

This tier builds the **first new write/review surfaces**, so it is correctly *after* the read
foundation. Validation (G07/G08) is sequenced first because **everything downstream consumes its
output**: dedup keys, quality sub-scores, and approval previews all depend on validated, typed,
status-tagged rows. The ER clerical-review queue (G10) and dedup review (G09) deliver the
"manual review with two thresholds, biased to false-negatives" the product is judged on (§9), and
the enrichment console (G11) makes the already-Shipped metered engine *governable* (cost/hit-rate/
test-batch). G13 (`data:manage`/`data:review`) is the gate that makes all of these writeable. G12
(commercial verifier) lands here because validation's email-status tiering (§4) is hollow while
verification is `passThroughVerifier`.

### 4.3 Why **Medium-P2** (Approve, Export, Self-Serve)

Approval (G14) is **XL** and depends on having *something to approve* — it is sequenced after the
validation/dedup/ER surfaces exist. Audited export (G15/G16/G23) is gated behind approval and
suppression because an un-approved, un-suppression-checked cross-tenant export is the single
highest-consequence operation in the system. Per-pipeline monitoring (G17) and the fleet quality
view (G18, G31) need the validation/enrichment data they visualize to already be flowing.
Surface-2 self-service (G19) reuses the Phase-1 engines but is customer-facing (own-workspace,
`requireOrgRole`), so it follows once those engines are real.

### 4.4 Why **Enterprise / Phase 3+**

Everything here is either **graduating an Inert/Partial capability under approval** (retention
enforce G20), a **maturity/scale** investment (version history G21, SLOs/lineage G22, bulk lane
G25, Splink-at-scale G26/G27, survivorship governance G24), or an **enterprise-deal enabler**
(residency G29, CRM bidirectional sync G28, rules engine G30). None blocks core product value;
all assume the Phase-0/1/2 foundations (capability model, approvals, ER model, monitoring) exist.

---

## 5. Dependency Graph & Sequencing

The hard ordering constraints (a `→` b means **a must ship before b**):

```
                 ┌────────────────────────── FOUNDATION ──────────────────────────┐
   G02 data:read ─┬─> G01 Data-Ops Overview
                  ├─> G03 Import drill-down
                  └─> G13 data:manage/review ──┬─> G09 Dedup review
                                               ├─> G10 ER clerical queue ─> G19 self-serve dedup
                                               └─> G11 Enrichment console
   G16 data:export ─────────────────────────────────────────────> G15 Audited export
                                                                       ^   ^
   G04 COPY spike ─┐                                                   │   │
   G05 obj store  ─┼─> G06 Bulk enable ─> G32 idempotency proof        │   │
                   │                          │                        │   │
                   └──────────────────────────┘                        │   │
   G07 Validation framework ─┬─> G08 Reject triage                     │   │
                             ├─> G31 Quality sub-scores                 │   │
                             └─> G14 Maker/checker approvals ───────────┘   │
   G23 Suppression-on-export ─────────────────────────────────────────────┘
   G14 ─> G20 Retention enforce ;  G10 ─> G21 Version/rollback ─> G24/G30
   G17 Monitoring ─> G22 SLOs/lineage ;  G10 ─> G26/G27 Scale-ER
```

**Load-bearing edges, called out explicitly:**

1. **`data:read` (G02) before any write surface.** No Data-management screen ships without its
   capability gate. This is the root of the graph — Security/Platform precedence.
2. **Object store (G05) + COPY spike (G04) before bulk enable (G06).** You cannot flip
   `bulk_import_enabled` per-tenant while the COPY path is unverified and the only storage is a dev
   disk. These two are the literal "enable-gates" recorded in
   [`01`](./01-Current-State-Analysis.md) (and in agent memory).
3. **Validation (G07) before approval (G14) and before quality sub-scores (G31).** Approval previews
   and per-dimension scoring both consume validated/typed/status-tagged rows; building approval on
   un-validated input bakes in garbage-in.
4. **ER model (G10) before version history/rollback (G21) and before scale-ER (G26/G27).** A
   non-destructive, recomputable golden record (§12/§13) requires the nodes+edges+components model
   to exist first; Splink-at-scale and the retune loop need the clerical queue's labeled decisions.
5. **Approval (G14) + `data:export` (G16) + suppression (G23) before audited export (G15).** The
   highest-consequence op must not exist before all three guards do.
6. **Approval (G14) before retention enforce (G20).** Graduating a class from `shadow` to `enforce`
   (a destructive op) must pass through maker/checker — never a silent flag flip.

---

## 6. Top Risks of Leaving Gaps Open

| Risk | Driven by | Consequence if unaddressed |
|---|---|---|
| **Ungated cross-tenant exposure** | G02/G13/G16 missing | Any Data-management surface shipped without `data:*` capabilities is a privilege-escalation bug; staff RBAC's least-privilege model is bypassed. **Hard blocker — do not ship a screen first.** |
| **Untrusted/unaudited write path** | G14/G15 missing | A cross-tenant write or export without an audited `withPlatformTx` + approval path is, per CLAUDE.md, *a bug not a style choice* — and the worst-consequence one (cross-tenant PII egress). |
| **Garbage-in golden records** | G07/G12 missing | Without a validation framework and real verification, dedup keys and enrichment fire on dirty data; email-status tiering (catch-all/unknown) collapses; bad records pollute the master graph irreversibly while G21 rollback doesn't exist. |
| **Frankenstein merges, irreversibly** | G09/G10/G21 missing | Auto-survivorship with no review and no non-destructive rollback means a wrong merge is permanent and invisible — the §9 "bias to false-negatives" mandate is violated silently. |
| **Unbounded enrichment/export spend** | G11/G14 missing | No test-batch, no worst-case pre-compute, no approval → a single bulk run can burn the monthly provider budget; metered spend is uncontrolled (FinOps risk, truepoint-operations). |
| **Bulk pipeline flipped on broken** | G04/G05/G06/G32 missing | Enabling bulk import before the COPY spike + prod object store + idempotency proof risks data loss, duplicate ingestion on retry, and a write path that can't recover from a checkpoint. |
| **Operational blindness at scale** | G17/G18/G22/G25 missing | No per-pipeline metrics, no fleet quality view, no bulk-lane isolation → interactive traffic starves behind bulk jobs (parent-lock contention §18), and quality regressions are invisible until a customer complains. |
| **Retention enforce as a silent footgun** | G20 without G14 | Graduating a retention class to `enforce` without an approval gate could delete production data on a config typo — exactly the destructive op §16 says must be preview-then-commit. |

---

## 7. Handoff to the Roadmap

This register is consumed directly by [`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md):
the `Tier` column maps 1:1 onto the four canonical phases (MVP / Medium-P1 / Medium-P2 / Enterprise),
and §5's dependency edges define the intra-phase sequencing. Each `Owning doc` reference points to
the design doc that turns its gaps into DDL, endpoint signatures, and wireframes:

- Console & surfaces → [`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md)
- Upload/bulk pipeline → [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md)
- Validation & verification → [`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md)
- Dedup, ER, version/rollback, survivorship → [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md)
- Enrichment console → [`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md)
- Approval & export → [`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md)
- Monitoring, fleet quality, scoring, SLOs → [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md)
- Capabilities → [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md)
- Retention enforce, suppression, residency → [`12-Security-and-Compliance`](./12-Security-and-Compliance.md)
- Bulk lane, scale-ER, performance → [`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md)
- CRM sync, rules engine → [`15-Future-Enhancements`](./15-Future-Enhancements.md)

> Tiers in this document are **identical** to [`14`](./14-Implementation-Roadmap.md) by
> construction; if they ever diverge, `14` is corrected to match this register, not the reverse.
