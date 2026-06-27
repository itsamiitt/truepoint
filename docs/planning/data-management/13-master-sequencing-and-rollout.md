# 13 — Master Sequencing & Rollout (series capstone)

> **Gate:** capstone / index. **Posture:** reconcile-and-cite — synthesizes the data-management series
> (`00`–`12`) into one sequencing + rollout view. **Converts** the incoming brief *"07 — Master
> Sequencing & Rollout."* Complements `00-overview.md` (locked decisions/vocabulary) with the
> dependency chain, cross-cutting rules, the **reconciled** global Definition of Done, the **reconciled**
> risk register, and the **consolidated build backlog**. **No source code is modified.** This is the
> **final doc** of the series.

## 1. Dependency chain (affirmed)

Data management is a dependency chain (cite `00 §6`):

```
01 Research  →  canonical primitives everything reuses (§3.x of 01)
   │
08 Phase 1  Ingestion & Identity     →  clean, deduped spine (runImport.ts — already shipped)
   │
09 Phase 2  Enrichment & Provenance  →  fill + verify + prove source, on stable identities
   │
10 Phase 3  Quality, Storage, Model  →  formalize model, constraints, projections, metrics
   │
11 Phase 4  Access, Governance, Compl →  who / consent / suppression / erasure (existential)
   │
12 Phase 5  Sync & Search            →  flow data out correctly + retrieve fast at scale
```

| Edge | One-line rationale |
|---|---|
| research → P1 | identity normalizers/ladder are the primitives every later phase reuses (DM1). |
| P1 → P2 | enrichment writes onto **resolved** identities; before identity it scatters across duplicates. |
| P2 → P3 | you formalize the model + quality metrics once provenance + verification produce trustworthy values. |
| P3 → P4 | governance needs a trustworthy, scoped model to govern. |
| P4 → P5 | sync before governance would **leak suppressed/erased data** out — the order is a safety property. |

## 2. Document index (13 docs)

| Doc | Role | Posture |
|---|---|---|
| `00-overview` | spine: locked decisions DM1–DM9, vocabulary, dimension→doc map, coherence | new |
| `01-research-brief` | cross-cutting research gate: primitives, benchmarks, risk register | standalone (cited research) |
| `02-identity-and-dedup` | identity ladder, normalizers, dedup | mostly reuse + URN/slug |
| `03-enrichment-and-verification` | waterfall + the verifier subsystem | reuse + net-new verifier |
| `04-provenance` | `field_provenance` winner-map + channel provenance | mostly reuse |
| `05-compliance` | Art.14 source-notice, DPDP, TCPA/DNC | reuse + net-new law |
| `06-storage-and-scale` | isolation, index strategy, projections | mostly reuse |
| `07-sync` | CRM bi-directional conflict resolution | largely net-new |
| `08-phase1-ingestion-and-identity` | ingestion spine spec (confirms `runImport`; scopes bulk COPY) | reconcile |
| `09-phase2-enrichment-and-provenance` | engine confirmed; verifier + freshness net-new | reconcile |
| `10-phase3-quality-storage-modeling` | visibility-model correction; quality dashboard; projections | reconcile |
| `11-phase4-access-governance-compliance` | RBAC/audit/erasure layer over `05` | reconcile |
| `12-phase5-synchronization-and-search` | sync (`07`) + search (`06`) + ICP composition | reconcile |
| `13-master-sequencing-and-rollout` (this) | sequencing, DoD, risk register, backlog | capstone |

## 3. Cross-cutting rules (reconciled, with `file:line`)

| Rule | Status | Evidence |
|---|---|---|
| **One canonical normalizer module** (kills A3/A6) | ✅ already true | one module; ADR-0037 C5 forbids a 2nd; eTLD+1 + freemail guard — `matchKeys.ts:6-7,:74`, `freemailDomains.ts` |
| **One scoping predicate (`scopeFor`)** | ✅ hard wall + ▶ app-layer net-new | RLS is the DB-enforced workspace wall (`rls/contacts.sql`, `client.ts`); a single app-layer `scopeFor` for owner/team/list visibility is net-new (`10 §5`) |
| **Provenance on every written field** | ✅ already true | `enrichContact.ts:169-193` + `runImport.ts` stamp `field_provenance` |
| **Suppression gate non-bypassable (fail closed)** | ✅ already true | in-tx reveal + send (`08 §3`); `assertNotSuppressed` |
| **Platform-admin enrichment vs tenant paths physically separate** | ✅ already true | `withErTx`(`leadwolf_er`)/`withTenantTx`(`leadwolf_app`)/`withPrivilegedTx`; co-op CONTRIBUTE-TO off (ADR-0021) |
| **SSRF allowlist on external calls** | ✅ + ▶ residual | enrichment has no URL surface (hardcoded adapters, `provider_configs` has no URL); the IP/metadata guard exists for webhooks (`ssrfGuard.ts`); residual = DNS-rebind TOCTOU (R4) |
| **Every migration expand→backfill→contract, online-safe, reversible, shadow first** | pattern (reused) | `NOT VALID`→`VALIDATE`; shadow/flag cutover (`08`–`12 §7`) |

