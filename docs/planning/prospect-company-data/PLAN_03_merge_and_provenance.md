# Phase 3 — Multi-Source Merge & Field-Level Provenance: PLAN

> **Gate: PLAN.** Phase 3 of the prospect↔company data initiative — the **field-level provenance + multi-source
> merge engine** (the U1 gap; the seam `PLAN_00` C6 reserved). This gate freezes the concrete `field_provenance`
> JSONB descriptor (shape, closed key set), the column on **both** layers, the per-(source,field) trust config,
> the deterministic per-field **survivorship cascade** + its confidence/thresholds, the per-entity re-projection
> (trigger / single-flight / idempotency), the two-layer **pin** (human-correction precedence) + the overlay merge
> algorithm, reversibility (unmerge + replay-as-of), the human-review path, and how provenance feeds the Phase-2
> edge confidence and the Phase-6 `data_quality_score`/two-clock freshness. **Converts:**
> `BRAINSTORM_03_merge_options.md §4` (the DECISION — *Substrate **C**, a materialized JSONB winning-descriptor map
> on both layers, fed by a per-entity-re-projected cascade over the `source_records` crosswalk; retain the
> normalized `master_emails`/`master_phones` channels as the scoped instance of B; reject A and reject B as a
> general ledger*) and `RESEARCH_03_mdm_merge.md §Recommendation` (the RECOMMENDATION — *crosswalk-plus-materialized-map,
> per-field cascade not LWW, pin on both layers, reversible-by-replay*). It answers the seven `BRAINSTORM_03 §4`
> open questions (OQ1–OQ7) inline and re-lists them in **Open questions**. **Depends on / cites:**
> `PLAN_00_constraints_and_scope.md` (C1–C10; the provenance seam §5.3), `PLAN_02_affiliation_edge.md` (the edge's
> thin cache columns this engine populates), the planned DDL (`03-database-design.md:386-557`),
> ADR-0021/0015/0025/0035, `dataHealth.ts:44,55-77,130-138`, `matchKeys.ts:74-81`, `dedup.ts:60-69`,
> `waterfall.ts:50-60`, `client.ts:30,48-68,95-111`, `RESEARCH_06_freshness.md §1`. **No code, schema, SQL, or
> settings are modified by this gate — only this file is written; the DDL below is the Phase-3 freeze, an additive
> migration onto the `PLAN_01`+`PLAN_02` co-land, not an applied change.**

---

## 0. Lineage — what this PLAN converts and freezes

`RESEARCH_03` surveyed Informatica/Reltio/Profisee/ZoomInfo/Clay/Splink and recommended *"a crosswalk-plus-materialized-map
provenance model — explicitly **not** a per-field row table and **not** derive-at-read"*: keep every candidate value
in the immutable `source_records` crosswalk, decide the winner **per field** by a trust × recency × corroboration
cascade, let a **human pin** override the algorithm, materialize the **winning descriptor** as a JSONB map on the row,
and make merges reversible by **replay** rather than a version table. `BRAINSTORM_03 §4` stress-tested three substrates
(A wide columns / B normalized ledger / C JSONB winner-map) against seven hard cases + five constraints and **decided
Substrate C**, resolving the RESEARCH_03↔BRAINSTORM_01 tension (it answers BRAINSTORM_01's OQ1: *the D-shaped normalized
ledger is warranted **only** for the genuinely multi-valued, separately-verified channels — where it already exists as
`master_emails`/`master_phones` — and **not** as a general per-field ledger*). This PLAN is the **paving** of that road.
It does four things:

1. **Freezes the provenance substrate** (Target schema) — the `field_provenance jsonb` descriptor (closed key set,
   short keys, no PII), the column on `master_persons`/`master_companies`/`master_employment` (system-owned) **and**
   `contacts`/`accounts` (overlay), the closed field namespace, the per-(source,field) trust config, and the
   channel-reference rule (OQ5).
2. **Freezes the merge engine** (§1) — the deterministic per-field cascade `(pinned) → highest-(source,field)-trust →
   most-recent-verified → most-corroborated → most-complete`, the field-confidence + thresholds, the bounded
   per-entity re-projection (OQ1/OQ2/OQ4), the two-layer pin + the exact overlay merge (OQ3/OQ7), and
   reversibility-by-replay (S4).
3. **Freezes the consumer handshakes** (§2) — populating `PLAN_02`'s edge cache columns from the cascade (the U2 seam,
   OQ6) and making `data_quality_score` per-field-aware across the two freshness clocks (Phase 6).
4. **Freezes the boundaries** — Layer-0 system-owned RLS posture (no workspace column, co-op-scrubbed source labels),
   scale-gate fixes, failure modes.

> **Trace, explicit.** Every schema/algorithm choice below names the `BRAINSTORM_03 §4` DECISION part (1–5) or
> `RESEARCH_03` recommendation point (1–5) it crystallizes, and each `BRAINSTORM_03 §4` open question (OQ1–OQ7) is
> resolved inline and re-listed in **Open questions**. Reuse is mandatory: the cascade reuses the shipped trust order
> (`waterfall.ts:50-60`) and `pickCanonical` tiebreaks (`dedup.ts:60-69`); the company key reuses `registrableDomain`
> (`matchKeys.ts:74-81`); the score reuses `dataHealth.ts`. No second normalizer (C5), no parallel review queue
> (`PLAN_00`/`PLAN_02` reuse rule).

---

## Target schema

The substrate is **one JSONB column holding only the winning descriptor per field**, on both layers (DECISION part 3).
Truth/lineage stays the immutable `source_records` crosswalk (`03:461-471`) + `match_links` (`03:473-485`) — the map is
a thin **materialized** pointer-and-decision cache, never the candidate set (RESEARCH_03 §B.3; the MV-Register retain-all
posture lives in `source_records`, §B.4). The history is the log; the map is the winner.

### 3.1 The descriptor — the winning-value tuple (closed, short-keyed, no PII)

One JSON object per provenance-worthy field. Keys are short (billions × ~15 fields → every byte is paid for; the map
must stay inline/small-TOAST, S1). The **master** descriptor and the **overlay** descriptor are the *same shape*, with
two scoping differences (C1/C2): the master may carry `wsr` (a `source_record_id` pointer); the overlay carries a
**platform-level** `src` label only and never `wsr` of a foreign source.

