# 14 — Implementation Roadmap

> **Series:** [Database Management](./README.md) · **Type:** Roadmap · **Status:** ✅ Authored
> · **Prev:** [`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) · **Next:**
> [`15-Future-Enhancements`](./15-Future-Enhancements.md)

---

## 1. Objective

Turn the gap register in [`03-Gap-Analysis`](./03-Gap-Analysis.md) (G01–G32) and the
design specifications in docs `04`–`13` into an **executable, gated, dependency-ordered
delivery plan**. The plan separates work into four canonical tiers — **MVP**, **Medium-P1**,
**Medium-P2**, **Enterprise** — that are *byte-identical* to the `Tier` column of
[`03-Gap-Analysis`](./03-Gap-Analysis.md) and to the `CANONICAL TIERING` in the task brief.
Each tier maps 1:1 onto a phase descriptor:

| Tier (03 column) | Phase descriptor | Theme |
|---|---|---|
| **MVP** | Phase 0 | **Observe & Enable** |
| **Medium-P1** | Phase 1 | **Validate, Dedup-Review, Enrich** |
| **Medium-P2** | Phase 2 | **Approve, Export, Self-Serve** |
| **Enterprise** | Phase 3+ | **Govern & Scale** |

The roadmap is governed by three non-negotiable rules carried from `CLAUDE.md` and the
TruePoint skill precedence:

1. **No new destructive write path ships without an RLS-enforced, ownership-checked,
   audited route.** Cross-tenant staff writes go through `withPlatformTx` (which writes a
   `platform_audit_log` row in the *same* transaction; `packages/db/src/client.ts:121`).
   Workspace-scoped writes go through `withTenantTx` (`client.ts:74`). A multi-tenant write
   without that path is a bug, not a backlog item — Security has final say.
2. **Capabilities gate before surfaces ship.** Every Data-management read/write/review/export
   surface is *ungateable today* because the closed 16-capability enum
   (`packages/types/src/staffCapability.ts:13`) has **no `data:*`**. The capability lands in
   the same phase as (or before) the surface it guards — this is why `data:read` (G02) is the
   root dependency of the entire plan.
3. **Dark/Inert subsystems graduate behind their *existing* gates**, never by deleting the
   gate. Bulk import stays behind `BULK_IMPORT_ENABLED` (`packages/config/src/env.ts:174`) +
   per-tenant `bulk_import_enabled`; verification stays behind `REACHER_*`/`TWILIO_*`
   (`env.ts:110`, `env.ts:117`); retention stays behind `retention_engine_enabled` + per-class
   `mode`. Graduation = flip the flag for a canary tenant, observe, then GA — see §5.

Effort uses the same T-shirt scale as [`03-Gap-Analysis`](./03-Gap-Analysis.md): **S** ≈ ≤3
eng-days, **M** ≈ 1–2 eng-weeks, **L** ≈ 3–5 eng-weeks, **XL** ≈ 6+ eng-weeks (multi-person).
These are *engineering* estimates and exclude vendor-selection lead time (called out explicitly
where it gates a phase).

---

## 2. Phasing Model

```
            ┌─────────────────────────────────────────────────────────────────────┐
            │  MVP / Phase 0 — OBSERVE & ENABLE                                     │
            │  Nav group · data:read · Data-Ops Overview (read-only) ·              │
            │  import drill-down · enable+harden dark bulk import                   │
            │  Gaps: G01 G02 G03 G04 G05 G06        Risk: LOW (no new biz writes)   │
            └───────────────┬─────────────────────────────────────────────────────┘
                            │ exit gate: console live + bulk-import canary green
            ┌───────────────▼─────────────────────────────────────────────────────┐
            │  Medium-P1 / Phase 1 — VALIDATE, DEDUP-REVIEW, ENRICH                 │
            │  data:manage · data:review · validation framework + reject triage ·  │
            │  ER clerical-review queue · enrichment run console ·                 │
            │  commercial email verifier (vendor + creds)                          │
            │  Gaps: G07 G08 G09 G10 G11 G12 G13    Risk: MED (first review writes) │
            └───────────────┬─────────────────────────────────────────────────────┘
                            │ exit gate: a record survives validate→dedup-review→enrich
            ┌───────────────▼─────────────────────────────────────────────────────┐
            │  Medium-P2 / Phase 2 — APPROVE, EXPORT, SELF-SERVE                    │
            │  data:export · maker/checker approvals · audited bulk export ·       │
            │  per-pipeline monitoring · fleet quality view ·                      │
            │  Surface-2 customer self-service control panel                        │
            │  Gaps: G14 G15 G16 G17 G18 G19 G23 G31 G32  Risk: MED-HIGH (export+spend) │
            └───────────────┬─────────────────────────────────────────────────────┘
                            │ exit gate: an export requires approval + passes suppression
            ┌───────────────▼─────────────────────────────────────────────────────┐
            │  Enterprise / Phase 3+ — GOVERN & SCALE                              │
            │  retention enforce rollout (approved) · version-history/rollback ·   │
            │  SLOs+alerting+lineage · survivorship governance · bulk-lane admission│
            │  · Splink ER at scale · CRM bidi-sync · residency · rules engine     │
            │  Gaps: G20 G21 G22 G24 G25 G26 G27 G28 G29 G30   Risk: HIGH (destruct)│
            └─────────────────────────────────────────────────────────────────────┘
```

The phases are **strictly ordered for the critical path** (you cannot approve what you cannot
validate; you cannot enforce-delete without approvals) but **parallelizable inside a phase**
(see §4 dependency graph). Surface-1 (internal staff console, [`04`](./04-Control-Panel-Architecture.md))
and Surface-2 (customer self-service) advance on the same tiers, with Surface-2's substantive
landing in Medium-P2.

---

## 3. Per-Phase Detail

### 3.1 MVP / Phase 0 — Observe & Enable

> **Theme:** ship a *usable, read-only* staff console and a *productionizable* bulk pipeline
> while introducing **zero new business-logic writes**. The only "writes" are the bulk-import
> staging path that already exists behind its flags.

**Scope — capabilities that land (docs `04`–`13`):**

| Gap | Deliverable | Lands in doc |
|---|---|---|
| **G02** | `data:read` staff capability added to the closed enum `packages/types/src/staffCapability.ts:13`; `ROLE_CAPABILITIES` bundles updated (`packages/types/src/auth.ts`); `super_admin` implies it automatically; `requireCapability("data:read")` gate available | [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) |
| **G01** | Admin **Data management** nav group — one `NavDestination` group + sub-routes in `apps/admin/src/components/shell/navConfig.ts` `DESTINATIONS`; **Data-Ops Overview** feature folder (`apps/admin/src/features/data-ops/`) composing existing signals: `system-health` queue depth + import/enrichment/retention runs + aggregated `data_quality_snapshots`. Read-only, no new writes | [`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) |
| **G03** | Import **drill-down**: extend the read-only `features/imports` monitor to read `import_job_chunks` / `import_job_rows` / reject rows (metadata + counters only, **never row PII contents**). Still read-only in P0 (retry/cancel/pause is P1 write) | [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) |
| **G04** | **COPY FROM STDIN spike**: verify `copyRows` under Bun + node-postgres against the UNLOGGED staging table; the only path that uses `ownerClient` (`client.ts:27`, RLS-bypass — Postgres forbids COPY on RLS tables) | [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) |
| **G05** | **Production object-store adapter** replacing the dev-disk `FileStore` (`BULK_IMPORT_STORAGE_DIR`, `env.ts:181`); S3-compatible put/get with a **bounded download window** (signed-URL expiry) per [`02` §2](./02-Enterprise-Research.md) | [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) |
| **G06** | Confirm `idempotency_key` (ws-unique) + `content_hash` on `import_jobs` so a bulk file can be safely flipped on per-tenant behind `BULK_IMPORT_ENABLED` + `bulk_import_enabled` | [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) |