## 4. Global definition of done (reconciled)

| DoD item | Status | Evidence / owner |
|---|---|---|
| Single ingestion pipeline; duplicate paths deleted | ✅ already (one `runImport`, two transports; **no duplicates exist**) | `imports.ts:1-7`; `08 §2` |
| Single normalizer module; A3/A6 resolved | ✅ already / refuted | `matchKeys.ts`; `01 §6`; `08 §2` |
| Single visibility predicate; no IDOR in tests | ✅ RLS + `visibleContactIds`; ▶ `scopeFor` app-layer | `10 §5` |
| Provenance on every enriched field; DSAR export source per field | ✅ already | `enrichContact.ts`; `assembleAccessReport` + `source_records` (`11 §6`) |
| SSRF blocked (internal IPs + metadata) in tests | ✅ (webhook surface); enrichment has no surface | `ssrfGuard.ts`; `09 §6` |
| Suppression non-bypassable on every send/dial path | ✅ send; ▶ dial (pending the dialer + TCPA pre-dial) | `08 §3`; `05 §4`/`11` |
| Erasure removes PII from core, projections, caches; propagates to CRM | ✅ core + verification scan; ▶ projections/CRM (forward) | `deleteFanout.ts`; `11 §5`/`12` |
| Tenant isolation verified across all phases | ✅ RLS + role separation | `00`/`06`/`08`–`12 §RLS` |
| Search within latency at lakh-row scale | ✅ Postgres-native today; ▶ ranked/projections at scale | `06 §3`/`12 §5` (PLAN_05) |
| Quality dashboard (fill/bounce/conflict/freshness) live | ◑ live aggregate landed (per-contact badge + `GET /home/data-quality`); conflict-rate + precomputed snapshot are follow-ups | `10 §5` (`22`/`11`) |
| Five-Hard-Gates signed off per phase | pattern enforced per doc §8 | `08`–`12` |

## 5. Risk register (reconciled)

**Refuted (do not carry as open):**

| Risk (as briefed) | Verdict | `file:line` |
|---|---|---|
| SSRF via admin-configured source URL | **Refuted** | `provider_configs` has no URL (`intel.ts:120-127`); adapters hardcoded (`providers.ts`) |
| Triplicated normalizers diverge | **Refuted** | one module (`matchKeys.ts:6-7`); ADR-0037 C5 |
| False company merges (country-code domains) | **Refuted** | eTLD+1 PSL (`matchKeys.ts:74`) + freemail guard (`freemailDomains.ts`) |
| Tenant data reaches admin enrichment | **Refuted** | role separation (`withErTx`); co-op off (ADR-0021) |

**Real / open:**

| Risk | Phase | Mitigation |
|---|---|---|
| Mint-then-merge duplicate tail | 1 | C4 re-point cascade (PLAN_00 C4; `02 §6`) |
| Webhook DNS-rebind TOCTOU (R4) | 2 | connect-by-pinned-IP follow-up (`ssrfGuard.ts:11-14`) |
| IDOR on owner-scoped reads | 3 | RLS hard wall + single app-layer `scopeFor` (`10`) |
| Projection/core divergence | 3 | RYOW + `search_outbox` + self-heal (PLAN_05) |
| Suppressed/erased leak via sync | 4/5 | export anti-join + global suppression (`08 §3.2`, `deleteFanout`) |
| Sync echo loops | 5 | per-field direction + time-threshold tiebreak (`07` F3) |
| CRM-erasure propagation incomplete | 4/5 | tracked-to-completion when sync ships (`11`/`12`) |

## 6. Consolidated build backlog (the genuinely-unbuilt work)

Ordered by the dependency chain + leverage. Each item is **designed**; this is the build queue.

