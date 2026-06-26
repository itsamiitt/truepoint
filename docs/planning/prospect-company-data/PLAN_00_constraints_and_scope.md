# Phase 0 — Binding Constraints & Scope (prospect↔company data initiative)

> **Gate: PLAN.** Phase 0 of the prospect↔company data initiative — the **spine** document. The
> Locked Constraints (§1), Scope boundary (§2), Shared Vocabulary (§3), Gap-to-Target (§4), and the
> Required-by-every-PLAN checklist (§8) below are **canonical**: every downstream PLAN gate
> (`PLAN_01_entities`, `PLAN_02_link`, `PLAN_03_provenance`, `PLAN_04_projection`, `PLAN_05_read`,
> `PLAN_06_freshness`) cites them verbatim and must not contradict them. **Converts:**
> `RESEARCH_00_current_state.md` (the frozen BUILT/PLANNED/UNDESIGNED baseline + its §9 recommendation)
> and `BRAINSTORM_00_scope.md` (the §5 DECISION: Framing A — structural-skeleton-first). **Cross-reads**
> the sibling research/brainstorm corpus it sequences (`*_01`…`*_06`, plus `RESEARCH_07_migration.md`).
> **Ground truth:** ADR-0021 (two-layer model), ADR-0037 (`MatchPort` seam), ADR-0015 (ER engine),
> ADR-0006/0007/0022/0025/0035, `03-database-design.md §5`. **No code, schema, SQL, or settings are
> modified by this gate — only this file is written.** House style: `list-plan/00-overview.md`.

---

## 0. What this document is — and its lineage

`RESEARCH_00` answered *"what exists today"* and closed (§9) with a recommended sequence: **edge-first,
schema-led; reject "just port the DDL"; treat field-level provenance as genuine invention; keep the
overlay FKs nullable; defer the billions-scale topology.** `BRAINSTORM_00` ratified that into a scope
**DECISION** (§5): **Framing A — land the Layer-0 entity *tables* + the `master_employment` edge + the
overlay `master_*_id` back-refs as one deterministic-only skeleton on the existing Aurora stack, with the
field/edge-provenance seam *reserved* at freeze, the probabilistic ER tail and billions-scale topology
deferred to a gated scale track, and `master_*_id` modelled as a re-pointable pointer with a merge
cascade from day one.**

This PLAN **converts both into binding constraints** the whole initiative obeys. It traces **directly**
to those two artifacts: every locked constraint in §1 names the brainstorm decision-clause or the
research finding it crystallizes. It is the analogue of `list-plan/00-overview.md` — the *shape of the
road*, not the *paving*. It does **not** freeze a migration: the Layer-0 DDL is `PLAN_01`+`PLAN_02`'s
co-landed output (§7); the provenance structure is `PLAN_03`'s; the projection access path is `PLAN_04`'s.
What it freezes is the **set of rules each of those PLANs must satisfy** and the **target each builds toward**.

---

## 1. Locked constraints (canonical — cite these everywhere)

> Derived from the brainstorm DECISION (`BRAINSTORM_00 §5`), the research recommendation
> (`RESEARCH_00 §9`), and the cross-cutting constraints in CLAUDE.md / ADR-0021. **Not open for
> re-litigation inside a downstream PLAN.** Each is stated as a rule + the gap it currently has.

- **C1 — The model is two-layer; truth moves to Layer 0.** Layer 0 (system-owned master graph) is the
  source of truth; Layer 1 (`contacts`/`accounts`) becomes a per-workspace **overlay** carrying a
  `master_person_id`/`master_company_id` back-ref + workspace-private state only (ADR-0021 Decision;
  `03-database-design.md:379-557`). This **inverts where truth lives** — today the overlay rows *are* the
  truth (`RESEARCH_00 §8.1`). Every later phase carries this inversion as a load-bearing assumption.
  *Implementation status:* Layer 0 is **100% docs** — no `master_*` table or repo exists
  (`RESEARCH_00 §0`); work-to-do, not license to keep treating the overlay as truth.

- **C2 — The prospect↔company edge is `master_employment`, and it is the central design object.** A
  person↔company edge with `is_current` + `started_on`/`ended_on` + title/department/seniority, resolved
  primarily by email-domain → `master_companies.primary_domain`/`alt_domains` (PSL eTLD+1)
  (`03-database-design.md:428-436`; ADR-0021 Decision). It replaces the degenerate single
  `contacts.account_id` FK (`contacts.ts:98`) and fixes its four limits — no history, no
  multi-affiliation, no edge provenance, no shared company identity (`RESEARCH_00 §3`). Building *on* the
  shipped registrable-domain key (`matchKeys.ts:74-81`), never reinventing it.

- **C3 — The import-path matching invariant is always-on; CONTRIBUTE-TO stays off.** Every overlay row —
  **including default CSV import** — runs through global ER (**MATCH-AGAINST**) and sets its
  `master_*_id` to the resolved-or-minted golden identity; this is unconditional for every workspace
  (ADR-0021:53-65). It is **separate** from **CONTRIBUTE-TO** (promoting a workspace's imported field
  values into the golden record), which is opt-in/contractual and **OFF by default** (ADR-0021:59-62;
  `list-plan/00-overview.md` D1). *Matching always happens; contributing does not.* *Implementation
  status:* no import path sets `master_*_id` today — the columns and graph do not exist
  (`RESEARCH_00 §4.2`); MATCH-AGAINST is the target the skeleton must wire.