**New capability introduced:** `data:read`.
**New flags touched:** none new — graduates the *existing* `BULK_IMPORT_ENABLED` (`env.ts:174`)
+ per-tenant `bulk_import_enabled` from default-off to canary-on.

**Entry gate:** none — this is the root phase. Pre-build pass
(`truepoint-architecture/references/pre-build-thinking.md`) run and plan presented.

**Exit / acceptance gate (ALL must hold):**
- `data:read` exists in the enum, is bundled to the right roles, and `requireCapability("data:read")`
  rejects `read_only` staff who lack it (isolation test green).
- Data management nav group renders for staff with `data:read`, is hidden via
  `useStaffMe().canMaybe("data:read")` for those without (optimistic hide), and the server gate
  is authoritative (403 on direct API hit).
- Data-Ops Overview renders the four-state `StateSwitch` (loading/error/empty/data) and composes
  ≥3 existing signals with **no new table and no new write**.
- Import drill-down shows chunks/rows/reject *counts and metadata*, with an explicit assertion
  in code + test that **no row PII content is returned** across the `/api/v1/admin/*` seam.
- **COPY spike signed off:** `copyRows` ingests a ≥100k-row fixture into UNLOGGED staging under
  Bun, throughput recorded, and a documented rollback (truncate staging) verified.
- Object-store adapter passes an integration test (put → signed-get → expiry) in a non-prod
  bucket; dev `FileStore` retained behind env for local.