| # | Item | Spec | MVP vs scale track |
|---|---|---|---|
| 1 | **Verifier subsystem** (email hybrid Reacher+commercial; phone line-type) — unblocks "charge only for verified" already wired into `chargeFor` | `03`/`09 §5`; `01 §5.2/5.3` | MVP — **email + phone + carrier line-type landed** (Reacher email verifier + `hybridVerifier`; Twilio Lookup phone verifier → carrier-confirmed valid/invalid **+ `phone_line_type` (mobile/landline/voip — the TCPA signal) via migration 0021**; all config-gated, wired into reveal & reverify, persisted; a zero-network role/disposable **local pre-screen** (`localPrescreenVerifier`) wraps Reacher to skip paid probes on the obvious cases). Pending: commercial email secondary (vendor open). _Migration 0021 hand-authored mirroring 0017/0020; CI itests validate `migrate`; run `drizzle-kit generate` to confirm no snapshot drift._ |
| 2 | **Bulk COPY-staging pipeline** (million-row import/export) | ADR-0036 / `08 §5` | MVP |
| 3 | **Freshness / re-enrichment loop** (per-field cadence) | ADR-0025 / `09 §5` | MVP — **in progress** (`runReverification` + the `reverification` queue + leader-locked daily sweep landed, keyed on `last_verified_at` + the in-use revealed gate; **rollout-gated by the `data_health.reverification` per-tenant flag**; **the `verification_jobs` audit ledger landed (migration 0022, workspace-scoped RLS, one row per run)**; a line-type re-check remains a follow-up) |
| 4 | **Teams/visibility + RBAC `org_role`** (+ app-layer `scopeFor`) | ADR-0022/0030; `10`/`11` | MVP (M11) |
| 5 | **Quality metric dashboard** (fill/bounce/conflict/freshness) | `10 §5` (`22`/`11`) | MVP — **per-contact Data Health badge now surfaces on the main contact list + search** (`contactRepository.listByWorkspace`/`listMaskedByIds` reuse the canonical `computeContactDataQuality`, mirroring the list-member projection) **plus the per-workspace aggregate** (`contactRepository.dataQualitySummary` + `GET /home/data-quality`) — a live RLS-scoped count rollup (fill, email/phone verification, freshness, **phone carrier line-type** mobile/landline/voip) **plus a daily snapshot trend store (`data_quality_snapshots`, migration 0023, leader-locked sweep)** for history; the conflict-rate (field_provenance) metric remains a follow-up |
| 6 | **Per-data-class retention engine** | ADR-0025 / `11 §5` | MVP |
| 7 | **CRM sync + activity write-back + erasure propagation** | `07`/`12 §5`; `26 §2` | MVP (per-tenant) |
| 8 | **Per-workspace ICP tuning / model registry** | ADR-0008 *Revisit if*; `12 §5` | MVP |
| 9 | **Global Splink/ER tail + projection + true-ranked search** (OpenSearch/ClickHouse/Citus/Iceberg) | ADR-0021/0035; PLAN_05/06 | **deferred scale track** (PLAN_00 C9) |

## 7. Cadence & per-phase gate

Per phase: **Research → Brainstorm → Plan → approve → Implement → Verify**; do not start the next
phase's implementation until the current Verify gate passes. Ship behind **per-tenant feature flags**;
run **shadow mode** before every cutover. Each phase signs off the **five hard gates**: tenant
isolation · bounded queries · pool safety · online-safe migrations · cache correctness (the `§8`
checklist in `08`–`12`).

## 8. Series status & recommended next move

**The data-management planning series is complete (`00`–`13`, 14 docs).** Across the series the
recurring finding held: the incoming briefs' premises were largely contradicted by shipped code or
accepted ADRs, and the genuinely-unbuilt work is the finite, designed backlog in §6.

**Recommended next move: build, not spec.** The two highest-leverage MVP items are (1) the **verifier
subsystem** (it makes the already-wired "charge only for verified data" real) and (2) the **bulk
COPY-staging pipeline** (the one true scale gap). Both are fully designed (§6) and ready to implement.

## Sources

Series docs `00`–`12` and the verified `file:line` anchors therein (`matchKeys.ts`, `freemailDomains.ts`,
`runImport.ts`, `imports.ts`, `enrichContact.ts`, `searchRepository.ts`, `deleteFanout.ts`,
`provider_configs` `intel.ts:120-127`, `ssrfGuard.ts`, `client.ts`); ADRs 0008/0021/0022/0025/0030/0035/
0036/0037; `prospect-company-data` PLAN_00 (C4/C9), PLAN_05/06; `22`/`26`.