- **C4 — `master_*_id` is a mutable pointer with a merge re-point cascade, not a stable identity.**
  Deterministic-only resolution will **mint duplicate masters** for the same human/company when no exact
  key is shared (`BRAINSTORM_00 §2.A`, the A-killer). The deferred Splink pass later **merges** them, so
  every overlay row pointing at the loser must be **re-pointed** (`match_links.is_duplicate_of`-driven,
  `03-database-design.md:480`). The re-point cascade is **designed alongside the skeleton, day one** —
  not retrofitted — so the skeleton never accrues silent dangling-pointer corruption. This is the single
  control that makes Framing A safe (`BRAINSTORM_00 §3 case IV`, `§6 Q1`).

- **C5 — Deterministic-only resolution at MVP, reusing the shipped normalizers — no second normalizer.**
  Resolution uses *only* the deterministic match-key ladder already in code (`matchKeys.ts`: email blind
  index → LinkedIn id → E.164 → registrable domain → name+company fuzzy fallback; `RESEARCH_00 §4.1`);
  the Splink probabilistic tail is deferred (C9). ADR-0037 **forbids** a parallel bulk normalizer — the
  shipped `matchKeys.ts` is the single canonical source; zero bulk-vs-batch drift (ADR-0037:75-81,133).

- **C6 — Field/edge provenance is *designed* at freeze and *built* later — a reserved seam, not a
  retrofit.** Per-field `{source, confidence, updated_at}` (U1) + per-edge lineage (U2) touch *every*
  column the initiative adds; retrofitting them onto live rows is a destructive backfill
  (`BRAINSTORM_00 §2.C`, `§5.2`). So the **seam** (a column/structure that exists) is reserved at the
  schema freeze (`PLAN_01`/`PLAN_02`), the **merge engine** is built in `PLAN_03` once entities + edges
  exist to merge. *Implementation status:* per-field provenance is **UNDESIGNED anywhere** — the core
  invention (`RESEARCH_00 §5/§7.2 U1`; ADR-0006:51 names its absence).

- **C7 — Layer 0 is system-owned, isolated by access path — never a workspace RLS predicate.** A
  workspace reaches Layer 0 *only* through masked search + the paid-reveal copy + privileged
  system/admin roles — never a direct read (ADR-0021:129-131; `03-database-design.md:698`). This is the
  central tension (`RESEARCH_00 §6`): shared canonical infra under a model whose **default isolation is
  RLS**. It is *resolved in code* in Phase 4 (`PLAN_04`), never by relaxing the overlay's wall (C8).

- **C8 — The overlay's FORCE-RLS posture and the two-tenant isolation itest are non-negotiable.** Every
  Layer-1 table stays `ENABLE` + `FORCE ROW LEVEL SECURITY` with `USING`/`WITH CHECK` keyed on the
  fail-closed GUC (`rls/contacts.sql:16-48`; `client.ts:48-68`); a mandatory two-tenant isolation itest
  gates merge (`list-plan/02-data-model.md:48-65`). **Security has final say** (CLAUDE.md precedence) —
  no Layer-0 integration convenience erodes this. Overlay `master_*_id` FKs stay **nullable** (no NOT
  NULL day one): ADR-0021 reserves nullability for in-flight ER staging (ADR-0021:63-65); the control on
  the invariant is an import-path assertion + backfill + the C4 cascade, never a column constraint.

- **C9 — The billions-scale topology + the probabilistic ER tail are a gated SCALE TRACK, not MVP.**
  Splink fuzzy-tail ER, Citus shard, OpenSearch global masked index, ClickHouse facet counts, S3+Iceberg
  lake, and the `masterGraphMatcher` promotion (stub→real) are **deferred** behind an explicit gate
  (ADR-0021:129-132 Mitigation; ADR-0037 stage 2; `masterGraphMatcher.ts:26-34`). The MVP delivers the
  edge model + provenance design on the existing single-Aurora + Typesense stack. Deferral ≠ omission —
  the mint-then-merge debt (C4) is the bridge the MVP builds *toward* the track (`BRAINSTORM_00 §5.1`).

- **C10 — Within a workspace, visibility is owner-scoped + list-shared at the app layer, not RLS.** RLS
  is the **workspace** wall; `owner_user_id`/`assigned_team_id`/`visibility` and list-based sharing are
  an **app-layer filter** (ADR-0022; `RESEARCH_00 §6`). `revealed_by_user_id` (immutable first-reveal
  credit) stays distinct from `owner_user_id` (assignable). *Implementation status:* `owner_user_id` +
  `revealed_by_user_id` exist; `assigned_team_id`/`visibility`/`teams` do not (`RESEARCH_00 §6`).

---

## 2. Scope boundary (IN vs the deferred SCALE TRACK)

> Verbatim from the brainstorm DECISION (`BRAINSTORM_00 §5.1`). The OUT column is **deferral, not
> omission** (C9). Today **none** of the IN items exist in code (`RESEARCH_00 §0`); the whole table is
> work-to-do.