```jsonc
// master_persons.field_provenance["job_title"]  (system-owned)
{
  "wsr": "0c1e…",            // winning source_record_id (the candidate that won) — Layer-0 only; null for a pin
  "src": "zoominfo",          // platform-level source_name (apollo|zoominfo|clearbit|coop|public_registry|user_edit) — NEVER a workspace (C2)
  "mth": "deterministic_email", // match_method that produced the value (matchKeys ladder, matchKeys.ts:22-28)
  "conf": 0.91,               // field confidence ∈ [0,1] (§1.2)
  "obs": "2026-05-01",        // observed_at  (VALID-time: when the source asserts the fact held)  — Phase-6 Clock input
  "ing": "2026-05-02T09:11Z", // ingested_at  (TX-time: when we learned it)
  "ver": "2026-05-10T00:00Z", // last_verified_at (optional; set by a verification run) — Phase-6 freshness
  "n":   3,                   // source_count: # DISTINCT sources corroborating THIS winning value (recomputed, OQ1)
  "pin": false,               // is_pinned (human override; §1.4)
  "by":  null,                // pin actor (user_id | steward_id) — present iff pin=true
  "at":  null,                // pin timestamp — present iff pin=true
  "ctd": false               // _contested: ≥2 high-trust values disagree → steward worklist (§1.6); winner still serves reads
}
```

```jsonc
// contacts.field_provenance["email"]  (RLS-scoped overlay; platform-level label ONLY, never a workspace)
{ "src": "master:verified", "mth": "deterministic_email", "conf": 0.91, "obs": "2026-05-01", "ver": "…", "pin": false }
{ "src": "user_edit", "pin": true, "by": "8f2…", "at": "2026-06-20T14:02Z" }   // a hand-edit — blocks overwrite (§1.4)
```

> **Channel fields reference, never duplicate (OQ5).** For `email`/`phone` the descriptor's pointer is the channel row,
> not `wsr`: `{ "chan": "<master_emails.id>", "src":…, "conf":…, "ver":…, "pin":… }`. The channel row already holds
> `source_count`/`last_verified_at`/`verification_source`/`email_status` + `email_enc`+`email_blind_index`
> (`03:438-449`), so the PII value and its per-value verification lifecycle stay in the normalized channel table (the
> retained instance of B, §3.6) and the map never copies PII in clear — DSAR/erasure reach the value through the
> channel row's blind index (RLS §, F-rules).

The shape is **validated at the app edge** (a `FieldProvenanceDescriptor` Zod schema in `@leadwolf/types`), not by a DB
CHECK — the house pattern for typed JSONB (`contacts.custom_fields` is app-edge-validated, `contacts.ts:64-66,148-150`).
A DB JSON-schema CHECK on a billions-row hot column is rejected (write cost; rigidity).

### 3.2 `field_provenance` on the master rows (Layer 0) — DDL freeze

```sql
-- Additive onto the PLAN_01/PLAN_02 co-land. System-owned (no workspace_id — C1); one lean column per golden row.
ALTER TABLE master_persons    ADD COLUMN field_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE master_companies  ADD COLUMN field_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE master_employment ADD COLUMN field_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;  -- the edge's per-attribute provenance (OQ6)

-- Concurrency guard for the re-projection (§1.3): a monotonic high-water-mark of the cluster evidence the map
-- reflects, so a slow projector can never overwrite a fresher map with a staler one (last-deterministic-wins).
ALTER TABLE master_persons    ADD COLUMN prov_hwm timestamptz;   -- max(source_records.ingested_at) seen by the last projection
ALTER TABLE master_companies  ADD COLUMN prov_hwm timestamptz;
ALTER TABLE master_employment ADD COLUMN prov_hwm timestamptz;

-- Steward worklist ONLY (contested-field review, §1.6): tiny partial GIN over the rare contested rows, never a
-- blanket GIN on the whole map (a corpus-wide GIN at billions is the rejected write/storage cost, S1).
CREATE INDEX idx_master_persons_contested  ON master_persons  USING gin (field_provenance)
  WHERE field_provenance @> '{"_any_contested": true}'::jsonb;   -- a top-level rollup flag set by the projector
CREATE INDEX idx_master_companies_contested ON master_companies USING gin (field_provenance)
  WHERE field_provenance @> '{"_any_contested": true}'::jsonb;
```

`_any_contested` is a single top-level boolean the projector sets when any descriptor has `ctd:true`, so the steward
worklist is a cheap partial-index scan, not a per-key GIN probe. The **search/read path never touches the map** — the
OpenSearch/ClickHouse projection indexes the materialized scalar OV columns (`job_title`, `current_company_id`, the
`has_email` facet, …) the map *decided*, satisfying C4 (no join, no recompute on read) (DECISION part 3; ADR-0035).

### 3.3 `field_provenance` on the overlay rows (Layer 1) — DDL freeze (finalizes the `PLAN_00` C6 seam)

```sql
-- The reserved provenance seam (PLAN_00 §5.3 [spine]) — now FINALIZED as the same JSONB shape, RLS-scoped.
ALTER TABLE contacts ADD COLUMN field_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE accounts ADD COLUMN field_provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
```

These are **just two more columns on an already-FORCE-RLS table** (C8) — no new RLS surface (RLS §). The overlay map is
where the **overlay pin** lives (§1.4) and where the reveal snapshot's non-PII descriptor is copied (platform-label only,
C2). Additive, nullable-by-default-`{}`, reversible — the destructive-backfill failure `PLAN_00` F5 forbids is avoided
because the seam was reserved at the Phase-1+2 freeze (C6).

### 3.4 The provenance field namespace (a closed vocabulary, zero drift)

Map keys are a **closed set** mirroring the existing golden columns 1:1, defined once in `@leadwolf/types`
(`provenanceFields.ts`) and validated at the app edge — so a key can never drift from a real column (the ADR-0037
single-canonical-source discipline, C5). Per entity:

| Entity | Provenance-worthy keys |
|---|---|
| `master_persons` | `full_name, first_name, last_name, job_title, seniority_level, department, location_country, location_city, email, phone` (email/phone = channel references, §3.1) |
| `master_companies` | `name, name_normalized, industry, sub_industry, employee_count, employee_band, revenue_range, technographics, hq_country, hq_city, founded_year` |
| `master_employment` | `edge` (existence/`is_current` — the edge's own confidence, §2.1), `title, department, seniority_level, started_on, ended_on` |

`current_company_id` is **not** a provenance key — it is a *derived cache* of the highest-confidence `is_current`
edge (`PLAN_02 §2.2`), so its provenance is the `edge` descriptor on `master_employment`, never an independently
survivorship-merged field.

### 3.5 `source_field_trust` — per-(source, field) trust (config-in-code canonical + an override seam)

RESEARCH_03 §A.1's load-bearing finding: trust is **per-(source, field)**, not a single global source rank — a
provider authoritative for `job_title` may be weak for `mobile_phone`. The canonical trust table is a **versioned
config in code** (`@leadwolf/core/enrichment/sourceTrust.ts`, mirroring `PLAN_02`'s freemail list) — deterministic,
reviewed, no drift. A small **system-owned** override table lets ops re-tune without a deploy:

```sql
CREATE TABLE source_field_trust (                 -- system-owned config (NO workspace_id, NO RLS); tiny (~sources×fields)
  source_name   varchar(50) NOT NULL,             -- apollo|zoominfo|clearbit|coop|public_registry|user_edit
  field_name    varchar(50) NOT NULL,             -- a key from the §3.4 closed namespace
  base_trust    numeric(4,3) NOT NULL CHECK (base_trust BETWEEN 0 AND 1),
  decay_sla_days int,                             -- per-(source,field) recency SLA; NULL → field default (dataHealth FRESHNESS_SLA_DAYS)
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_name, field_name)
);
```

`effective_trust(source, field) = COALESCE(override.base_trust, code_default(source, field), tier_default(source))`.
`user_edit` is **not** in this table — a human pin sits *above* the trust tier entirely (§1.4). Changes are audited
(an override is written via `withPlatformTx`, `client.ts:95-111`).

### 3.6 Channels stay normalized — the retained scoped instance of B (OQ1 resolution)

`master_emails`/`master_phones` are **kept exactly as designed** (`03:438-459`) — one row per `(person, channel-value)`
with `source_count`/`last_verified_at`/`verification_source`/`email_status`/`email_blind_index`. This is the *genuinely
multi-valued, separately-encrypted/verified* domain where a normalized table earns its cost (BRAINSTORM_03 §3.3). The
JSONB map's `email`/`phone` descriptor **references the winning channel row** (§3.1, OQ5); no general `field_assertion`
ledger is built for scalar fields (DECISION "Where B is retained"). This is the **deliberate sharpening of
BRAINSTORM_01 §4.3's OQ1**: D-shape for channels (exists), C-shape descriptor + bounded re-projection for everything else.

### ER sketch (truth → projection → overlay snapshot)

```
  source_records (immutable crosswalk; content_hash UNIQUE → idempotent; range-part by ingested_at; cold S3/Iceberg, 03:464,470)
     │   per field-contributing source = one row (DECISION part 1; 06 §4:135-143)
     ▼
  match_links (accepted/clustered assertions; is_duplicate_of survivor link; review_status, 03:473-485)
     │   ── cluster = the entity's candidate set (BOUNDED by ER blocking/LSH; the S2 insight)
     ▼  PER-ENTITY survivorship cascade (§1) — pure deterministic fn, run on new evidence / unmerge, materialized:
  master_persons / master_companies / master_employment
     ├─ scalar golden columns (job_title, name, is_current …)           ← the materialized winner (search/read surface)
     ├─ field_provenance jsonb { field → winning descriptor }            ← the per-field "where from / how / when" (this PLAN)
     └─ data_quality_score (recomputed from the map, §2.2; Clock A)
     │   ── reveal copies a POINT-IN-TIME value + its NON-PII descriptor (platform label scrubbed, C2) ──▼
  contacts / accounts (FORCE-RLS overlay)
     ├─ scalar copies (frozen at reveal; owner-stable)
     ├─ field_provenance jsonb { field → {platform-src, conf, obs} | user_edit pin }   ← overlay map; the OVERLAY PIN (§1.4)
     └─ data_quality_score / freshness_status (Clock B — the frozen snapshot's age, §2.2)
```

---

## 1. Survivorship — the per-field cascade (the merge engine)

### 1.1 The cascade order + the per-value algorithm

The golden value of each field is **not LWW** and **not whole-record overwrite** (the CRDT lost-update anti-pattern,
RESEARCH_03 §B.4) — it is the named deterministic cascade (DECISION part 2; ADR-0015:70-75; `06 §9:315-316`):

```
  (1) HUMAN-PINNED        → if a pinned descriptor exists, its value wins outright (survivorship skipped — the Reltio pin, §A.2/§B.2)
  (2) highest (source,field) TRUST   → effective_trust(source, field) (§3.5; reuse waterfall trust order, waterfall.ts:50-60)
  (3) most-RECENT verified           → max(ver, obs)  (the freshness guard — a stale value never beats a fresh corroborated one)
  (4) most-CORROBORATED              → n = COUNT(DISTINCT source_name) supporting the value (Reltio "frequency"; the source_count input)
  (5) most-COMPLETE / lowest id      → non-null/non-empty, then lowest source_record id (reuse pickCanonical tiebreak, dedup.ts:60-69 → idempotent)
```

The algorithm operates on **distinct values**, not distinct source_records (corroboration is "how many sources *agree*"):

```
project_field(cluster, field):
  if pinned(field): return pin_descriptor                         # tier (1) — short-circuit
  cands  = [ extract(field, sr) for sr in cluster.source_records if has(field, sr) ]   # bounded by cluster size (S2)
  groups = group_by(normalize(value), cands)                      # one group per distinct value
  for g in groups:
     g.trust = max(effective_trust(sr.source_name, field) for sr in g)
     g.recent = max(coalesce(sr.last_verified_at, sr.observed_at) for sr in g)
     g.n      = count(distinct sr.source_name for sr in g)
     g.win_sr = argmax_trust_then_recent(g)                       # the highest-trust supporter → wsr
  winner = lexicographic_argmax(groups, by=(trust, recent, n, complete, -win_sr.id))
  return descriptor(wsr=winner.win_sr.id, src=winner.win_sr.source_name, mth=…, conf=field_confidence(winner),
                    obs=…, ing=…, ver=…, n=winner.n, pin=false, ctd=is_contested(groups))
```

It is a **pure function of the cluster's `source_records`** → re-runs converge (idempotent on `content_hash`,
`03:464`); the read path never runs it (it reads the materialized map/columns, C4).

### 1.2 Field confidence + thresholds

Two **distinct** confidence notions, deliberately not conflated:

- **Edge-existence confidence** (the `edge` descriptor on `master_employment`, §2.1) = the `match_method` prior /
  Fellegi-Sunter probability: `deterministic_email`/`deterministic_linkedin` ≈ 0.97–0.99, `deterministic_phone`/
  `deterministic_domain` ≈ 0.95–0.97, `fuzzy_name_company` = the Splink `match_probability` (`03:478`) — gray-zone
  routes to `match_links.review_status='pending'` and **no edge materializes** (`PLAN_02 §1.4`). This is the **gate**
  (the ≥0.95 precision / ≤0.5% false-merge target, `22:152-153`) — **reused, not redesigned**.
- **Scalar-field confidence** (`conf` in a descriptor) — a derived per-value score, NOT a merge gate (the cascade
  always yields a deterministic winner so reads never block):
  `conf = clamp01( effective_trust(src,field) × recency_factor(age, sla) × corroboration_boost(n) )`, where
  `recency_factor = freshnessSubScore(age, sla)` (reuse `dataHealth.ts:44`) and
  `corroboration_boost(n) = min(1.15, 1 + 0.05·(n−1))` (mild, capped). **Calibration of the exact constants is
  deferred** (Open Q; like ADR-0025 SLAs, re-tune from measured precision).

Two thresholds govern *promotion* and *review* (config, not gate):

| Threshold | Default | Effect |
|---|---|---|
| `PROMOTE_FLOOR` | 0.30 | a winner below the floor is **held candidate-only** — the golden scalar column keeps its last-good/null value, so one junk fuzzy source can't set a golden title (the survivorship-floor guard). |
| `CONTEST_DELTA` | 0.10 | if the top-2 distinct values **both** clear a HIGH trust and their `conf` is within `CONTEST_DELTA` → set `ctd:true` + the row's `_any_contested` rollup → steward worklist (§1.6). The cascade winner still serves reads. |

### 1.3 The per-entity re-projection — trigger, single-flight, idempotency (OQ1/OQ2/OQ4)

Survivorship runs **on new evidence / unmerge only, over one entity's bounded cluster** — never on read, never over the
corpus (the S2 insight: clusters are kept small by ER blocking/LSH, so per-entity re-projection is bounded and cheap,
BRAINSTORM_03 §2). The mechanism (OQ2):

```
  on INSERT source_records (resolved_*_id set by ER)  ── same tx ──►  INSERT projection_outbox(entity_type, entity_id, content_hash)
  on match_links split/merge (unmerge)                ── same tx ──►  INSERT projection_outbox(...) for BOTH resulting clusters
  on verification tick (Phase 6)                       ── batched ──►  INSERT projection_outbox(...) for the re-verified entities
                                                                          │
                                BullMQ worker (apps/workers), keyed by entity_id, SINGLE-FLIGHT + debounced  ◄┘
                                  1. SELECT the cluster's source_records (bounded index scan, idx_source_records_employment-style)
                                  2. project_field(...) for every §3.4 key → rebuild field_provenance + scalar columns
                                  3. recompute data_quality_score (Clock A, §2.2)
                                  4. SET prov_hwm = max(ingested_at) seen   — WHERE prov_hwm IS NULL OR prov_hwm < new_hwm  (monotonic guard, F3)
                                  5. INSERT search_outbox(...) → ADR-0035 CDC propagation (NOT in the OLTP read path)
```

- **OQ2 (fan-out bound).** The outbox is `content_hash`-keyed and **coalesced per `entity_id`**: a burst of
  source_records for one person collapses to **one** re-projection (single-flight job per entity), so re-projecting
  one entity is never an N+1 against its own cluster. Write-amp is **O(cluster size) read + O(1) row update** per
  coalesced trigger.
- **OQ1 (`source_count` recompute trigger).** `n` is a **stored integer**, recomputed exactly at step 2 from a live
  `COUNT(DISTINCT source_name)` over the cluster. It is correct **as of the last projection**; between projections it
  may lag by the outbox drain latency. No read needs a guaranteed-live count — corroboration drives survivorship and
  the score, both of which are themselves projected, so the stored `n` is consistent with the materialized winner it
  was computed alongside. (If a future consumer needs a live count, it re-projects — bounded, §2.)
- **OQ4 (super-node escape hatch).** Per-entity re-projection degrades only for a **high-degree super-node** (celebrity,
  or a free-mail super-cluster). The free-mail guard (`PLAN_02 §1.4`, `companyDomainKey()`) prevents the worst
  company-side case; for residual large person clusters the projector **caps the scan at the top-K most-trusted
  `source_records` per field** (K bounded, e.g. 64) — survivorship over the K best supporters is provably equal to the
  full scan for the winner (a value outside the top-K trust band can never win tiers 2–3), so the bound is correctness-
  preserving. A *narrow* extracted corroboration index for the rare uncapped case stays the **deferred** escape hatch
  (a scoped instance of B, only-if-needed) — not built now.

### 1.4 The human pin — two layers + the overlay merge algorithm (OQ3/OQ7)

The pin is the load-bearing reason field-level provenance is mandatory (RESEARCH_03 §B.2): *"a bare column cannot say
'don't overwrite me.'"* TruePoint has **two** pin scopes (the U3 split, DECISION part 4):

- **Overlay pin (common, workspace-private).** A user hand-edits `contacts.job_title` → the overlay descriptor becomes
  `{src:'user_edit', pin:true, by:user, at:ts}`. It blocks a later reveal/enrichment from overwriting *that
  workspace's* value, and **never** mutates the golden record (CONTRIBUTE-TO is opt-in, ADR-0021:60-62; C2/C3).
- **Master/steward pin (rare, privileged).** A platform steward pins a golden value in the review band (§1.6) →
  `field_provenance[field].pin=true` on the master, set via `withPlatformTx` (audited, `client.ts:95-111`); it is the
  highest cascade tier (§1.1 tier 1) and affects every future reveal.

**The exact overlay merge on reveal/enrichment (OQ7) — how user edits are protected from provider overwrite:**

```
  reveal_or_enrich_overlay(contact, field, master_descriptor):
    o = contact.field_provenance[field]
    if o exists and o.pin == true:                      # ── OVERLAY PIN: human correction is sacrosanct
        return  # do NOT overwrite the value OR the descriptor — the workspace's hand-edit stands
    # else adopt the master OV as a frozen snapshot (Clock B), scrubbing the source label to a platform tier (C2):
    contact[field]                = master_value
    contact.field_provenance[field] = { src: platform_label(master_descriptor.src),  # master:verified | provider:<name>
                                         mth: master_descriptor.mth, conf: master_descriptor.conf,
                                         obs: master_descriptor.obs, ver: master_descriptor.ver, pin: false }
    # NEVER copy master_descriptor.wsr / source_record_id (could expose a co-op contributor); platform label ONLY (C2)
```

A CONTRIBUTE-TO edit (opt-in only) is the *only* path a workspace value enters Layer 0 — and it enters as a **new
`source_record` with `source_name='coop'`** that the cascade then weighs like any other source (it does **not** directly
write a master descriptor); MATCH-AGAINST writes **no** master provenance (DECISION "Explicitly rejected"; ADR-0021).
This keeps the two paths from ever crossing (OQ7).

### 1.5 Reversibility — unmerge & replay-as-of (no version table)

Reversibility is **replay over the immutable log**, not a per-field SCD2/version chain (DECISION part 5; RESEARCH_03 §B.5):

- **Whole-entity unmerge** (two people wrongly merged): split the cluster via `match_links.is_duplicate_of`
  (`03:480`), enqueue a `projection_outbox` row for **both** resulting clusters → each re-projects from its own
  `source_records`, rebuilding its map. Cheap (per-entity, §1.3).
- **Per-field bad pick** (right person, wrong source won one field): the same per-entity re-projection corrects it (a
  whole-entity re-project, cheap per S2 — not surgical, but it produces the identical post-fix result B's surgical
  `supersede` would, BRAINSTORM_03 §3); or a steward pin forces the correct value durably (§1.4).
- **Audit / "what was combined" (pre-build item 4).** The unit of lineage is the **immutable `source_records` log**:
  *"what was the winner on date D"* = run the cascade over `source_records WHERE ingested_at ≤ D` (the descriptor's
  `obs`/`ing` carry both time axes). So the audit is **replay-as-of**, not a stored version table. Each re-projection
  additionally emits a compact **winning-descriptor delta** event (`field, old src→new src, old conf→new conf`) to the
  observability/audit sink in the same job; a durable `field_provenance_history` table is **deferred** (Open Q) since
  replay already answers it without a billions-row history object.

### 1.6 The human-review path (reuse `match_links.review_status`; no new queue)

Two review surfaces, both **reusing existing machinery** (the `PLAN_00`/`PLAN_02` reuse rule — no parallel state machine):

1. **Entity-merge review** (which records are the same) — the Splink two-threshold gate → `match_links.review_status
   ∈ ('auto','pending','confirmed','rejected')` (`03:481-482`) → the customer duplicate-review queue + the staff
   console (ADR-0015:77-90; `22:161-171`). A confirmed/rejected decision in this band is recorded as **provenance**: the
   confirmed merge re-projects (§1.5); a steward field-pick in the band is minted as a **master pin** (§1.4) — *"manual
   actions are data, not side effects"* (RESEARCH_03 §B.6), so the next ER pass reads it as the highest-trust input and
   does not re-litigate it (S7).
2. **Field-conflict review** (right entity, two high-trust values disagree) — the cascade still serves a deterministic
   winner; the descriptor's `ctd:true` + the row's `_any_contested` rollup feed a **steward worklist** (the
   `idx_*_contested` partial index, §3.2). Resolution is a steward pin. This is **not** a blocking queue and **not** a
   new `review_status` — it is the *same pin mechanism* as (1), surfaced by a flag (BRAINSTORM_03 §2 S7).

---

## 2. How provenance feeds the consumers

### 2.1 The employment-edge confidence (Phase-2 handshake; the U2 seam — OQ6)

`PLAN_02` froze the edge's thin cache columns `{asserting_source, match_method, confidence, source_count, observed_at,
last_verified_at}` and **explicitly deferred the survivorship engine that populates them to Phase 3**
(`PLAN_02 §0.2`, §8 Q2). This PLAN supplies it: `master_employment.field_provenance` (§3.2/§3.4) carries the per-attribute
descriptors (`edge`, `title`, `department`, `seniority_level`, `started_on`, `ended_on`); the cascade (§1.1) populates
**both** the per-attribute map **and** the flattened cache columns, where the cache scalars are the `edge` descriptor's
fields:

```
  master_employment.asserting_source = field_provenance.edge.src
  master_employment.match_method     = field_provenance.edge.mth          # deterministic_domain | deterministic_email | fuzzy_name_company
  master_employment.confidence       = field_provenance.edge.conf         # edge-existence confidence (§1.2): email-domain→primary_domain strength
  master_employment.source_count     = field_provenance.edge.n