- **Bulk import canary:** one internal/canary tenant has `bulk_import_enabled=true`, runs a real
  file end-to-end (upload → stage → promote → dedup/firmographics/master-backfill fan-out per
  `apps/workers/src/register.ts`), and the idempotency replay test proves a re-submit with the
  same `idempotency_key` returns the first job, not a duplicate.

**Dependencies:** G02 → {G01, G03}. G04, G05 independent of each other and of G02 (infra spikes),
both → G06 → bulk-enable.

**Rough effort:** G02 **S**, G01 **M**, G03 **M**, G04 **M**, G05 **M**, G06 **M** →
**phase ≈ M–L** (≈4–6 eng-weeks, 2 engineers; the COPY spike is the schedule risk).

---

### 3.2 Medium-P1 / Phase 1 — Validate, Dedup-Review, Enrich

> **Theme:** the first **review writes**. Staff can now inspect and *act on* validation rejects,
> merge decisions, and enrichment runs. Every write here is single-record or small-batch, gated
> by a new capability, and audited.

**Scope — capabilities that land:**

| Gap | Deliverable | Lands in doc |
|---|---|---|
| **G13** | `data:manage` + `data:review` capabilities added to the enum + role bundles; `requireCapability` gates for the write/review surfaces. Embodies the **preview-vs-redeem privilege split** ([`02` §15](./02-Enterprise-Research.md)) | [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) |
| **G07** | **Data-validation framework**: ordered `file → schema → row-level → aggregation` stages (`02` §4) made a first-class, visible pipeline with a **reject ledger** — replacing ad-hoc checks in `prepareContact`. Email status stays **multi-valued** (`catch_all` & `unknown` are distinct risk tiers, never auto-promoted to `valid`) | [`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md) |
| **G08** | **Reject/triage UI**: rejected `import_job_rows` become inspectable + re-submittable; separate failed-results artifact + echoed correlation token ([`02` §19](./02-Enterprise-Research.md)) | [`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md) |
| **G09** | **Within-workspace dedup review surface** on the auto-survivorship path (currently Shipped, no UI). Staff can see/override merge decisions; instrument **dup creation provenance** ([`02` §5](./02-Enterprise-Research.md)) | [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) |
| **G10** | **ER clerical-review / merge-split queue** over `match_links.review_status='pending'`; weight-decomposition audit trail; **bias to false-negatives** over Frankenstein merges ([`02` §6, §9](./02-Enterprise-Research.md)). (`masterGraphMatcher` stub stays a stub — probabilistic ER at scale is Enterprise/G27) | [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) |
| **G11** | **Enrichment run console**: provider cost / hit-rate / attribution, re-run, and **test-batch (25–50 rows)** over the Shipped engine; per-field waterfall visibility, charge-on-success ([`02` §8](./02-Enterprise-Research.md)) | [`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md) |
| **G12** | **Commercial email verifier selected + creds wired** (graduates verification from Dark `passThroughVerifier`); the shipped `hybridVerifier` (Reacher → commercial, `packages/core/src/data-health/emailVerifier.ts`) gets its commercial leg. Behind `REACHER_*`/`TWILIO_*` env (`env.ts:110`, `:117`) | [`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md) |