| **IN scope — MVP build (existing Aurora + Typesense)** | **OUT — deferred SCALE TRACK (gated, M12/M13)** |
|---|---|
| Layer-0 entity **tables**: `master_persons`, `master_companies`, `master_employment`, `master_emails`, `master_phones`, `source_records` (`03-database-design.md:390-486`) | Splink **probabilistic fuzzy-tail** ER + blocking/MinHash-LSH at billions (ADR-0015/0021; `RESEARCH_00 §4.2`) |
| Overlay back-refs `contacts.master_person_id` / `accounts.master_company_id`, **nullable** (C8), populated by the import path | `masterGraphMatcher` promotion stub→real (ADR-0037 stage 2; `masterGraphMatcher.ts:26-34`) |
| **Deterministic-only** resolution reusing `matchKeys.ts` (no second normalizer — C5) | Citus shard of the golden store; OpenSearch global masked index; ClickHouse facet counts; S3+Iceberg lake + Splink-on-Spark (`03-database-design.md:722-753`) |
| The field/edge-provenance **seam reserved** at freeze (C6) — additive later, not a backfill | The provenance **merge engine** (U4 survivorship application; conflict arbitration) — designed `PLAN_03`, built after entities exist |
| `master_*_id` as a **mutable pointer** + a re-point cascade contract (C4) | The co-op **CONTRIBUTE-TO** path — OFF by default; out of this initiative entirely (C3; ADR-0021) |
| `match_links` minimal (cluster id + `is_duplicate_of`) to record minted clusters + drive the cascade | Calibrated two-threshold review queue + clerical-review UI (ADR-0015; `match_links.review_status` stays `'auto'` at MVP) |

---

## 3. Shared vocabulary (canonical)

- **Layer 0 / master graph** — the system-owned, **not** RLS-scoped global universe of golden people +
  companies + the raw evidence behind them (`master_*` + `source_records` + `match_links`; ADR-0021).
- **Layer 1 / overlay** — the per-workspace, RLS-scoped `contacts`/`accounts` rows, each a curated copy
  referencing a master entity and carrying workspace-private state (notes/lists/scores/reveal ownership).
- **Master entity** — a `master_persons` or `master_companies` row: a single golden identity.
- **Golden record** — a master entity whose surviving field values are survivorship-merged from multiple
  `source_records` (the *target*; at MVP a deterministically-minted master is a golden-*shaped* row that
  is **not yet survivorship-merged**).
- **Employment edge** — a `master_employment` row: the person↔company link (current + past), the central
  design object (C2). `master_persons.current_company_id` denormalizes the `is_current` edge.
- **MATCH-AGAINST** — resolving an overlay row to a master entity (sets `master_*_id`); **always on** for
  every workspace, including default import (C3).
- **CONTRIBUTE-TO** — promoting a workspace's imported field *values* into the golden record for other
  workspaces; **opt-in/contractual, OFF** (C3).
- **Projection / projection boundary** — the access path (masked search + paid-reveal copy + privileged
  roles) by which a workspace reaches Layer 0 *without* a direct read; the system-owned↔RLS seam (C7).
- **Mint-then-merge** — the MVP semantics: deterministic resolution **mints** a fresh master for an
  unmatched row (satisfying C3); the deferred ER later **merges** duplicates and fires the re-point
  cascade (C4).
- **Provenance seam** — the reserved column/structure (C6) into which `PLAN_03` builds per-field/edge
  `{source, confidence, updated_at}` additively.
- **Scale track** — the gated tail (C9): probabilistic ER + Citus/OpenSearch/ClickHouse/Iceberg.

---

## 4. Gap-to-target (current code → target, per area)

> Each row: where the code is today → what the target is → which constraint + which PLAN owns the close.
> `file:line` = shipped code; `03 §5.x` / `ADR-xxxx` = the spec'd target.