```

The edge `confidence` is the **email-domain → `primary_domain`** match strength (the strongest company key,
`matchKeys.ts:74-81`; `PLAN_02` C2) — it feeds the **link-acceptance gate** and the **primary tiebreak** that drives
`current_company_id` (`PLAN_02 §1.2`: email-domain match → highest `confidence` → most-recent → lowest id). OQ6
resolution: the edge gets its **own** `field_provenance` map (consistent shape, edge is its own entity), **not** nested
under the person's map — co-owned with `PLAN_02`, which already reserved the cache columns.

### 2.2 `data_quality_score` per-field + the two clocks (Phase-6 handshake)

`data_quality_score = round(100 × (0.4·completeness + 0.3·verification + 0.3·freshness))` with the cold-start
re-weighting (`dataHealth.ts:130-138`). The map makes all three sub-scores **per-field-aware** and recomputes the score
inside the re-projection (§1.3 step 3) — reusing the leaf math, never forking it (C5):

- **completeness** (`dataHealth.ts:87-92`) — the map's key set *is* "which fields have a surviving present-and-valid
  value": a key present with `conf ≥ PROMOTE_FLOOR` → that completeness field is `present`.
- **verification** (`dataHealth.ts:55-77`) — per-channel `email_status`/`phone_status` come from the referenced channel
  rows (§3.6); the descriptor's `ver` confirms a value was checked.
- **freshness** (`dataHealth.ts:44`) — **per-field** `obs`/`ver` is the age input, upgrading from today's single
  record-level `last_verified_at` (`contacts.ts:135`): the worst-decaying present field (email, SLA 90d,
  `dataHealth.ts:19-26`) sets `freshness_status`, but each field now decays on its own clock.

**The two clocks stay distinct** because the map exists **on both layers** (S6; `RESEARCH_06 §1:74-82`): the **master**
map's `obs`/`ver` drive **Clock A** (the system's corpus re-verify priority queue, on TruePoint's own spend); the
**overlay** map's drive **Clock B** (the workspace's *frozen* snapshot age → `freshness_status`, whether a re-reveal is
a billable re-projection). A re-verify of the master never auto-rewrites a revealed overlay snapshot (owner-view
stability) — it surfaces as a Phase-6 signal (`RESEARCH_06 §1:67-68`; the U3 reconciliation signal). Conflating the two
is the headline freshness error this design structurally prevents.

---

## RLS policy implications

Two isolation regimes that must not bleed (C7/C8; the inverse postures of `PLAN_02 §RLS`):

1. **Layer 0 (master maps) — NOT a workspace RLS predicate; isolation by access path.** `field_provenance` on
   `master_*` and the `source_field_trust` config carry **no `workspace_id`/`tenant_id`/`owner`/`visibility`** (C1) and
   get **no RLS policy and no `GRANT … TO leadwolf_app`** — a tenant tx (`SET LOCAL ROLE leadwolf_app` +
   GUCs, `client.ts:48-68`) has **no privilege** on the master tables, so it cannot address the map at all
   (privilege-denied, not row-filtered). The descriptor records a **platform-level `src`** only
   (`apollo|zoominfo|coop|public_registry|master:verified`) and **never** names a contributing workspace (C2;
   MATCH-AGAINST writes no master provenance) — security has final say and the scrub is mandatory (CLAUDE.md precedence).
2. **Layer 1 (overlay map) — unchanged FORCE-RLS.** `contacts.field_provenance`/`accounts.field_provenance` are two
   more columns on an already-RLS-scoped table; the existing `*_workspace_isolation` policy on
   `workspace_id = NULLIF(current_setting('app.current_workspace_id', true),'')::uuid` (`rls/contacts.sql`) governs
   every read/write. The two-tenant isolation itest is **extended** (not relaxed) to assert that the new column does not
   let workspace A read workspace B's provenance, and that a revealed overlay descriptor contains **no foreign-source
   `wsr`** (only a platform label) — a negative test mirroring `PLAN_02`'s privilege-denied edge test.
3. **What surfaces to the workspace, and how.** On a **detail read**, a workspace sees its **own** overlay map
   (its source labels, confidence, freshness, pins). Through the **reveal / masked-search projection**, the
   **non-PII** parts of the master descriptor (`src` as a platform tier, `conf`, `obs`, `ver`, `mth`) are copied down
   so the UI can answer *"where did this come from / how confident / how fresh"* — but the master `wsr`
   (`source_record_id`) and the raw candidate set are **never** surfaced (they could leak a co-op contributor). The
   masked search indexes only the scalar OV; `master_emails`/`master_phones` are never search-returned (`03:383-384`).
4. **DSAR / deletion cascade (the unit of deletion is the golden identity).** A data subject is one `master_persons`
   identity found by `master_emails.email_blind_index` (GLOBAL UNIQUE, `03:442`). Erasure (`withPrivilegedTx`,
   `client.ts:30-35`) tombstones the golden value + **nulls its map entry**, tombstones the referenced `source_records`
   row, cascades `master_employment`/`master_emails`/`master_phones` (`ON DELETE CASCADE`, `03:430-459`), inserts a
   GLOBAL suppression row (blocks re-import), and cascades to every overlay copy + its map entry (`contacts.deleted_at`
   + null-PII, `contacts.ts:147`). The descriptor holds a **`wsr` pointer + non-PII metadata, never PII in clear**
   (§3.1), so erasure never has to scrub a PII value out of the JSONB — it nulls the key and tombstones the pointee.
   **Provenance makes DSAR *more* provable** (RESEARCH_03 §C.3): "where did this purged email come from" is answerable
   per field, upgrading from today's batch granularity.

---

## Scale-gate analysis

Scale target: millions of users, **billions** of golden entities × ~15 fields (CLAUDE.md). N+1 and unbounded fan-out are
failures. *What breaks first at 10×, and the fix:*

| Rank | What breaks first at 10× | Why | Fix (this PLAN) |
|---|---|---|---|
| **1** | **Re-verification re-projection storm** | a corpus re-verify tick (email 90d, ADR-0025) could enqueue billions of per-entity re-projections at once | Re-project **only entities whose cluster actually changed**; outbox **coalesced per `entity_id`** (single-flight, §1.3); the re-verify is a **bounded-rate priority queue** (Phase 6), not a corpus sweep. Per-entity work is O(cluster), bounded. |
| **2** | **High-degree super-node re-projection** | a celebrity / free-mail super-cluster blows the per-entity cluster bound | Free-mail guard prevents the worst company case (`PLAN_02 §1.4`); the projector **caps the scan at top-K-trusted source_records per field** (correctness-preserving, §1.3 OQ4); a narrow extracted corroboration index stays the **deferred** escape hatch. |
| **3** | **Map bloat / TOAST on the hot golden row** | ~200–600 B × billions = 0.2–1.8 TB; a fat descriptor pushes the map out-of-line and slows every golden read | **Closed key set + short keys + no PII + channel-by-reference** (§3.1/§3.4) keep the map inline/small-TOAST; the **search/read path never reads the map** (indexes the scalar OV, C4). |
| **4** | **"Where did this come from" / contested-field scans** | a blanket GIN on `field_provenance` at billions is a huge write/storage cost | Detail-read is **by PK** (no index needed); the steward worklist uses a **tiny partial GIN** on the `_any_contested` rollup only (§3.2), never a corpus-wide GIN. |
| **5** | **`source_records` candidate-log growth** | the immutable crosswalk grows without bound as sources accrue | Already **range-partitioned by `ingested_at`/month**, bulk cold to **S3+Iceberg** (`03:470`); the map defers all history to it (DECISION part 1). The map column needs **no new partitioning** (it rides the master/overlay tables). |

**Verdict:** every first-breakage is either an in-scope bound we apply now (coalesced single-flight, top-K cap, lean
descriptor, partial index) or rides an already-deferred component (Iceberg lake, the Phase-6 priority queue). The map
adds **+1 column per row, no join, no new billions-row table** (the whole point of choosing C over B, BRAINSTORM_03 §2 S1).

---

## Pre-build thinking pass (the applicable items)

- **1 Source of truth.** `source_records` (immutable crosswalk) is truth; `field_provenance` + the scalar golden
  columns are a **materialized survivorship projection**; the search doc is a derived surface (C1; RESEARCH_03 §C.4.1).
- **2 Failure modes + idempotency.** Survivorship is a **pure deterministic function** over a `content_hash`-idempotent
  log (`03:464`) → re-runs converge; the `prov_hwm` monotonic guard (§3.2) prevents a slow projector clobbering a fresher
  map. Full list in **Failure modes**.
- **3 Duplicate prevention.** `source_records.content_hash UNIQUE` (idempotent ingest); `master_emails.email_blind_index
  UNIQUE` (one channel per value, concurrent ingests can't double-insert, `03:442`); the descriptor's `n` is a recomputed
  `COUNT(DISTINCT source_name)`, not a drifting increment (the A/B failure, BRAINSTORM_03 §1).
- **4 Audit + change history (same-tx).** Replay-as-of over the immutable log (§1.5); the projector emits a winning-
  descriptor delta event; steward pins/overrides go through `withPlatformTx` (audited in the same tx, `client.ts:95-111`).
- **5 Security (IDOR / exposure / co-op).** No `workspace_id` on the master map; the descriptor is scrubbed to a
  platform `src` (no foreign-workspace attribution, C2); overlay map RLS-scoped + owner-scoped on read; `wsr` never
  surfaced; secrets/PII never in the map (channels by reference). Security has final say (RLS §).
- **6 Scalability / 10×.** +1 column, no join, no new table; per-entity bounded re-projection; search indexes the OV
  only (Scale-gate).
- **7 Observability.** Emit `provenance.reprojected{entity, fields_changed}`, `provenance.contested{field}`,
  `provenance.pin.set{layer, actor}`, projection-queue depth/lag, super-node cap-hits, `_any_contested` count; runbook
  hooks feed Phase-6 + ops.
- **8 Rollback.** Additive migration (nullable-`{}` JSONB columns + a tiny config table) → reversible; the map is
  **derived** → rebuildable from `source_records` by replay; the engine ships behind a flag; a bad cascade is fixed by
  the next re-projection (concurrency-safe-by-recompute).
- **9 Edge cases.** No evidence → empty map (field null, descriptor absent); single source → `n=1`; pinned-then-source-
  changes → pin wins until un-pinned (the lost-update we *want*, RESEARCH_03 §C.4.7); two high-trust disagreeing values
  → deterministic winner + `ctd:true`; concurrent re-projection → single-flight + `prov_hwm` guard; below `PROMOTE_FLOOR`
  → candidate-only, golden stays last-good.
- **10 Assumptions (load-bearing).** (a) ER blocking/LSH keeps clusters small so per-entity re-projection is bounded
  (BRAINSTORM_03 §2 S2; the super-node is the named exception, OQ4). (b) The winning value lies in the top-K-trusted
  supporters (the §1.3 cap is correctness-preserving). (c) `source_records` is written **per field-contributing source**
  so the cluster is re-projectable per field (DECISION part 1; `06 §4:135-143`). (d) Channels stay the *only* normalized
  per-value store (OQ1).
- **11 Misuse.** A workspace cannot write the master map (no privilege); a non-contributed hand-edit pins the **overlay**
  cell only and never touches the golden cell (§1.4); CONTRIBUTE-TO is opt-in and enters as a `source_name='coop'`
  source_record the cascade weighs — never a direct master write (OQ7; ADR-0021:60-62).
- **12 Load behaviour (10×).** Bottleneck order = the Scale-gate table (re-verify storm → super-node → map bloat →
  scans → log growth), each with its fix.
- **13 Worst case.** A celebrity super-cluster + a mass re-verify storm: bounded because re-projection is per-entity,
  coalesced single-flight, top-K-capped, and off the read path; reads serve the materialized OV regardless.

---

## Failure modes

| # | Failure | Cause | Mitigation |
|---|---|---|---|
| F1 | **Blind LWW / whole-record overwrite destroys a verified or human value** | a naive enrichment overwrites the golden/overlay value | The cascade is **not LWW** (§1.1); tier (1) pins protect human edits (§1.4); the overlay merge refuses to overwrite a pinned cell (the CRDT lost-update we forbid, RESEARCH_03 §B.4). |
| F2 | **A slow projector overwrites a fresher map with a staler one** | concurrent re-projections of one entity race | Outbox **single-flight per `entity_id`** + the **`prov_hwm` monotonic guard** (write only if its evidence high-water-mark ≥ stored, §3.2/§1.3). Pure-fn → both converge anyway. |
| F3 | **`source_count` drifts / is un-recomputable** | a stored increment that can't re-derive (the A/B failure) | `n` is recomputed as a live `COUNT(DISTINCT source_name)` over the cluster at every projection (§1.3 OQ1), never incremented in place. |
| F4 | **A junk fuzzy source sets a golden field** | a single low-trust value wins by recency | `PROMOTE_FLOOR` holds sub-floor winners candidate-only; golden keeps last-good (§1.2). |
| F5 | **The master map leaks a contributing workspace / co-op source** | descriptor copies a foreign `wsr`/workspace name | C2 scrub: master `src` is a platform tier; overlay reveal copies a **platform label only**, never `wsr` (§1.4); negative isolation itest asserts it (RLS §). |
| F6 | **DSAR misses a per-field source / leaves PII in the map** | the map duplicated a PII value | The descriptor stores a **pointer + non-PII metadata only**; channels by reference (§3.1, OQ5); erasure nulls the key + tombstones the pointee (RLS §4). |
| F7 | **A super-node re-projection blows the cluster bound** | a celebrity / free-mail super-cluster | Free-mail guard (`PLAN_02 §1.4`) + **top-K-trusted cap** (correctness-preserving, §1.3 OQ4); extracted corroboration index deferred. |
| F8 | **Provenance retrofit becomes a destructive backfill** | the seam wasn't reserved at freeze | Reserved at the Phase-1+2 freeze (`PLAN_00` C6 §5.3); this migration is purely additive (§3.3). |
| F9 | **A confirmed human/steward decision is re-litigated by the next ER pass** | the pick wasn't recorded as data | A review-band pick is minted as a **pin** (highest cascade tier) — "manual actions are data" (§1.6 S7); the next pass reads it as truth. |
| F10 | **An overlay snapshot silently changes under a workspace** | a master re-verify rewrites the revealed copy | Reveal is a **frozen** snapshot (Clock B); a master change is a Phase-6 **signal**, never an auto-overwrite (§2.2; owner-view stability, `RESEARCH_06 §1`). |

---

## Open questions

The seven `BRAINSTORM_03 §4` questions, each **resolved** by this PLAN, plus the residual decisions handed forward:

1. **OQ1 — `source_count` recompute trigger.** *Resolved:* `n` is a stored integer recomputed as a live
   `COUNT(DISTINCT source_name)` at every per-entity re-projection (§1.3); accurate as-of the last projection, which is
   sufficient because every consumer of `n` (survivorship, score) is itself projected alongside it. *Residual:* the
   tolerable outbox-drain lag SLO (set with Phase-5/6).
2. **OQ2 — projection mechanism + fan-out bound.** *Resolved:* a `projection_outbox` row in the same tx as the
   `source_records` insert / match_links split, drained by a **single-flight, per-`entity_id`-coalesced** BullMQ worker
   (CDC/outbox, ADR-0035); O(cluster) read + O(1) update per coalesced trigger. *Residual:* none for the skeleton.
3. **OQ3 — overlay-map placement.** *Resolved:* an **extra `field_provenance jsonb` column on `contacts`/`accounts`**
   (the one-row reveal read; finalizes the `PLAN_00` C6 seam, §3.3) — **not** a child table. *Residual:* if pin-write
   churn on the hot overlay row proves heavy, a workspace-scoped child table is the escalation (the high-churn-isolation
   tradeoff BRAINSTORM_03 named) — deferred until a real case.
4. **OQ4 — super-node escape hatch.** *Resolved:* **top-K-trusted-per-field cap** makes per-entity re-projection bounded
   and correctness-preserving (§1.3); the free-mail guard prevents the worst cluster. *Residual:* whether a *narrow*
   extracted corroboration index (a scoped B, high-degree entities only) is ever needed — **deferred**, build-only-if a
   measured super-node breaches the cap.
5. **OQ5 — descriptor vs PII.** *Resolved:* the descriptor stores `wsr` + non-PII metadata; **channels (email/phone)
   reference the `master_emails`/`master_phones` row** (which holds `value_enc` + blind index), never duplicating PII
   into the map (§3.1/§3.6). *Residual:* none.
6. **OQ6 — edge-provenance shape (Phase-2 handshake).** *Resolved:* `master_employment` gets its **own**
   `field_provenance jsonb`; the cascade populates both it and `PLAN_02`'s flattened cache columns; the `edge`
   descriptor's `conf` = the email-domain→`primary_domain` strength feeding the link-acceptance gate (§2.1). *Residual:*
   co-owned with the `PLAN_02` lifecycle — any edge-attribute key change is a joint edit.
7. **OQ7 — overlay pin vs CONTRIBUTE-TO.** *Resolved:* an un-contributed hand-edit pins the **overlay** cell only
   (§1.4 merge); an opt-in CONTRIBUTE-TO edit enters Layer 0 as a **`source_name='coop'` `source_record`** the cascade
   weighs — never a direct master write; the two paths never cross (ADR-0021:60-62). *Residual:* the CONTRIBUTE-TO
   product/contract surface is **out of this initiative** (`PLAN_00` C3).

**Newly opened by this PLAN:**

- **NQ1 — field-confidence calibration.** The `conf` constants (`PROMOTE_FLOOR=0.30`, `CONTEST_DELTA=0.10`,
  `corroboration_boost`) are *a priori*, to be re-tuned from measured precision (like ADR-0025's SLAs) — owned with
  `truepoint-operations`.
- **NQ2 — durable `field_provenance_history`.** Replay-as-of (§1.5) answers history without a stored version table;
  whether any compliance/UX need forces a compact partitioned history table is **deferred** (default: no).
- **NQ3 — `source_field_trust` governance.** Update cadence/approval for the trust override table + the code-default
  seed (the no-drift discipline, C5) — owned with `truepoint-operations`/Phase 6.

> **Implementation status (gap → work-to-do, never license to skip a rule).** Field-level provenance is **undesigned
> anywhere today** — provenance is batch/job-level only (`source_imports` `contacts.ts:209-245`; `provider_calls`;
> `enrichment_job_rows.enriched_fields`), and ADR-0006:51 consciously accepted its absence (RESEARCH_00 §5). The
> backbone this builds on (`source_records`, `match_links`, `master_emails.source_count`/`last_verified_at`) is
> **designed in `03 §5.1` but not built** (Layer 0 is 100% docs, `PLAN_00` C1); the edge cache columns are frozen but
> unpopulated (`PLAN_02`). The `field_provenance` JSONB map on both layers, the per-(source,field) trust config, the
> per-entity-re-projection survivorship function, the two-layer pin, and the overlay merge are the **net-new Phase-3
> invention**, landing additively after the `PLAN_01`+`PLAN_02` co-land (`PLAN_00 §7`). None of these gaps relaxes a
> constraint: master provenance stays system-owned (no RLS column, no foreign-workspace attribution — C1/C2),
> survivorship stays a deterministic per-field cascade (never blind LWW), human pins outrank provider guesses, and the
> resolution keys stay backed by DB uniques (`03:442,464`) so concurrent ingests cannot mint duplicates. The deferrals
> (`field_provenance_history`, the extracted corroboration index, CONTRIBUTE-TO) are **deferral, not omission** — each
> is reachable additively from the substrate this gate freezes.