**New capabilities introduced:** `data:manage`, `data:review`.
**New flags / gates touched:** verification graduates from Dark by wiring `REACHER_*` (and the
chosen commercial vendor's) creds; per-tenant rollout via `feature_flags`.

**Entry gate (must hold before P1 starts):**
- MVP exit gate fully green (`data:read` + console live).
- All P1 review/write surfaces have their capability *defined first* (G13 lands before G07–G11
  expose write buttons).

**Exit / acceptance gate:**
- A single record can travel **validate (with a real reject) → dedup-review (a human override) →
  enrich (test-batch then real, charge-on-success)** end to end, every write audited.
- `data:manage` / `data:review` reject staff who lack them (isolation tests); `data:read`-only
  staff see the surfaces read-only.
- Validation framework runs the four ordered stages with a populated reject ledger; an automated
  test proves `catch_all`/`unknown` are **never** written as `valid` to `contacts.email_status`.
- ER review queue lists `review_status='pending'` clusters with weight decomposition; a
  merge/split decision writes `match_links.review_status` + an audit row; **no auto-merge above
  the steward-review threshold without a human** (false-negative bias verified).
- Enrichment console shows per-provider hit-rate + MTD spend reconciled against
  `enrichment_jobs`/`_rows.cost_micros`/`charged`; a test-batch of 25–50 rows runs and bills
  **only successes** ([`02` §8](./02-Enterprise-Research.md)).
- Commercial verifier returns multi-valued status on a labeled fixture; vendor contract signed
  (external lead-time tracked separately).

**Dependencies:** G02 → G13 → {G07, G09, G10, G11}. G03 → {G07, G08}. G07 → G08. G19 capability
prerequisite noted for G10's review write. G11 depends on provider-configs (already Shipped) for
attribution. **G12 has an external dependency (vendor selection) that should start during MVP.**

**Rough effort:** G13 **S**, G07 **L**, G08 **M**, G09 **M**, G10 **L**, G11 **M**, G12 **L**
→ **phase ≈ L–XL** (≈8–12 eng-weeks; the two **L**'s — validation framework and ER queue — are
the long poles and can run in parallel with separate owners).

---

### 3.3 Medium-P2 / Phase 2 — Approve, Export, Self-Serve

> **Theme:** put a **maker/checker gate** in front of high-risk operations, ship an **audited,
> suppression-checked bulk export**, light up **per-pipeline monitoring + the fleet quality
> view**, and give customers a **self-service** control panel for their own data.

**Scope — capabilities that land:**

| Gap | Deliverable | Lands in doc |
|---|---|---|
| **G16** | `data:export` capability — separates export privilege from `data:read`/`data:manage` (preview vs redeem/export split, [`02` §15](./02-Enterprise-Research.md)) | [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) |
| **G14** | **Maker/checker approval workflow** for high-risk ops (bulk merges, cross-tenant writes, exports, and — later — enforce flips). Preview-then-commit gate; **pre-compute worst-case spend** before a bulk run ([`02` §16](./02-Enterprise-Research.md)). Reuses the JIT-elevation + justification-reason pattern from `features/tenants/components/TenantActions.tsx` | [`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) |
| **G15** | **Audited bulk export** with approval + **global-suppression check** + `data:export` gate; cross-tenant staff path via `withPlatformTx`; bounded output window ([`02` §2, §16, §21](./02-Enterprise-Research.md)) | [`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) |
| **G23** | **Global suppression/blocklist enforced on the export path** as a hard gate (the compliance suppression list exists; export integration was Missing) | [`12-Security-and-Compliance`](./12-Security-and-Compliance.md) |
| **G17** | **Per-pipeline monitoring dashboards**: per-dimension quality metrics, segment match-rate/confidence by size/geo/seniority, FP/FN vs labeled set, per-tier verification yield ([`02` §20](./02-Enterprise-Research.md)) | [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) |
| **G18** | **Fleet (cross-tenant) data-quality view** — surface aggregated `data_quality_snapshots` to staff (today customer-only) | [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) |
| **G19** | **Surface-2 customer self-service** control panel: extend `apps/web/src/features/data-health` into own-workspace import wizard (reuse `apps/web` ImportWizard), dedup review, enrichment usage, export, retention/DSAR requests. RLS via `withTenantTx`; gated by `requireOrgRole`, **NOT** staff RBAC | [`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) |
| **G31** | **Quality per-dimension sub-scores**: decompose the aggregate quality score into six per-dimension sub-scores, recomputed on change, surfaced in the monitoring/quality view (dep G07 validation framework) | [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) |
| **G32** | **Bulk + export idempotent-replay-of-first-response proof**: a re-submit (incl. failures) returns the first response, not a duplicate — proven for both the bulk-import and export paths (deps G06 idempotency_key + G15 audited export) | [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) |

**New capability introduced:** `data:export`.
**New flags touched:** approval-workflow and self-service surfaces roll out per-tenant via
`feature_flags` (override → global → default, fail-closed via `isFlagEnabledForTenant`).

**Entry gate:** Medium-P1 exit green — specifically the **validation framework (G07)** and the
**dedup/ER review surfaces (G09/G10)** must exist, because approvals (G14) wrap *those* operations
and exports (G15) depend on validated data.

**Exit / acceptance gate:**
- A high-risk op (bulk merge or export) **cannot commit** without a distinct checker approving
  the maker's request; maker ≠ checker enforced server-side; both identities + justification
  reason land in `platform_audit_log` via `withPlatformTx`.
- Worst-case spend is computed and shown **before** any bulk enrichment/export run commits.
- A bulk export **fails closed** if any row is on the global suppression list (hard gate, tested);
  the export artifact lives in a bounded download window; the whole path is audited and
  `data:export`-gated.
- Monitoring dashboards render per-dimension quality + segment match-rate + per-tier verification
  yield from real pipeline data; fleet quality view aggregates `data_quality_snapshots`
  cross-tenant **only** for staff with `data:read` (no PII leakage across tenants).
- A customer (non-staff, `requireOrgRole`) can import → review dups → see enrichment usage →
  export → file a DSAR/retention request **entirely within their own workspace** (RLS-enforced,
  cross-tenant isolation test green).

**Dependencies:** G02 → G16. G13, G07, G10 → G14 (approvals wrap validation + review). G14 → G15.
G15 → G23 (suppression on export). G01, G07, G11 → G17 (dashboards over pipeline data). G01 → G18.
G07, G09, G11 engines + `requireOrgRole` → G19.

**Rough effort:** G16 **S**, G14 **XL**, G15 **M**, G23 **S**, G17 **L**, G18 **M**, G19 **L**
→ **phase ≈ XL** (≈10–14 eng-weeks; **G14 maker/checker is the keystone XL** and gates Enterprise
retention-enforce, so it is the priority within the phase).

---

### 3.4 Enterprise / Phase 3+ — Govern & Scale

> **Theme:** the work that turns the console into a governed, auditable, multi-region data
> platform — and the only phase that performs **graduated destructive deletes** (retention
> enforce), which is *why it sits last, behind approvals (G14)*.

**Scope — capabilities that land:**

| Gap | Deliverable | Lands in doc |
|---|---|---|
| **G20** | **Retention `enforce` rollout with approvals**: graduate `retention_class_policies.mode` from `shadow` → `enforce` per class, behind `retention_engine_enabled` + a maker/checker approval per class. Starts low-risk, escalates ([`02` §14, §16](./02-Enterprise-Research.md)) | [`12-Security-and-Compliance`](./12-Security-and-Compliance.md) |
| **G21** | **Version-history / rollback**: golden record becomes a **derived, recomputable view** over preserved `source_records` (key ring); per-field last-validated timestamps; **non-destructive** merge rollback by re-derivation ([`02` §12, §13](./02-Enterprise-Research.md)) | [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) |
| **G22** | **SLOs + alerting + data lineage**; root-cause tooling over audit/decision logs (Duplicate-Analyzer pattern, [`02` §21](./02-Enterprise-Research.md)) | [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) |
| **G24** | **Attribute-level survivorship governance**: configurable, segmented, auditable per-field source-priority/recency/frequency/completeness/quality rules with cascading fallbacks ([`02` §14](./02-Enterprise-Research.md)) | [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) |
| **G25** | **Dedicated bulk queue lane + multi-window rate limits + quota/reset headers** below interactive traffic ([`02` §18](./02-Enterprise-Research.md)) | [`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) |
| **G26** | **Measured blocking-key strategy** for dedup/ER at scale; DSU clustering on a distributed engine; normalize-before-compare, dedupe-before-enrich ([`02` §22, §23](./02-Enterprise-Research.md)) | [`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) |
| **G27** | **Probabilistic ER (Splink) + clerical retune loop**: Fellegi-Sunter m/u → summed weights; flag → correction-queue → retune ([`02` §6, §9](./02-Enterprise-Research.md)). Replaces the `masterGraphMatcher` stub | [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) |
| **G28** | **CRM bidirectional sync / deletion-sync console**; instrument dup-creation provenance (~90% from CRM imports, [`02` §5](./02-Enterprise-Research.md)) | [`15-Future-Enhancements`](./15-Future-Enhancements.md) |
| **G29** | **Residency / multi-region ops** for cross-tenant staff data operations | [`12-Security-and-Compliance`](./12-Security-and-Compliance.md) |
| **G30** | **Automation / rules engine** for validation → routing → survivorship → retention decisions (rule-versioned governance) | [`15-Future-Enhancements`](./15-Future-Enhancements.md) |

**New capabilities introduced:** none new in the closed staff enum is *strictly* required (the
four `data:*` caps cover it), but `staff:manage`-level governance of survivorship rules (G24/G30)
and residency policy (G29) may warrant a narrow new cap — decided in [`11`](./11-Roles-and-Permissions.md).
**New flags touched:** `retention_engine_enabled` flips per canary tenant; per-class `mode`
graduates `shadow → enforce` one class at a time.

**Entry gate:** Medium-P2 exit green — **maker/checker approvals (G14) MUST exist** before any
retention `enforce` flip (a destructive delete with no approval is the canonical "bug, not a
style choice"). Monitoring (G17) must exist before SLOs (G22) can be defined.

**Exit / acceptance gate (per-capability, since this phase is long-lived):**
- **G20:** each retention class graduates `shadow → enforce` only after (a) shadow-count drift is
  within tolerance, (b) a maker/checker approval is recorded, (c) a per-tenant canary runs clean
  for an agreed window. Deletes are tombstoned (`contacts.deleted_at`) and reversible until the
  hard-delete horizon.
- **G21:** a merge can be **rolled back by re-derivation** with zero source-row loss (test:
  merge → rollback → golden record byte-identical to pre-merge derivation).
- **G22:** SLOs published with alerting wired to `apps/workers` sweeps + queue DLQs; lineage
  traces a record from `source_records` → `match_links` → `contacts`.
- **G25–G27:** bulk lane proven below interactive under load ([`13`](./13-Performance-and-Scaling.md));
  blocking keys measured before a run; Splink clerical retune loop closes (flag → correction →
  retune) on a labeled set.
- **G28/G29/G30:** enterprise-deal gated; ship per signed requirement.

**Dependencies:** G14 → G20 (approvals before enforce). G10 + preserved `source_records` → G21.
G17 → G22. G10, G21 → G24. G06 (bulk live) → G25. G10 → G26. G10 + G17 (labeled set) → G27.
G09, G14 → G28. platform residency model → G29. G07, G21, G24 → G30.

**Rough effort:** G20 **L**, G21 **XL**, G22 **L**, G24 **L**, G25 **M**, G26 **XL**, G27 **XL**,
G28 **XL**, G29 **XL**, G30 **XL** → **phase ≈ multi-quarter**; sequence by enterprise-deal pull,
with **G20 (enforce) and G21 (rollback) first** because they retire the highest-risk gaps
(deleting data; non-reversible merges).

---

## 4. Cross-Phase Dependency Graph

The hard ordering constraints (an edge `A → B` means *A must ship before B*):

```
                       ┌──────────── G02 data:read ───────────┐   (root — gates everything)
                       │                                       │
                 G01 overview                            G03 import drill-down
                       │                                       │
            ┌──────────┴───────────┐                  ┌────────┴────────┐
   G04 COPY spike            G05 object store      G07 validation   G08 reject triage
            └──────────┬───────────┘                framework            ▲
                       │                                  │               │
                 G06 bulk-enable                          └──────► (feeds G08)
                  (flip per-tenant)
   ─────────────────────────────────────────────────────────────────────────────
   G13 data:manage+data:review ──► G09 dedup review ─┐
        │                          G10 ER queue ─────┤
        │                          G11 enrich console┤
        └──────────────────────────────────────────►│
   G12 verifier vendor (EXTERNAL, start in MVP) ─────┘ (enrich-with-verify)
   ─────────────────────────────────────────────────────────────────────────────
   G16 data:export ─┐
   G13+G07+G10 ─────┴► G14 maker/checker ──► G15 audited export ──► G23 suppression-on-export
   G01+G07+G11 ─────► G17 monitoring        G01 ─► G18 fleet quality
   G07+G09+G11 engines + requireOrgRole ─► G19 Surface-2 self-service
   G07 ─► G31 quality sub-scores            G06+G15 ─► G32 idempotent-replay proof
   ─────────────────────────────────────────────────────────────────────────────
   G14 approvals ──► G20 retention ENFORCE          G10+source_records ─► G21 rollback
   G17 ─► G22 SLOs/lineage     G10+G21 ─► G24 survivorship    G06 ─► G25 bulk lane
   G10 ─► G26 blocking/DSU     G10+G17 ─► G27 Splink+retune   G09+G14 ─► G28 CRM sync
   platform residency ─► G29   G07+G21+G24 ─► G30 rules engine
```

**The five load-bearing edges** the task brief calls out, restated as gates:

1. **`data:read` + overview before any write surface.** G02 → G01, and G02 → G13 → all P1
   review writes. No Data-management write exists without a capability gate first.
2. **COPY-spike + object-store before bulk enable.** {G04, G05} → G06. The dark bulk pipeline is
   not flipped on for a real tenant until COPY-FROM-STDIN is verified under Bun *and* a prod
   object store replaces the dev `FileStore`.
3. **Validation before approval.** G07 → G14. You cannot maker/checker-approve a merge or export
   of data you have not first validated/triaged.
4. **Verifier-vendor before enrichment-with-verify.** G12 → the verify leg of G11/the enrichment
   workflow. Selection is *external* and must start in MVP so it does not stall P1.
5. **Approvals before retention enforce.** G14 → G20. A destructive `enforce` delete without a
   maker/checker approval is a bug — Security has final say.

---

## 5. Flag-Rollout Strategy (shadow → canary → GA)

Every Dark/Inert subsystem graduates the same way, **reusing the existing gates** rather than
removing them. The mechanism: per-tenant resolution through `feature_flags` (override → global →
default, fail-closed via `isFlagEnabledForTenant`) layered on top of the boot-time `env.ts`
booleans, plus per-class `mode` enums where they exist.

| Subsystem | Today (gate + state) | shadow / verify | canary (1 tenant) | GA |
|---|---|---|---|---|
| **Bulk import** (G04–G06) | `BULK_IMPORT_ENABLED` env.ts:174 **false** + per-tenant `bulk_import_enabled` **false** → **Dark** | COPY spike on UNLOGGED staging; object-store integration test | flip `bulk_import_enabled=true` for one internal/canary tenant; run real file E2E | global `feature_flags` default-on after canary clean for the agreed window |
| **Email/phone verification** (G12) | `passThroughVerifier` until `REACHER_*` env.ts:110 / `TWILIO_*` env.ts:117 → **Dark** | wire creds in staging; run labeled fixture; confirm multi-valued status never auto-promotes | enable `hybridVerifier` commercial leg for canary workspace; reconcile spend | per-tenant flag → global once yield + cost within tolerance |
| **Retention engine** (G20) | `retention_engine_enabled` **false** + per-class `mode='shadow'` → **Inert** (shadow-counts, deletes nothing) | keep `mode='shadow'`; watch `retention_runs` drift vs expectation | per-class `shadow → enforce` **with a maker/checker approval** on one canary tenant; tombstone-only, reversible | graduate classes one at a time, low-risk first; full `enforce` only after approval + clean canary |
| **Approval workflow** (G14) | Missing | build behind a `feature_flags` flag; dry-run preview-then-commit with no real commit | enable for staff on canary tenant ops | global once maker≠checker + audit invariants proven |
| **Surface-2 self-service** (G19) | data-health page live; rest Missing | build behind per-tenant flag | enable for one customer org (`requireOrgRole`) | GA per plan tier |

**Rollback for every flag:** flipping the flag *off* must return the subsystem to its prior inert
state with no orphaned writes — bulk import truncates staging; retention enforce reverts to shadow
and tombstones remain reversible until the hard-delete horizon; verification falls back to
`passThroughVerifier`. This is verified as part of each phase's exit gate.

**Migration numbering:** the per-doc new migrations are assigned **sequentially** (0035, 0036,
0037, …) at implementation time as each phase lands — they are *not* all `0035`; several docs add
migrations in the same phase, so the next free number is taken in PR order.

---

## 6. Owners / Teams (mapped to skills)

Each gap's *owning skill* follows the `CLAUDE.md` routing table and precedence. The mapping below
assigns a **lead** and **required co-reviewers** (a write path always needs Platform for the
RLS/`withPlatformTx` route and Security for the isolation sign-off).

| Workstream | Lead skill | Mandatory co-review | Representative gaps |
|---|---|---|---|
| Capabilities + RBAC enum/gates | **truepoint-security** | platform (gate wiring) | G02, G13, G16 |
| Nav group, feature folders, hooks, console UX shell | **truepoint-architecture** | design | G01, G03, G19 |
| Component/states/tables/wireframes | **truepoint-design** | architecture | all UI surfaces |
| API routers `/api/v1/admin/data/*`, tenancy, `withPlatformTx`/`withTenantTx`, queues, scale | **truepoint-platform** | security | G01, G03, G14, G15, G25 |
| Data model: validation, dedup/ER, survivorship, version-history, enrichment semantics | **truepoint-data** | platform, security | G07, G09, G10, G11, G21, G24, G27 |
| Suppression/export safety, residency, retention enforce, PII | **truepoint-security** | data, platform | G12, G20, G23, G29 |
| Object store, COPY spike infra, monitoring/SLO, FinOps on metered enrichment, incident runbooks | **truepoint-operations** | platform | G04, G05, G17, G22, G28 |

**Precedence reminders that bind ownership decisions:** Security has final say on whether anything
is safe (access, isolation, suppression, residency, retention deletes). Platform owns the tenancy
mechanism (RLS), the API contract, and scale. Data owns the model + ownership semantics; Security
enforces them. Structure rules (file-size, feature-folder) **never** override an isolation test,
tenant-scoping, or input validation.

---

## 7. Per-Phase Success Metrics + Acceptance Checklist

### 7.1 MVP / Phase 0

**Success metrics:**
- Time-to-first-signal: a staff user reaches a composed fleet view of queue depth + run status +
  quality rollup in **one screen**, zero new tables.
- Bulk-import canary throughput recorded (rows/sec via COPY) and a successful idempotent replay.
- 0 PII-content leaks across the admin seam (asserted by test).

**Acceptance checklist:**
- [ ] `data:read` in `staffCapability.ts:13`; bundled; `super_admin` implies; gate rejects unauthorized.
- [ ] Data management nav group in `navConfig.ts`; hidden without cap; server-authoritative 403.
- [ ] Data-Ops Overview composes ≥3 existing signals; `StateSwitch` four states; **no new write**.
- [ ] Import drill-down: chunks/rows/rejects (metadata + counts only); PII-content leak test green.
- [ ] COPY-FROM-STDIN spike signed off (≥100k-row fixture, throughput + rollback documented).
- [ ] Prod object-store adapter: put → signed-get → expiry integration test green.
- [ ] Bulk canary E2E: upload → stage → promote → fan-out; idempotent replay returns first job.

### 7.2 Medium-P1 / Phase 1

**Success metrics:**
- A record completes **validate → dedup-review → enrich** with every write audited.
- Validation reject-ledger coverage: 100% of rejected rows inspectable + re-submittable.
- Enrichment **charge-on-success only** reconciles to `enrichment_jobs.cost_micros`/`charged`
  with 0 charged failures; test-batch (25–50) runs before any full run.
- Email verifier: `catch_all`/`unknown` auto-promotion rate to `valid` = **0**.

**Acceptance checklist:**
- [ ] `data:manage` + `data:review` defined, bundled, gates reject unauthorized (isolation tests).
- [ ] Validation runs ordered file→schema→row→aggregation with a populated reject ledger.
- [ ] Reject-triage: failed-results artifact + correlation token; re-submit path works.
- [ ] Dedup review surface: human override writes audited; dup-creation provenance instrumented.
- [ ] ER queue over `review_status='pending'` with weight decomposition; no auto-merge above
      steward threshold without a human (false-negative bias).
- [ ] Enrichment console: per-provider hit-rate + spend; re-run; test-batch; bills only successes.
- [ ] Commercial verifier wired behind `REACHER_*`/vendor env; labeled-fixture pass; contract signed.

### 7.3 Medium-P2 / Phase 2

**Success metrics:**
- 100% of high-risk ops (bulk merge, export, enforce-flip) require a maker/checker approval;
  maker = checker rejection rate measured.
- Worst-case spend shown before every bulk run; export suppression-block rate observable.
- Cross-tenant fleet quality view available to staff; **0** cross-tenant PII leaks (test).
- A customer completes self-service import → dedup → enrichment-view → export → DSAR within own
  workspace (RLS), 0 cross-tenant reads.

**Acceptance checklist:**
- [ ] `data:export` defined, bundled, gates reject unauthorized.
- [ ] Maker/checker: maker≠checker enforced server-side; both + justification in `platform_audit_log`.
- [ ] Worst-case spend pre-computed and shown before commit.
- [ ] Audited bulk export via `withPlatformTx`; **fails closed on suppression hit**; bounded
      download window; `data:export`-gated.
- [ ] Monitoring: per-dimension quality + segment match-rate + per-tier verification yield render.
- [ ] Fleet quality view aggregates `data_quality_snapshots` cross-tenant for `data:read` only.
- [ ] Surface-2 self-service: `requireOrgRole`-gated, `withTenantTx`-scoped; isolation test green.
- [ ] G31: six per-dimension quality sub-scores recomputed on change and surfaced.
- [ ] G32: bulk + export idempotent replay of first response (incl. failures) proven.

### 7.4 Enterprise / Phase 3+

**Success metrics:**
- Retention `enforce`: classes graduated with 100% approval coverage; tombstone-reversible until
  horizon; shadow-vs-enforce drift within tolerance.
- Rollback: 100% of merges re-derivable with **0** source-row loss.
- SLOs published + alerting wired; lineage traces source → match → contact.
- Bulk lane stays below interactive latency under load; Splink retune loop closes on labeled set.

**Acceptance checklist:**
- [ ] G20 enforce: per-class `shadow → enforce` only after approval + clean canary; reversible.
- [ ] G21 rollback: merge → rollback → golden record byte-identical to pre-merge derivation.
- [ ] G22: SLOs + alerting on sweeps/DLQs; lineage trace works end-to-end.
- [ ] G24 survivorship rules configurable, segmented, audited.
- [ ] G25 bulk lane proven below interactive ([`13`](./13-Performance-and-Scaling.md)).
- [ ] G26/G27: blocking measured before run; DSU on distributed engine; Splink retune loop closes.
- [ ] G28/G29/G30 delivered per signed enterprise requirement.

---

## 8. Cross-References

- Tiering source of truth: [`03-Gap-Analysis`](./03-Gap-Analysis.md) (G01–G32, `Tier` column).
- Best-practice citations: [`02-Enterprise-Research`](./02-Enterprise-Research.md) (23 dimensions).
- Current state + status badges: [`01-Current-State-Analysis`](./01-Current-State-Analysis.md).
- Per-capability designs: [`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) ·
  [`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) ·
  [`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md) ·
  [`07-Deduplication-and-Linking`](./07-Deduplication-and-Linking.md) ·
  [`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md) ·
  [`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) ·
  [`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) ·
  [`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) ·
  [`12-Security-and-Compliance`](./12-Security-and-Compliance.md) ·
  [`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md).
- Beyond-roadmap items: [`15-Future-Enhancements`](./15-Future-Enhancements.md).