| Area | Current (BUILT in code) | Target | Owns it |
|---|---|---|---|
| **Entities** | `contacts`/`accounts` overlay only, no master tables (`contacts.ts:41-207`) | Layer-0 `master_persons`/`master_companies` (+`master_emails`/`master_phones`/`source_records`/`match_links`) (`03 §5.1`) | C1 · `PLAN_01` |
| **Link** | single `contacts.account_id` FK, one company, no history (`contacts.ts:98`) | `master_employment` edge: current+past, multi-affiliation, `UNIQUE(person,company,started_on)`, partial `WHERE is_current` (`03-database-design.md:428-436`) | C2 · `PLAN_02` |
| **Overlay back-ref** | absent from `contacts.ts`/`accounts.ts` | `contacts.master_person_id` / `accounts.master_company_id` nullable + partial `idx_*_master` (`03-database-design.md:495,511,518,556`) | C1/C8 · `PLAN_02` |
| **Identity resolution** | within-workspace exact keys + soft `duplicate_of_contact_id` pointer (`dedup.ts`, `matchKeys.ts`) | global cross-source MATCH-AGAINST; deterministic-only at MVP (mint-then-merge), Splink tail deferred | C3/C5/C9 · `PLAN_02` + scale track |
| **Provenance** | batch/job-level only (`source_imports.raw_data`, `provider_calls`, `enrichment_job_rows.enriched_fields`) | per-field `{source, confidence, updated_at}` (U1) + per-edge lineage (U2) + reconciliation (U3) + overlay survivorship (U4) | C6 · `PLAN_03` |
| **Tenancy / isolation** | FORCE-RLS overlay, fail-closed GUC, two-tenant itest (`rls/contacts.sql`, `client.ts`) | unchanged for the overlay; Layer 0 system-owned by access path (projection boundary) | C7/C8 · `PLAN_04` |
| **Search / read** | per-workspace Typesense over the overlay | global masked OpenSearch index + ClickHouse facets, Postgres-truth → CDC; permissions re-checked at read | C9 · `PLAN_05` (design) + scale track (build) |
| **Freshness / lifecycle** | one `last_verified_at`, no `freshness_status`, no re-enrichment loop (`contacts.ts:135`) | per-channel freshness + decay + job-change re-resolution + propagation without breaking owner views | C4 · `PLAN_06` |
| **Migration / backfill** | millions of live overlay rows with `account_id`, no `master_*_id` | one-time/lazy backfill resolving each overlay row to a master without prematurely collapsing per-workspace `accounts` | C8 · `RESEARCH_07`→`PLAN` (Open Q §11.5) |

---

## 5. Target schema

> This section freezes the **binding shape** every PLAN builds toward — tables, key columns, FKs, unique
> constraints, indexes. The **full DDL** is `03-database-design.md §5.1/§5.2` (READ + CITE there); the
> co-landed migration is `PLAN_01`+`PLAN_02`'s output (§7). The spine's *additions* to that DDL — the
> provenance seam (C6) and the re-point affordance (C4) — are flagged **[spine]** and finalized by
> `PLAN_03`/`PLAN_02` respectively.

### 5.1 The two-layer shape (ASCII ER)

```
  LAYER 0 — system-owned, NOT RLS-scoped (isolated by access path, C7)
  ┌──────────────────┐   master_company_id    ┌────────────────────┐
  │ master_persons   │◄───────────(denorm)────│ master_companies   │
  │  id (v7)         │  current_company_id     │  id (v7)           │
  │  linkedin_pub_id*│                         │  primary_domain*   │  *=UNIQUE key
  │  current_company │                         │  alt_domains[]     │
  └───────┬──────────┘                         │  name_normalized   │
          │ 1                                   │  parent_company_id─┐ (self-FK)
          │           ┌─────────────────────┐   └────────┬──────────┘
          │ N         │  master_employment  │            │ N
          └──────────►│ person_id ─┐  edge   │◄───────────┘
                      │ company_id ┘ THE LINK │   UNIQUE(person,company,started_on)
                      │ is_current,start/end  │   partial idx WHERE is_current
                      └──────────────────────┘
   master_emails / master_phones ── N:1 → master_persons (email_blind_index UNIQUE = GLOBAL dedup/DSAR)
   source_records (immutable evidence) ──► match_links (cluster_id, is_duplicate_of) ── the C4 cascade source
  ─────────────────────────────────────────────────────────────────────────────────────────────
  LAYER 1 — per-workspace overlay, FORCE-RLS (workspace_id, C8)
  ┌──────────────┐ master_person_id (nullable, C8)   ┌──────────────┐ master_company_id (nullable)
  │  contacts    │──────────────────────────────────►│  master_*    │◄──── accounts ──────────────►│ Layer 0
  │ account_id ──┼──► accounts (legacy direct link, retained during migration §11.5)
  │ field_prov   │ [spine] reserved provenance seam (C6) — additive, PLAN_03 finalizes
  └──────────────┘
```

### 5.2 Layer-0 tables (key columns / keys / indexes)

| Table | PK | Key columns | Unique / FK | Index |
|---|---|---|---|---|
| `master_companies` | `id` v7 | `primary_domain`, `alt_domains[]`, `name`, `name_normalized`, `parent_company_id`, firmographics, `data_quality_score` | `primary_domain` **UNIQUE**, `linkedin_company_id` **UNIQUE**, `parent_company_id`→self | GIN trgm on `name_normalized` (`03:390-407`) |
| `master_persons` | `id` v7 | `linkedin_public_id`, names, `current_company_id`, title/seniority/dept, `has_email`/`has_phone` facets, `is_suppressed`, `data_quality_score` | `linkedin_public_id` **UNIQUE**, `current_company_id`→`master_companies` | GIN trgm on `full_name`, idx on `current_company_id` (`03:409-426`) |
| **`master_employment`** | `id` v7 | `master_person_id`, `master_company_id`, `title`, `department`, `seniority_level`, `is_current`, `started_on`, `ended_on` | **`UNIQUE(master_person_id, master_company_id, started_on)`**; both FKs `ON DELETE CASCADE` | partial `idx_employment_current … WHERE is_current` (`03:428-436`) |
| `master_emails` | `id` v7 | `email_enc`, `email_blind_index`, `email_domain`, `email_status`, `source_count`, `last_verified_at`, `verification_source`, `is_primary` | `email_blind_index` **UNIQUE** (GLOBAL dedup + DSAR/suppression lookup); `master_person_id`→cascade (`03:438-449`) | — |
| `master_phones` | `id` v7 | `phone_enc`, `phone_blind_index`, `line_type`, `phone_status`, `source_count` | `phone_blind_index` **UNIQUE**; `master_person_id`→cascade (`03:451-459`) | — |
| `source_records` | `id` v7 | `source_name`, `content_hash`, `raw_data`, `match_keys`, `resolved_person_id`, `resolved_company_id`, `lawful_basis_snapshot`, `ingested_at` | `content_hash` **UNIQUE** (idempotent ingest); `resolved_*`→master | range-partition by `ingested_at` (month) (`03:461-471`) |
| `match_links` | `id` v7 | `entity_type`, `cluster_id`, `source_record_id`, `match_probability`, `match_method`, **`is_duplicate_of`**, `review_status` | `source_record_id`→cascade; `review_status` stays `'auto'` at MVP | `idx_match_links_cluster (entity_type, cluster_id)` (`03:473-485`) |

**Spine note on `match_links` at MVP:** the **only** field of `match_links` the MVP exercises is the
`cluster_id`/`is_duplicate_of` pair — it is the **source of the C4 re-point cascade**. `match_probability`,
`match_method='splink'`, and `review_status≠'auto'` are scale-track (C9). The MVP writes
`match_method='deterministic'`, `review_status='auto'` only.

### 5.3 Layer-1 overlay additions (binding)

| Table | Added column | Type / rule | Constraint |
|---|---|---|---|
| `accounts` | `master_company_id` | `uuid REFERENCES master_companies(id)` — **nullable** (C8) | partial `idx_accounts_master … WHERE master_company_id IS NOT NULL` (`03:495,511`) |
| `contacts` | `master_person_id` | `uuid REFERENCES master_persons(id)` — **nullable** (C8) | partial `idx_contacts_master … WHERE master_person_id IS NOT NULL` (`03:518,556`) |
| `contacts`/`accounts` | **[spine] provenance seam** | a reserved per-field `{source, confidence, updated_at}` structure (single JSONB `field_provenance` vs side table — Open Q §11.3) | additive; `PLAN_03` finalizes — never a later destructive backfill (C6) |

**Retained, unchanged:** the three per-workspace dedup uniques on `contacts`
(`(workspace_id, email_blind_index)` / `linkedin_public_id` / `sales_nav_lead_id`,
`contacts.ts:156-164`), the `(workspace_id, domain)` account unique (`contacts.ts:72-74`), the reveal
CHECK invariants (`contacts.ts:182-186`), and `account_id` itself — kept as the legacy direct link
through the migration window (§11.5), *not* dropped on day one.

---

## 6. RLS policy implications

The overall boundary is **two isolation regimes that must not bleed into each other** (C7/C8):

1. **Layer 1 (overlay) — unchanged FORCE-RLS.** `master_person_id`/`master_company_id` are **just two
   more columns on an already-RLS-scoped table** — they introduce **no** new RLS surface. The existing
   `*_workspace_isolation` policy keyed on `workspace_id = NULLIF(current_setting('app.current_workspace_id',
   true), '')::uuid` (`rls/contacts.sql:20-22,31-33,42-44`) still governs every read/write; a workspace
   reading a `master_person_id` value is fine because the value is **just a pointer**, not the master row.
   The two-tenant isolation itest (`list-plan/02-data-model.md:48-65`) is **extended**, not relaxed, to
   assert that adding the back-ref column does not let workspace A read workspace B's overlay rows.

2. **Layer 0 (master graph) — NOT a workspace RLS predicate; isolation by access path.** There is no
   `workspace_id` on `master_*` to key a policy on — a workspace does not *own* a master row. Isolation is
   **structural**: the `leadwolf_app` role gets **no direct `SELECT`** on `master_*`; reads happen only
   through (a) the **masked search** projection (candidate IDs + non-PII facets; `master_emails`/`phones`
   are *never* returned by search — `03-database-design.md:383-384`), and (b) the **paid-reveal** path,
   which runs in a privileged tx that copies a single channel value into the calling workspace's overlay.
   This is **C7's central tension made concrete** and is **resolved in code by `PLAN_04`** (the projection
   boundary) — *this PLAN forbids any interim shortcut that grants `leadwolf_app` a direct Layer-0 read.*

3. **Where Layer 0 physically lives (Open Q §11.4) shapes the RLS story.** Same Aurora instance + a
   separate non-RLS schema owned by a non-`leadwolf_app` role, vs a separate database — either keeps the
   master graph out of the overlay's RLS path; the choice is a `PLAN_04` input, but **the constraint is
   fixed here**: Layer 0 must be *unreachable* by the overlay's app role except through the projection.

4. **DSAR / deletion cascade (the unit of deletion is the golden identity).** A data subject is found by
   the **one** `master_emails.email_blind_index` (GLOBAL unique, `03:442`); erasure is the audited
   platform fan-out (`withPrivilegedTx`, `client.ts:30-35`): tombstone the master identity, cascade
   `master_employment`/`master_emails`/`master_phones` (FK `ON DELETE CASCADE`, `03:430-459`), insert a
   GLOBAL-scope suppression row (blocks re-import), then cascade **golden → source_records → every overlay
   copy** with a verification scan (ADR-0021:129-131; `RESEARCH_00 §1`/CLAUDE.md deletion). The overlay's
   own `deleted_at` tombstone + null-PII path (`contacts.ts:147`) is the Layer-1 leg. **Provenance (C6)
   makes DSAR *more* provable** — per-field source lets a deletion prove *which* source a purged value
   came from.

---

## 7. Phase dependency order (one-line rationale per edge)

> Reproduces `BRAINSTORM_00 §5.2` as the **binding** build order. Note the deliberate split from the
> *corpus numbering*: research is done `01 entities → 02 link → …`, but Phase 1+2 **co-land as one
> migration** because the edge FKs the entities (you cannot release `master_persons` and the edge that
> references it in separate steps without a broken intermediate — `BRAINSTORM_00 §1 fact #1`).

```
  [design] provenance seam (C6) ─┐
  [design] projection boundary (C7) ─┴─► constrains ─► PHASE 1+2 (CO-LAND, one migration)
                                                       entity TABLES ⊕ employment EDGE ⊕ overlay master_*_id
                                                              │ unblocks
                                                              ▼
                                                       PHASE 3  field/edge provenance + overlay↔master reconciliation (U1–U4)
                                                              │ then
                                                              ▼
                                                       PHASE 2' match-first wiring (masterGraphMatcher STAYS stub; import mints/links deterministically)
                                                              │ then
                                                              ▼
                                                       PHASE 4  projection boundary BUILT (system-owned Layer-0 ↔ FORCE-RLS overlay; masked search + paid-reveal copy)
                                                              │ then
                                                              ▼
                                                       PHASE 5/6  read path + search/cache · freshness + re-enrichment + job-change
                                                              │ then (gated)
                                                              ▼
                                                       SCALE TRACK  Splink tail + Citus/OpenSearch/ClickHouse/Iceberg ⇒ ER merges duplicates ⇒ C4 cascade fires
```

| Edge | One-line rationale |
|---|---|
| provenance-seam **design** → schema freeze | the seam constrains *every* column; designing it after the freeze is a destructive backfill (C6; `BRAINSTORM_00 §2.C`). |
| projection-boundary **design** → schema freeze | the access path decides which `master_*` columns are revealable and where Layer 0 lives — a freeze input (C7; Open Q §11.4). |
| schema freeze (Phase 1+2 co-land) → Phase 3 (provenance build) | a merge engine needs real entities + edges to merge and conflicts to arbitrate (`BRAINSTORM_00 §2.C` failure mode). |
| Phase 1+2 → Phase 2' (match-first wiring) | the import path can only set `master_*_id` once the columns + tables exist; promotion of `masterGraphMatcher` stays stubbed (C9). |
| Phase 3 → Phase 4 (projection build) | reveal copies a master value into the overlay — the per-field reconciliation (U3) must exist before that copy can be correct. |
| Phase 4 → Phase 5/6 (read path / freshness) | you optimize the read path + re-enrichment loop only after the masked-search/reveal projection is real. |
| Phase 5/6 → scale track | the deferred ER merges the deterministic duplicates → the C4 re-point cascade fires; gated by Open Q §11.6. |

---

## 8. Required-by-every-PLAN checklist (+ the pre-build pass)

Every downstream PLAN gate (`PLAN_01`…`PLAN_06`) **must** contain these five sections and answer the
pre-build items that apply. This PLAN runs them at the spine level below (§9–§11); each phase re-runs
them at its own grain.

| Required section | What it must establish |
|---|---|
| **Target schema** | tables, key columns, FKs, unique constraints, indexes — citing `03 §5.x` and flagging any **[spine]** addition. |
| **RLS policy implications** | which regime (overlay FORCE-RLS vs Layer-0 access-path, §6); proves no new cross-workspace read; extends the two-tenant itest (C8). |
| **Scale-gate analysis** | the *what-breaks-first-at-10x* answer + the fix; rows-returned bound, pagination, N+1, async write (§9). |
| **Failure modes** | the idempotency key / dedup constraint, the mint-then-merge debt it touches (C4), and the rollback flag (§10). |
| **Open questions** | what it inherits unresolved from §11 + what it newly opens. |

**Pre-build thinking pass (the items that bind this spine — `truepoint-architecture`):**

1. **Source of truth.** Postgres golden (Layer 0) is truth; overlay is a curated copy; search is a
   derived surface (C1; `03:698`). The initiative **inverts** today's overlay-is-truth (`RESEARCH_00 §8.1`).
2. **Failure modes / idempotency.** Resolution is idempotent on `source_records.content_hash` (UNIQUE,
   `03:464`) + the per-workspace blind-index uniques (`contacts.ts:156-164`); mint-then-merge is the
   accepted non-idempotency of *identity* that C4's cascade repairs.
3. **Duplicate prevention.** Layer-0 global uniques (`primary_domain`, `linkedin_public_id`,
   `email_blind_index`); MVP **tolerates** deterministic duplicate masters (no exact-key overlap) and
   defers their collapse to the scale-track ER (C4/C9; Open Q §11.2).
4. **Audit / change history (same-tx).** Reveal/import/list mutations audit through `audit_log`;
   `source_records` is master lineage; **per-field change history is the C6 invention** — today you
   cannot answer "when did this title change and from what" (`RESEARCH_00 §8.3`).
5. **Security (IDOR / isolation / field exposure / secrets).** FORCE-RLS overlay (C8); Layer 0 by access
   path only, `master_emails`/`phones` never in search (C7; §6); the `master_person_id` the client sees
   is an opaque pointer, never a Layer-0 read grant.
6. **Scalability (rows / pagination / N+1 / 10x / async).** Denormalize person+company for "person at
   company with company traits" (the degenerate `account_id` forces a join today — `RESEARCH_00 §8.5`);
   `current_company_id` + flattened search docs; cursor pagination; bulk resolution is a JOB (§9).
7. **Observability.** Resolution emits matched/minted/merged counts; the C4 re-point cascade is a
   monitored sweep with a runbook; mint-then-merge duplicate rate is a tracked metric (Open Q §11.2/§11.6).
8. **Rollback.** Additive migration (new tables + nullable columns) → reversible; the import-path
   MATCH-AGAINST is flag-gated so a bad resolver can be turned off without orphaning overlays.
9. **Edge cases.** Domainless company (`account_id NULL` today, no master mint key → name-fallback);
   contact with no email (LinkedIn/sales-nav keys); job change (today silent overwrite → edge `ended_on`
   + new `is_current` row, C2); concurrent enrichment (DB uniques prevent double-insert, `RESEARCH_00 §8`).
10. **Assumptions (load-bearing).** (a) deterministic keys resolve the easy majority; (b) the duplicate
    tail is tolerable pre-ER and merge-repairable; (c) the existing single-Aurora stack carries the MVP
    edge+provenance load; (d) `matchKeys.ts` is the *only* normalizer (C5).
11. **Misuse.** A workspace must not infer Layer-0 membership from a search miss/hit beyond masked facets
    (C7); CONTRIBUTE-TO stays off so no workspace leaks its imports to others (C3).
12. **Load behaviour (10x).** First bottleneck = the bulk MATCH-AGAINST write path + the search index, not
    the OLTP overlay → §9.
13. **Worst case.** Deterministic-only mints a large duplicate population that the deferred ER must merge,
    firing a large re-point cascade → contained by C4 (mutable pointer + monitored async sweep), bounded
    by the Open Q §11.2 tolerated-duplicate-rate budget.

---

## 9. Scale-gate analysis (what breaks first at 10x — and the fix)

Scale target: **millions of users, billions of prospect/company rows** (CLAUDE.md). The MVP runs on the
existing single-Aurora + Typesense stack (C9), so the gate question is *which part of the IN-scope build
breaks first as the universe 10x's*, and whether the fix is the **already-deferred** scale track.

| What breaks first | Why | The fix (and is it already deferred?) |
|---|---|---|
| **The bulk MATCH-AGAINST write path** | every imported row resolves against the global graph; deterministic-only is index lookups, but at billions the candidate-generation join is O(n²) without blocking | **Deferred — C9.** Blocking + MinHash/LSH + Splink-on-Spark is the scale track (ADR-0021:67-70). MVP relies on deterministic index hits + bounded mint. |
| **The global masked search index** | Typesense is excellent to ~100M but a billions-row shared index with deep facets exceeds its envelope (ADR-0021:96) | **Deferred — C9.** OpenSearch (sharded inverted index, `search_after`) + ClickHouse facet counts; Postgres-truth → CDC. `PLAN_05` designs the boundary; build is scale-track. |
| **The C4 re-point cascade volume** | the larger the deterministic duplicate population, the larger the merge-time re-point fan-out across overlay rows | **In-scope design.** Async monitored sweep, `match_links.is_duplicate_of`-driven, bounded by the Open Q §11.2 tolerated-duplicate budget; never synchronous on the merge tx. |
| **Golden OLTP single-writer** | `master_*` on one Aurora writer caps write throughput as the universe grows | **Deferred — C9.** Citus shard of the golden store past single-writer limits (ADR-0021:76-77). |
| **"Person at company with company traits" reads** | the degenerate `account_id` link forces a join today (`RESEARCH_00 §8.5`) | **In-scope.** `master_persons.current_company_id` denormalizes the current edge (`03:413`); flatten person+company in the search doc; no N+1. |
| **`source_records` write volume** | immutable per-source evidence at billions is a high-cardinality append | **In-scope partition + deferred lake.** Range-partition by `ingested_at`/month (`03:470`); bulk to S3+Iceberg is scale-track (C9). |

**Verdict:** every first-breakage is *either* an in-scope denormalization/partition we apply now *or* a
component the brainstorm **already deferred** behind the C9 gate. The MVP edge + provenance design
delivers value on the single-Aurora stack first; the scale track is the tail, not a hidden MVP gate.

---

## 10. Failure modes

> Cross-initiative failure modes the spine owns; each PLAN re-states the ones it touches.

- **F1 — Deterministic-only mints duplicate masters (the A-killer).** Two source rows for one human with
  no shared exact key each mint a fresh `master_persons`; overlays point at soon-to-merge losers
  (`BRAINSTORM_00 §2.A`). **Mitigation (C4):** `master_*_id` is a mutable pointer; the
  `match_links.is_duplicate_of` re-point cascade is designed day one and fires when the deferred ER
  merges. **Without C4 this corrupts silently** — it is the constraint that makes Framing A safe.
- **F2 — Nullable back-ref silently becomes steady-state.** ADR-0021 reserves nullability for in-flight
  staging only (ADR-0021:63-65), but the import path admits the gap (`runImport.ts:230-241`). **Mitigation
  (C8):** an import-path MATCH-AGAINST assertion + a backfill + observability on the unresolved-row rate,
  never a NOT NULL that breaks the staging window.
- **F3 — A Layer-0 read leaks past the projection.** Granting `leadwolf_app` any direct `master_*` read
  to "make integration easier" breaks C7 and exposes the un-masked universe to every workspace.
  **Mitigation (C7/§6):** structural — no direct grant; reads only via masked search + privileged reveal;
  the two-tenant itest is extended to assert it.
- **F4 — Premature collapse of per-workspace `accounts` into shared `master_companies`.** The migration
  backfill could over-merge distinct workspace company rows when reconciling to one golden company
  (Open Q §11.5). **Mitigation:** backfill *links* (sets `master_company_id`) without *merging* overlay
  rows; the overlay's `(workspace_id, domain)` uniqueness is unchanged.
- **F5 — Provenance retrofit becomes a destructive backfill.** If the seam is not reserved at freeze,
  `PLAN_03` must rewrite live `contacts`/`accounts` rows. **Mitigation (C6):** reserve the seam column at
  the Phase 1+2 freeze; `PLAN_03` is purely additive.
- **F6 — Bulk-vs-batch normalizer drift.** A second normalizer for the bulk path diverges from
  `matchKeys.ts`, producing inconsistent keys (ADR-0037:75-81). **Mitigation (C5):** single canonical
  `matchKeys.ts`; no parallel normalizer — enforced by ADR-0037.
- **F7 — Erosion of the isolation gate for convenience.** Any relaxation of FORCE-RLS or the two-tenant
  itest to ease Layer-0 integration. **Mitigation (C8):** security has final say (CLAUDE.md precedence);
  structure rules never override the isolation correctness rule.

---

## 11. Open questions (carried into the PLANs)

> The *known* costs of deferring ER (C9) + the freeze inputs each downstream PLAN must resolve. Verbatim
> spine of `BRAINSTORM_00 §6`, assigned to owners.

1. **Mint-then-merge cluster stability (F1; `PLAN_02`).** Is `master_*_id` a mutable pointer with a
   `match_links`-driven re-point cascade (chosen lean, C4), or a stable surrogate + an indirection table?
   What is the acceptable churn rate; does the re-point fire synchronously or as an async sweep
   (`RESEARCH_06` propagation)? *The question that makes or breaks Framing A.*
2. **Tolerated pre-ER duplicate rate (`PLAN_02` + `truepoint-operations`).** With `masterGraphMatcher`
   stubbed and resolution deterministic-only, mint-then-merge inflates Layer-0 duplication until ER runs.
   What is the **ratified** tolerated duplicate rate in `master_persons`/`master_companies`, and what
   metric tracks it?
3. **Provenance seam — minimal reservation (C6; `PLAN_03`).** A single JSONB `field_provenance` column
   (the `RESEARCH_03`/`05` "materialize on write" shape) vs a side table — the *minimum* reservation that
   keeps `PLAN_03` additive without pre-committing the merge design.
4. **Where Layer 0 physically lives pre-scale (C7; `PLAN_04`).** Same Aurora instance + a separate
   non-RLS schema and non-`leadwolf_app` role, or a separate database from day one? Shapes the projection
   boundary and the migration path to Citus; the first place the "shared canonical infra under default-RLS"
   tension becomes concrete (`RESEARCH_00 §6`).
5. **Backfill of the existing overlay (F4; `RESEARCH_07`→`PLAN`).** Millions of live `contacts`/`accounts`
   rows have `account_id` and no `master_*_id` — one-time batch, lazy-on-read, or on-next-touch? How does
   per-workspace `accounts` (`(workspace_id, domain)`) reconcile into shared `master_companies` **without
   collapsing distinct workspace records prematurely**?
6. **The scale-track trigger (C9; `truepoint-operations`).** What concrete signal promotes the deferred ER
   + topology from gated to active — a `master_*` row-count threshold, a measured duplicate/false-merge
   complaint rate, or the fixed M12/M13 milestone — and who owns that call (the FinOps/scale gate)?

---

> **Spine status.** This document is the frozen Phase-0 constraints + scope for the prospect↔company data
> initiative. It traces to the brainstorm **DECISION** (`BRAINSTORM_00 §5`, Framing A refined) and the
> research **RECOMMENDATION** (`RESEARCH_00 §9`, edge-first/provenance-as-invention/defer-scale). Every
> downstream PLAN cites C1–C10 verbatim, satisfies the §8 checklist, and resolves its share of §11.
