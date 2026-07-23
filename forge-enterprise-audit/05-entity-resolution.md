# 05 — Entity Resolution

> **Priority:** P1 (its F1 prerequisites are P0) · **Effort:** 14–20 eng-weeks (ER engine
> proper; identity-graph storage is costed in `06-identity-graph.md`) · **Phase:** F2 (ER v1);
> prerequisites in F1; scale-out variants in F3/F4
> (phases are defined in `17-phased-implementation-roadmap.md`)

## Executive summary

Entity resolution is the single most important data-quality subsystem in Forge: an
un-deduplicated sales-intelligence dataset is worthless, and every downstream promise —
golden records, DSAR completeness, per-field provenance, search relevance — collapses if the
same person exists five times under five hashes. Today TruePoint carries **two independent
Fellegi-Sunter engines and neither one runs in production**: the main app's scorer
(`packages/core/src/er/fellegiSunter.ts`) is deliberately inert behind `ER_SHADOW_ENABLED`
and never auto-merges, while Forge's fuller engine (`packages/forge-core/src/er.ts` — TF
adjustment, two-threshold routing, blocking, union-find, survivorship) has **zero production
callers** (P-01.31). The pipeline's resolve stage is a pure pass-through
(`apps/forge-worker/src/processors.ts:132-136`), the silver blind indexes and block keys that
blocking would need are always NULL (P-01.3), the Forge↔master blind-index seam is
cryptographically broken (P-01.6), and no m/u weights, prior, or thresholds ship anywhere
outside test literals. The only resolution actually running is the deterministic Layer-0
`resolveForImport` ladder on the main-app side, which mints identity but performs no
probabilistic dedup. The headline recommendation is S.2 #5: **one ER engine — Forge-owned per
ADR-0047, Postgres-native, deterministic-first, evidence-preserving** — built as a five-stage
pipeline (normalize → SQL candidate generation → two-tier scoring → guarded union-find →
field-level survivorship), with Fellegi-Sunter weights trained offline in a Splink/DuckDB
sidecar and every scored pair persisted as an explainable `match_edges` row. The main app's
`er/` directory stays inert through F2 and is deleted in F3. All-Postgres carries this design
to ~30M records; partitioned DuckDB or ephemeral Spark carries backfills to 100M; buying
Senzing (~$58.6K/yr at 10M records) is deferred unless match quality becomes revenue-blocking.

## Current state

### Engine one — the main app's inert shadow scorer

`packages/core/src/er/fellegiSunter.ts` (101 lines) is a pure Fellegi-Sunter pair scorer: it
takes a per-field comparison vector (`agree | disagree | not_compared`) plus caller-supplied
m/u weights, sums per-field log2 weights onto a prior, converts to a posterior via an
overflow-clamped sigmoid (±60 bits, `fellegiSunter.ts:71-77`), and classifies into
`auto_match | pending_review | no_match` by two **posterior-probability** thresholds
(`fellegiSunter.ts:84-100`). It ships a self-described "conservative placeholder config":
`priorLog2Odds: -6.5` (≈1 true match per 90 candidate pairs), `autoMatchThreshold: 0.95`,
`reviewThreshold: 0.8` (`fellegiSunter.ts:56-60`), explicitly flagged "calibrate on a
labelled set". Its header is emphatic that `auto_match` "is a SCORE class, not an
instruction" and that the module "NEVER decides to merge" (`fellegiSunter.ts:30-32,7`); the
blocking candidate generator and the shadow writer that would persist
`match_links(review_status='pending')` are declared "later slices" (`fellegiSunter.ts:5-7`).
Per the reuse inventory, the surrounding `er/` module adds `compareRecords` with a 7-field
comparison vector and Jaro-Winkler similarity, and an `erSweep` job gated behind
`ER_SHADOW_ENABLED` that never auto-merges (fact pack §2.3, §6.6 item 2). Net: a careful
scorer, deliberately dark.

### Engine two — Forge's fuller engine with zero callers

`packages/forge-core/src/er.ts` (195 lines) implements substantially more of the ER problem,
and none of it is invoked by any production code path (fact pack §3.1):

- **Scoring.** `baseWeight(λ) = log2(λ/(1−λ))` (`er.ts:25-27`); per-field
  `fieldWeight` = `log2(m/u)` on agreement, `log2((1−m)/(1−u))` on disagreement
  (`er.ts:36-39`); a mandatory **term-frequency adjustment** `tfAdjustedU` that shrinks u for
  rare values and clamps it at 1e-6 (`er.ts:31-33`) — the guard against common-name
  over-scoring the main engine lacks; `matchProbability` as a numerically-stable sigmoid
  (`er.ts:55-58`).
- **Routing.** `routeMatch` classifies by two thresholds into
  `auto_merge | grey_zone | auto_reject` — but the thresholds are expressed in raw **weight
  bits**, not posterior probability, and no default values exist anywhere (`er.ts:61-74`).
- **Blocking.** `blockingKeys` emits three key families — `ln:` 4-character lowercase surname
  prefix, `dom:` email domain, `li:` LinkedIn public id (`er.ts:85-97`); `candidatePairs`
  unions buckets (share ANY key → candidate) and dedups pairs in memory (`er.ts:100-131`);
  `largestBlockSize` exists as a diagnostic only (`er.ts:134-138`) — nothing enforces a cap.
- **Clustering.** `connectedComponents` is a plain union-find over an in-memory id list
  (`er.ts:142-169`), with no cluster-size ceiling, no locking, and no notion of incremental
  re-clustering.
- **Survivorship.** `pickSurvivor` orders attribute candidates by
  authority > validated > completeness > recency (`er.ts:185-194`).

The two engines drift on almost every semantic axis:

| Concern | `packages/core/src/er/fellegiSunter.ts` | `packages/forge-core/src/er.ts` |
|---|---|---|
| Lines / scope | 101 · scorer only (blocking/shadow "later slices") | 195 · scorer + TF + blocking + union-find + survivorship |
| Threshold domain | posterior probability (0.95 / 0.80 defaults) | raw weight bits, no defaults shipped |
| Disposition vocabulary | `auto_match` "a score class, not an instruction" | `auto_merge` — names an action |
| Null/missing fields | `not_compared` → 0 bits (`fellegiSunter.ts:63-68`) | no vocabulary — `agree: boolean` only; an unfiltered null scores as full disagreement |
| TF adjustment | none | `tfAdjustedU`, clamped 1e-6 |
| Overflow guard | ±60-bit clamp before sigmoid | none — degenerate m/u produce ±Infinity/NaN (see P-05.7) |
| Prior | `priorLog2Odds` in config (−6.5 default) | `baseWeight(λ)` computed from λ, caller-supplied |
| Production callers | `erSweep` shadow only, behind `ER_SHADOW_ENABLED`, never merges | **zero** |
| Calibrated parameters | placeholder default, self-labeled | none — test literals only |

### The database and pipeline around the engines

The `forge` schema ships three ER tables — `match_candidates`, `forge.match_links`,
`merge_log` — and all three are **dead schema: no readers, no writers** (fact pack §3.2,
migration `packages/db/src/migrations/0070_forge_schema.sql`). The silver columns blocking
depends on are never populated: `runParse`'s upsert omits the parser's `channels`
(blind-index) and `blockKey` outputs, so `parsed_records.email_blind_index` and
`parsed_records.block_key` are always NULL (P-01.3) — even though the one parser computes
both (voyager profile: email→blind index, blockKey = 4-char surname prefix,
`packages/forge-core/src/parsers/voyagerProfile.ts`, fact pack §3.1). The S3-resolve
processor dequeues and immediately enqueues verify with no ER call
(`apps/forge-worker/src/processors.ts:132-136`; see the stage-by-stage audit in
`01-current-architecture-audit.md`). Even if Forge ER produced identities, the blind-index
seam to the master graph is broken three ways — hex vs raw-bytes encoding, different keys,
different normalization, and a hex-decoded-as-base64 write (`packages/db/src/repositories/
forge/forgeSyncRepository.ts:63-65`, P-01.6) — so Forge-resolved identities could never dedup
against main-app identities.

What actually resolves records in production today is the main app's **Layer-0 deterministic
resolver** `resolveForImport` (linkedin_public_id → email_blind_index → registrable domain),
reused by the sync apply path, which LINKs or MINTs master identities but performs no
probabilistic matching, no clustering, and no survivorship (fact pack §6.1). On the master
side, `match_links.review_status ∈ auto|pending|confirmed|rejected` and `cluster_id` **is**
the golden id; the Forge sync path writes `match_method='forge'`,
`review_status='confirmed'` (fact pack §2.3, §6.1). Note the duplication: the public
`match_links` family (master graph) and `forge.match_links` are two distinct table sets
(fact pack §6.6 item 11).

**Intent, per the planning suite** (labeled as intent, not reality): roadmap P5 makes ER the
fattest phase (XL) and concedes its design doc was never written (G-FORGE-1901,
`docs/planning/forge/`); decision L4/ADR-0047 assigns ER ownership to Forge, makes the main
app's `er/` + `erSweep` inert, and demotes `master_*` to a downstream serving projection —
explicitly a one-way door (OQ-3). ADR-0047 remains **Proposed, not Accepted** (P-01.30).

## Problems identified

- **P-05.1 — GAP · No entity resolution runs anywhere in production.** The resolve stage is a
  pass-through (`apps/forge-worker/src/processors.ts:132-136`); `er.ts` has zero callers
  (fact pack §3.1); the main engine is inert by design behind `ER_SHADOW_ENABLED` (fact pack
  §2.3). Every record that traverses the pipeline (once P-01.1/P-01.2 are fixed) reaches gold
  un-deduplicated; at the scale model's ~4:1 dedup ratio (fact pack §2.5) the golden layer
  would be ~75% duplicates. This is the defect that makes the dataset unsellable.
- **P-05.2 — BUG · Blocking is impossible: silver blind indexes and block keys are NULL.**
  The parse upsert drops `channels`/`blockKey` (P-01.3), so no SQL candidate generation can
  ever find a partner row. Any ER work is dead on arrival until this F1 fix lands.
- **P-05.3 — RISK · The blind-index seam guarantees cross-system duplicate identities.**
  Forge HMAC-hex under `FORGE_BLIND_INDEX_KEY` vs main HMAC-raw-bytes under
  `BLIND_INDEX_KEY`, different normalization, and a hex-as-base64 decode at apply
  (`forgeSyncRepository.ts:63-65`; P-01.6, P-01.14). Until the F1 unification, Forge and
  main-app captures of the same email are structurally distinct identities — silent
  duplication at the master layer, and a broken DSAR key.
- **P-05.4 — DEBT · Two Fellegi-Sunter engines with divergent semantics** (P-01.31 item 2).
  Beyond duplication cost, the semantic drift is dangerous: thresholds in posterior
  probability vs weight bits, `auto_match`-as-score-class vs `auto_merge`-as-action, and
  null-handling that penalizes incomplete records in one engine but not the other. A config
  or habit ported across engines silently misbehaves.
- **P-05.5 — GAP · No trained parameters exist.** No m/u table, no λ, no thresholds ship in
  any config, table, or env; the only values in the repo are unit-test literals and the main
  engine's self-labeled placeholder (`fellegiSunter.ts:56-60`). An engine without calibrated
  weights is a random-number generator with extra steps.
- **P-05.6 — GAP · No evidence persistence.** `match_candidates`, `forge.match_links`, and
  `merge_log` are never written (fact pack §3.2), and neither engine persists scored pairs
  with their feature vectors. Without stored edges there is no explainability (GDPR/DSAR "why
  are these merged"), no unmerge path, no training corpus, and no way to audit precision.
- **P-05.7 — BUG · Forge's `fieldWeight` is unguarded at degenerate m/u.** With `u = 1` the
  disagreement branch divides by zero — `log2((1−m)/0)` = +Infinity; with `m = 1` it is
  `log2(0/(1−u))` = −Infinity; `u = 0` on agreement without a TF frequency is +Infinity
  (`er.ts:36-39`; only the TF path clamps, `er.ts:31-33`). A single degenerate field forces
  `routeMatch` to an unconditional disposition. The main engine clamps (±60 bits,
  `fellegiSunter.ts:71-77`); Forge's does not. Verified by direct read.
- **P-05.8 — BUG · Blocking has no block-size caps.** `candidatePairs` enumerates every pair
  in every bucket with no ceiling (`er.ts:100-131`); `largestBlockSize` is a diagnostic
  nothing calls. At corpus scale a `dom:gmail.com` block is tens of millions of records —
  ~10^14 pairs from one key. The in-memory pair materialization also caps the whole design at
  toy sizes (see P-05.13).
- **P-05.9 — GAP · No over-merge guardrails.** No maximum cluster size, no
  identifier-cardinality limits (Segment-style merge protection), no per-component locking
  (Apollo's Redis-lock discipline), and transitive closure runs over whatever edges it is
  given — the classic union-find failure mode where one bad edge welds two real people into
  one entity, at scale, silently (fact pack §8.1, §8.5).
- **P-05.10 — GAP · Survivorship is duplicated, unreferenced, and not a pure function of
  inputs.** Forge's authority > validated > completeness > recency (`er.ts:185-194`) vs the
  main app's revealed > completeness > age > id with `fieldProvenance` pins (fact pack §6.6
  item 4); neither runs; no `golden_versions`, no rule-version or input-set hash, so a golden
  record is not reproducible and unmerge cannot recompute.
- **P-05.11 — GAP · No person ≠ person@company model.** Nothing represents employment as a
  dated person↔company edge; a work email is treated (where treated at all) as person-level
  evidence. Under ~30%/yr B2B job-change decay (fact pack §2.5; vendor folklore, flagged), a
  new-domain email will either wrongly split a slug-matched person or wrongly keep them
  welded to a stale employer. The graph model lives in `06-identity-graph.md`; the ER engine
  must emit employment evidence, not person merges, for work-email agreement.
- **P-05.12 — RISK · The `auto_merge` disposition contradicts platform doctrine, and the
  grey zone has no working outlet.** The platform's fixed identity rule is "weak matches
  suggest, never silently merge" (FIXED decision #6), yet Forge's engine names an
  auto-merge action with no approval flow around it; meanwhile `review_tasks` rows are
  inserted but never claimable or resolvable (fact pack §3.2), so the grey zone would pile up
  unbounded. Wiring the engine naively as-built would create exactly the silent-merge path
  the doctrine forbids.
- **P-05.13 — DEBT · The engine's shape is in-memory and single-process.** `candidatePairs`
  and `connectedComponents` operate on full in-memory arrays (`er.ts:100-169`) — workable to
  ~10^5–10^6 records, not to the NFR's 100M+ rows (fact pack §2.5). The production design
  must push candidate generation into SQL and cluster per-component, incrementally.

## Research findings

- **Fellegi & Sunter (1969), "A Theory for Record Linkage," JASA 64(328)** — the
  probabilistic foundation both engines implement (m/u agreement weights, two-threshold
  decision bands). https://www.tandfonline.com/doi/abs/10.1080/01621459.1969.10501049
- **Splink v4 (UK Ministry of Justice)** — free, production-grade FS implementation with EM
  weight training and unioned SQL blocking rules; ~7M records in ≈2 minutes for <$1 on a
  high-spec machine, ~25 minutes on 8 vCPU; 100M+ via Spark/Athena backends; the **Postgres
  backend is experimental** — train weights offline in a DuckDB sidecar rather than running
  Splink against the production database. https://moj-analytical-services.github.io/splink/
  (fact pack §8.1; tool envelope: 9M rows/45 min/96 cores, 80M in <2h, §2.5).
- **Apollo.io engineering** — union-find (DSU) in production over billions of account
  records, Redis distributed locks to serialize concurrent merges, and the finding that
  **~90% of duplicate accounts came from CRM ingestion** that lacked a resolution gate.
  https://www.apollo.io/tech-blog/detecting-data-duplication-at-scale
- **Segment Unify "merge protection"** — purely deterministic identity graph with
  **identifier cardinality limits and priority ranking**: an email/phone that links more than
  a bounded number of profiles stops being merge evidence. Directly reusable guardrail.
  https://segment.com/docs/unify/identity-resolution/ (fact pack §8.5)
- **Ditto (VLDB 2020)** — transformer entity matching, F1 96.5% on a 789K×412K company
  corpus; state of the art on benchmarks but pairwise-cost-prohibitive as the primary
  matcher at 100M scale. https://arxiv.org/abs/2004.00584
- **Peeters & Bizer (2023)** — GPT-4-class zero-shot matching beats transferred fine-tuned
  PLMs by 8–40 F1 on unseen domains — the basis for LLM adjudication of only the uncertain
  band (≈$0.5–1 per 1K pairs on Haiku batch; see `11-ai-assisted-processing.md`).
  https://arxiv.org/abs/2310.11244
- **Build-vs-buy price points** — Senzing: the only serious embeddable buy, free ≤100K
  records, ~$58,560/yr at 10M, six figures extrapolated at 100M+
  (https://senzing.com/pricing/); AWS Entity Resolution: $0.25/1K records processed ≈
  ~$25K per full 100M pass (https://aws.amazon.com/entity-resolution/pricing/); Zingg
  requires a Spark 3.5 runtime (https://github.com/zingg-io/zingg); the `dedupe` Python
  library is effectively dormant (hosted service shut 2023,
  https://github.com/dedupeio/dedupe); Tamr $250K+ (unverified, fact pack §8.1).
- **er-evaluation** — cluster-aware precision/recall estimation from samples; use it
  regardless of engine choice. https://github.com/Valires/er-evaluation
- **Company identity** — domain-first keying on the PSL registrable domain
  (https://publicsuffix.org/) with a shared-domain override table for
  franchises/hosters/subsidiaries; hierarchies seeded from GLEIF LEI Level 2 who-owns-whom
  (3.02M active LEIs Q1 2026, large entities only,
  https://www.gleif.org/en/lei-data/access-and-use-lei-data/level-2-data-who-owns-whom);
  OpenCorporates is ODbL share-alike — a contamination risk for a proprietary dataset, use
  for verification only (fact pack §8.2).
- **MinHash/LSH blocking** — the standard non-deterministic recall booster once
  deterministic keys plateau: Leskovec, Rajaraman & Ullman, *Mining of Massive Datasets*,
  ch. 3. http://www.mmds.org/
- **Practitioner accounts (research-agent sourced; primary URLs not re-verified,
  unverified):** RudderStack ships identity resolution as SQL over the warehouse; ZoomInfo
  runs Solr-side exact-criteria matching with nickname expansion plus a Neo4j/FastRP POC on
  ~20% of data; People Data Labs (3B+ persons) applies a conservative >90% similarity
  threshold and logs near-threshold pairs for manual review; LinkedIn "standardization" maps
  user text to entity taxonomies in real time; Informatica's XREF keeps per-cell source
  attribution so unmerge is a recompute; LiveRamp's RampID graph is deterministic-first
  (fact pack §8.3–§8.5).

The production consensus across all of the above: **hybrid deterministic-ladder →
Fellegi-Sunter → graph clustering**, with blocking as unioned cheap keys plus LSH/ANN at the
high end, union-find scoped per component, and precision deliberately favored over recall
(fact pack §8.1).

## Enterprise best practices

A ZoomInfo/Apollo/LinkedIn-class platform treats ER as a gate, not a batch job: nothing
enters the golden layer without passing resolution. The bar, distilled: (1) deterministic
identifiers first — they are cheap, explainable, and cover the bulk of true matches;
probabilistic scoring handles only the residue. (2) Every scored pair is persisted with its
feature vector — explainability doubles as the GDPR/DSAR answer and the training corpus.
(3) Auto-merge is earned, not default: conservative thresholds (PDL's >90%), shared-identifier
demotion (Segment), cluster-size ceilings, and serialized merges (Apollo's locks). (4) The
golden record is a **pure function** of (member records, rules, rule-version), so unmerge is
a recompute, never a restore. (5) Person and employment are separate: the LinkedIn slug is
the person anchor (user-editable — keep history, trust highly but not infinitely); work email
is employment evidence with dates; company identity is domain-first with a shared-domain
blocklist. (6) Precision and recall are *measured*, continuously, by stratified sampling —
not asserted. (7) The review queue is part of the engine: the grey zone routes to ranked
human review with an SLA, and review outcomes feed back into weights.

## Recommended architecture

### The decision: one engine (S.2 #5), and why

Adopt headline recommendation S.2 #5 verbatim: **one ER engine, Postgres-native,
deterministic-first, evidence-preserving.** Concretely:

1. **Forge owns ER** — ratify ADR-0047 from Proposed to Accepted (closing part of P-01.30).
   Forge is where the evidence lives (bronze payloads, silver parses, extraction runs);
   `master_*` is the serving projection. The main app's `packages/core/src/er/` + `erSweep`
   stay inert through F2 and are **deleted in F3** once Forge ER v1 is authoritative.
2. **Postgres-native** because the platform's fixed decision #3 makes Postgres the source of
   truth; ER needs transactional merges, bulk set operations, and DSAR-grade evidence — not
   graph traversals (fact pack §8.3). No graph database, no Spark cluster, no new substrate
   for v1.
3. **Deterministic-first** because it implements the platform's fixed identity hierarchy
   (stable external ID → normalized email → registrable domain → fuzzy-with-threshold; FIXED
   decision #6) and because the strongest practitioner evidence (Apollo, Segment, PDL) is
   that deterministic keys plus guardrails do most of the work at a fraction of the cost.
4. **Evidence-preserving** because stored edges with features are simultaneously the
   explainability layer, the unmerge mechanism, the audit trail, and the training set for
   weight calibration and future ML.
5. **One engine** because the blind-index seam breakage (P-01.6) is the proof of what dual
   identity stacks do: two implementations of identity math **will** drift, and identity
   drift is silent data corruption. The duplication kill-list (S.2 #2,
   `16-technology-recommendations.md`) starts with blind index + content hash precisely
   because they feed this engine.

Salvage policy for the existing code: keep Forge's scorer core (log2 bits + TF adjustment +
survivorship shape) as the base; port **into it** the main engine's superior semantics —
`not_compared` → 0 bits, posterior-probability thresholds, the ±60-bit clamp, and the
"score class, not an instruction" doctrine — then delete the main `er/`.

### The five-stage pipeline (R2 architecture, fact pack §8.6)

```text
        silver parsed_records  (+ er_block_keys written at parse time — fixes P-05.2)
                                   │
        forge-resolve job (batch; idempotency key = (record_id, model_version))
                                   │
 ┌─────────────────────────────────▼──────────────────────────────────────────┐
 │ Stage 0 NORMALIZE   email → one unified HMAC blind index (F1, P-01.6)      │
 │                     domain → PSL registrable + shared_domains blocklist    │
 │                     name → parsed + phonetic + nickname-canonical          │
 │                     linkedin → slug + linkedin_slug_history row            │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ Stage 1 CANDIDATES  SQL union of blocking keys · block-size cap 1,000 ·    │
 │                     ≤200 candidates/record hard cap (target avg <50)       │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ Stage 2 SCORE       Tier A deterministic ladder (slug → email-bidx →       │
 │                       registrable domain): auto-merge UNLESS identifier    │
 │                       is on the shared/cardinality-capped list             │
 │                     Tier B Fellegi-Sunter (m/u/λ trained offline via       │
 │                       Splink/DuckDB): auto-merge ≥ T_hi (+ strong id) /    │
 │                       review band / reject                                 │
 │                     EVERY scored pair → forge.match_edges (features jsonb) │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ Stage 3 CLUSTER     per-component union-find (auto-grade edges ONLY) ·     │
 │                     advisory/Redis lock on min(entity_id) · max cluster    │
 │                     100 · identifier-cardinality caps · global-vs-         │
 │                     workspace separation (overlays never auto-merged)      │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ Stage 4 SURVIVE     field-level survivorship as a pure function →          │
 │                     golden_versions (rule_version + input-set hash)        │
 ├────────────────────────────────────────────────────────────────────────────┤
 │ Stage 5 HANDOFF     entities / entity_members XREF / entity_events /       │
 │                     dated employment edges → identity graph                │
 │                     (06-identity-graph.md) → promote/sync                  │
 └────────────────────────────────────────────────────────────────────────────┘
          review band → ranked review_tasks (quality-score ranking:
          04-data-quality-framework.md) · uncertain band ≤5% of pairs →
          LLM adjudication via Haiku batch (11-ai-assisted-processing.md)
```

**Stage 0 — Normalize (at parse time, not resolve time).** Normalization outputs are written
onto silver and into `er_block_keys` in the same transaction as the parse upsert, so blocking
is a pure SQL read later. Email: one normalization (trim, lowercase, plus-tag policy decided
once) → the **unified** HMAC blind index (the F1 fix for P-01.6/P-01.14 is a prerequisite;
one key, one encoding, one normalization, forge hex migrated to main bytea). Domain: PSL
registrable domain, then the `shared_domains` table decides `shared_do_not_key` vs a
canonical mapping. Names: parse into given/family, generate a phonetic key (Double
Metaphone-class), canonicalize via `nickname_map` ("Bob"→"robert"). LinkedIn: extract the
slug; every observed slug change appends to `linkedin_slug_history` — the slug is the anchor
identifier but it is user-editable, so history is evidence, not garbage (fact pack §8.2).

**Stage 1 — SQL candidate generation.** Union of blocking keys with per-key block-size caps
and a per-record candidate cap; oversized blocks are logged for key refinement rather than
enumerated (fixes P-05.8/P-05.13):

```sql
-- Stage 1: candidates for one incoming record — union of its keys, capped
WITH keys AS (
  SELECT key_kind, key_value
  FROM forge.er_block_keys
  WHERE record_id = $1
),
sized AS (
  SELECT b.key_kind, b.key_value, count(*) AS block_size
  FROM forge.er_block_keys b
  JOIN keys k USING (key_kind, key_value)
  GROUP BY 1, 2
)
SELECT DISTINCT b.record_id
FROM forge.er_block_keys b
JOIN sized s USING (key_kind, key_value)
WHERE s.block_size <= 1000          -- cap; oversized keys → er_oversized_blocks log
  AND b.record_id <> $1
LIMIT 200;                          -- hard per-record candidate cap (target avg <50)
```

Person key families (each cheap, unioned for recall per Splink practice): `li_slug`,
`email_bidx`, `phone_bidx`, `dom` (registrable domain, skipped when shared),
`phon_family_dom` (phonetic family name + domain), `phon_full_geo` (phonetic full name +
coarse location). Company key families: `dom`, `norm_name` (legal-suffix-stripped), and
later a name-token MinHash band key. The 4-char surname prefix from `voyagerProfile.ts` is
retired — it is recall-poor and explosion-prone at corpus scale.

**Stage 2 — Two-tier scoring.** Tier A is the fixed identity hierarchy made executable:

```ts
// packages/forge-core/src/er/score.ts — Tier A (deterministic ladder)
export type TierADecision =
  | { kind: "auto_merge"; method: "li_slug" | "email_bidx" | "registrable_domain" }
  | { kind: "abstain"; reason: "identifier_shared" | "identifier_capped" | "no_key" };
```

An exact `li_slug` or `email_bidx` agreement auto-merges **unless** `identifier_stats` marks
that value shared or over its cardinality cap (then it falls through to Tier B and the value
stops being merge evidence — Segment's merge protection). `registrable_domain` auto-merges
companies only, never persons. Rule from the person-model research (fact pack §8.2): work
email agreement between records whose slugs disagree is **employment evidence, not person
evidence** — it emits a dated person↔company edge candidate (`06-identity-graph.md`), never a
person merge; conversely an email-domain change must never split a slug-matched person (the
old email demotes to historical employment).

Tier B scores the residue with the rebuilt Fellegi-Sunter core:

```ts
// packages/forge-core/src/er/config.ts
export interface FieldComparatorSpec {
  field: string;                      // "family_name" | "given_name" | "title" | ...
  comparator: "exact" | "jaro_winkler" | "phonetic" | "blind_index_exact";
  agreeAt?: number;                   // fuzzy comparators: similarity ≥ agreeAt → agree
  m: number;                          // trained offline (Splink EM); shipped as DATA
  u: number;                          // validated at load: 0 < m,u < 1 (fixes P-05.7)
  tfAdjust?: boolean;                 // per-value-frequency u shrinkage (er.ts:31-33 kept)
}

export interface ErModelConfig {
  version: string;                    // FK to forge.er_model_versions
  entityKind: "person" | "company";
  lambda: number;                     // prior P(match | candidate pair)
  fields: FieldComparatorSpec[];
  thresholds: { autoMergePosterior: number; reviewPosterior: number }; // posterior, not bits
  guardrails: {
    maxClusterSize: number;
    maxCandidatesPerRecord: number;
    maxBlockSize: number;
    identifierCardinalityCaps: Record<string, number>; // { email_bidx: 3, li_slug: 1, ... }
  };
}

export interface ScoredPair {
  a: string; b: string;               // parsed_records ids, a < b
  weightBits: number;                 // log2(λ/(1−λ)) + Σ field bits, clamped ±60
  posterior: number;                  // 1/(1 + 2^−w)
  vector: Array<{ field: string; outcome: "agree" | "disagree" | "not_compared"; bits: number }>;
  disposition: "auto_merge" | "review" | "reject";
}
```

Three outcomes, reconciled with FIXED decision #6 ("weak matches suggest, never silently
merge"): Tier-B `auto_merge` requires posterior ≥ `autoMergePosterior` **and** at least one
strong-identifier-class agreement in the vector; a purely-fuzzy pair can never exceed
`review`. Every scored pair — including rejects — persists to `forge.match_edges`.

Starting parameters (all provisional until Splink calibration; enforced-mode values gated on
a measured precision audit):

| Parameter | Shadow start | Enforced target | Rationale |
|---|---|---|---|
| λ prior | 2^−6.5 ≈ 1/90 | recalibrated per key mix | main engine's default (`fellegiSunter.ts:56-60`) |
| Tier-B auto-merge posterior | — (never in shadow) | ≥ 0.97 + strong-id agreement | PDL-style conservatism (>90% threshold, precision-first) |
| Review band | ≥ 0.80 | 0.80 – 0.97 | main engine default review floor |
| Reject | < 0.80 | < 0.80 (edge still stored) | training corpus + audit |
| Block-size cap | 1,000 | 1,000 | oversized keys refined, not enumerated |
| Candidates/record | ≤ 200 hard | avg < 50 | fact pack §8.6 target |
| Max cluster size | 100 → freeze + review | 100 | over-merge circuit breaker |
| `email_bidx` cardinality cap | 3 persons | 3 | Segment-style merge protection |
| `li_slug` cardinality cap | 1 active | 1 (conflict → review + history) | anchor identifier, user-editable |

**Stage 3 — Guarded clustering.** Union-find runs per touched component only (incremental:
re-cluster the component(s) containing the new record's auto-grade edges), in application
code, under an advisory/Redis lock keyed on the smallest entity id in the component (Apollo's
serialization pattern, fact pack §8.3/§8.5). Only `auto_merge`-grade edges participate in
transitive closure — review-band edges never chain (fixes P-05.9's welding failure mode). A
component that would exceed `maxClusterSize` freezes: no merge is applied, the component is
flagged to review, and the offending identifier is added to `identifier_stats` for demotion.
Workspace overlays are out of scope by construction — the engine operates on Forge's global
layer only; overlay records reference golden entities (FIXED decision #2), they are never
auto-merged by this engine.

**Stage 4 — Field-level survivorship.** One unified policy replacing both existing ones
(P-05.10): per field, precedence = **user-entered/pinned (protected, FIXED decision #6) →
source authority → validated → completeness → recency**, i.e. Forge's `pickSurvivor` order
(`er.ts:185-194`) with the main app's `fieldProvenance` pins grafted on top as rank 0. The
golden record is a pure function of (member records, rules, rule-version); every computation
writes `golden_versions(rule_version, input_set_hash)`; all attribute variants ever seen are
retained for future matching (Senzing practice, fact pack §8.4). Unmerge = tombstone the
discredited edge + compensating `merge_log` row + recompute the affected goldens.

**Stage 5 — Handoff.** Cluster membership and golden output land in the identity-graph
tables (`entities`, `entity_members` XREF with valid_from/to, `entity_events`, employment
edges, company hierarchy) specified in `06-identity-graph.md`; promotion and sync to
`master_*` proceed per the existing outbox contract, now carrying resolver keys and writing
`master_id_map` (closing P-01.20's mapping gap and the outbox payload-key TODO, fact pack
§6.1).

### Evidence schema (DDL sketch)

```sql
-- migration NNNN (next free index — note the 0053 journal collision, P-01.30)

CREATE TABLE forge.er_block_keys (
  record_id   uuid NOT NULL,                 -- parsed_records.id (silver)
  key_kind    text NOT NULL,                 -- 'li_slug'|'email_bidx'|'dom'|'phon_family_dom'|...
  key_value   text NOT NULL,                 -- blind-indexed wherever the raw value is PII
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_kind, key_value, record_id)
);
CREATE INDEX er_block_keys_record_idx ON forge.er_block_keys (record_id);

CREATE TABLE forge.er_model_versions (
  version      text PRIMARY KEY,             -- 'fs-person-2026-09-01'
  entity_kind  text NOT NULL,                -- 'person' | 'company'
  lambda       double precision NOT NULL,
  weights      jsonb NOT NULL,               -- per-field {m,u,comparator,agreeAt,tfAdjust}
  thresholds   jsonb NOT NULL,               -- {autoMergePosterior, reviewPosterior}
  trained_on   text,                         -- Splink/DuckDB run reference + label-set hash
  activated_at timestamptz                   -- NULL = never runnable in enforce mode
);

CREATE TABLE forge.match_edges (             -- supersedes dead match_candidates/forge.match_links
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_a      uuid NOT NULL,
  record_b      uuid NOT NULL,               -- invariant: record_a < record_b
  tier          text NOT NULL,               -- 'deterministic' | 'probabilistic'
  method        text NOT NULL,               -- 'li_slug' | 'email_bidx' | 'fs' | 'llm_adjudicated'
  weight_bits   double precision,
  posterior     double precision,
  disposition   text NOT NULL,               -- 'auto_merge' | 'review' | 'reject'
  features      jsonb NOT NULL,              -- full comparison vector + TF inputs (PII-free)
  model_version text NOT NULL REFERENCES forge.er_model_versions(version),
  decided_by    text,                        -- 'engine' | staff id (review override)
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_a, record_b, model_version) -- re-score under a new model = new row
);

CREATE TABLE forge.identifier_stats (        -- Segment-style merge protection
  key_kind     text NOT NULL,
  key_value    text NOT NULL,
  entity_count integer NOT NULL DEFAULT 0,
  is_shared    boolean NOT NULL DEFAULT false, -- past cap → demoted from merge evidence
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_kind, key_value)
);

CREATE TABLE forge.shared_domains (          -- PSL exceptions: hosters/franchises/subsidiaries
  domain    text PRIMARY KEY,
  treatment text NOT NULL,                   -- 'shared_do_not_key' | 'map_to:<canonical>'
  note      text
);

CREATE TABLE forge.linkedin_slug_history (
  slug        text NOT NULL,
  entity_id   uuid NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, entity_id, observed_at)
);
```

`merge_log` (already in 0070) is kept and finally wired: every merge writes a row; every
unmerge writes a compensating row. Dead `match_candidates` and `forge.match_links` are
dropped in the same migration (the *public* `match_links` master-graph family is untouched —
it remains the serving projection Forge confirms into, fact pack §6.1/§6.6 item 11).
Partitioning of `match_edges`/`er_block_keys` (by hash of record_a / key_kind) joins the
pg_partman work in F3 (`09-storage-strategy.md`).

### Scale evolution and build-vs-buy

- **Now → ~30M records:** everything above, all-Postgres, BullMQ-driven incremental resolve
  plus batched backfills; Splink/DuckDB sidecar for weight training and periodic full-corpus
  re-blocking QA (7M ≈ 2 min envelope, fact pack §8.1). Cost ≈ $0 marginal infrastructure.
- **30M → 100M:** backfills move to partitioned DuckDB jobs over R2 Parquet exports (or
  ephemeral Spark if operationally preferred); incremental path stays Postgres; add
  MinHash/LSH band keys and optionally pgvector ANN keys for semantic recall.
- **Buy trigger:** adopt Senzing only if measured match quality becomes revenue-blocking
  after calibration iterations — at ~$58.6K/yr (10M) vs ~0.5 FTE ongoing for the built
  engine, the build wins until quality, not cost, is the constraint (fact pack §8.1/§8.6).
  AWS ER's ~$25K per full 100M pass prices out re-runs — wrong shape for a
  continuously-resolving platform. Consolidated decision in `16-technology-recommendations.md`
  and `15-cost-optimization.md`.

## Implementation details

Dependency-ordered; all paths exact.

1. **F1 prerequisites (owned by doc 01's remediation, blocking this doc):** fix the parse FK
   break (P-01.1); persist extraction candidates (P-01.2) so scoring has fields; populate
   silver `email_blind_index`/`block_key` (P-01.3 → replaced by `er_block_keys` writes);
   unify the blind index (P-01.6/P-01.14 — one key, one encoding, one normalization, forge
   hex → main bytea); add the repeatable-job schedulers (P-01.4) that the resolve/backfill
   queues will reuse.
2. **Migration** `packages/db/src/migrations/NNNN_forge_er.sql` (next free index; the journal
   currently has two files sharing 0053 — do not repeat that, P-01.30): DDL above + `DROP
   TABLE forge.match_candidates, forge.match_links` + grants to `leadwolf_forge` only.
   Drizzle definitions in `packages/db/src/schema/forge.ts`; repositories in
   `packages/db/src/repositories/forge/erRepository.ts` (block-key upsert, candidate query,
   edge insert, identifier-stats maintenance, cluster/edge reads for review).
3. **Engine rebuild** — split `packages/forge-core/src/er.ts` into
   `packages/forge-core/src/er/{normalize,blocking,score,cluster,survivorship,config}.ts`:
   - `score.ts`: keep log2-bits + TF core; add `not_compared` → 0 bits; validate
     `0 < m,u < 1` at model load and clamp total weight ±60 bits (fixes P-05.7); thresholds
     in posterior probability; dispositions `auto_merge | review | reject` where `auto_merge`
     is emitted only under the Tier-A/strong-id rules.
   - `blocking.ts`: key-family generators (delete the 4-char surname prefix); no in-memory
     `candidatePairs` in production paths — candidates come from SQL.
   - `cluster.ts`: per-component incremental union-find + lock acquisition + guardrails.
   - `survivorship.ts`: unified precedence incl. provenance pins; `golden_versions` writer.
   - `normalize.ts`: PSL (vendored snapshot, refreshed on a schedule), `nickname_map` seed,
     phonetic keys, slug extraction/history.
4. **Worker wiring** — `apps/forge-worker/src/processors.ts`: replace the resolve
   pass-through (`processors.ts:132-136`) with Stage 1–3 execution; per-stage idempotency key
   `(record_id, model_version)` with a unique-constraint upsert so redelivery converges
   (P-01.16 discipline, `08-pipeline-architecture.md`); add `forge-er-backfill` queue
   (partitioned id-range jobs, priority lane 5) and a repeatable identifier-stats/consistency
   sweep on `forge-maintenance`.
5. **Training sidecar** — `tools/er-training/`: DuckDB + Splink v4 scripts that (a) sample
   pairs + labels from `match_edges` and review outcomes, (b) run EM, (c) emit an
   `er_model_versions` row as JSON. Never deployed to production; never pointed at production
   Postgres (Splink's PG backend is experimental). Weights ship as **data via migration/seed,
   not code**.
6. **API** — `apps/forge-api`: `POST /v1/review/match-decision` (body: edge id, decision
   `confirm | reject`, Idempotency-Key header; maker≠checker via the same four-eyes path as
   promotion once server-side per P-01.10) and `GET /bff/match-reviews` (paginated, ranked).
   RFC 9457 envelope per the F1 contract work. Console "Dedup/merge" surface (pair view with
   the bits-of-evidence waterfall from `features`, cluster browser, unmerge action) lands
   with console v2 in F3 (P-01.25).
7. **Tests** — forge itests in CI (P-01.28): grants isolation for the new tables; block-cap
   enforcement; idempotent re-resolve; over-merge guardrail (cluster freeze at cap);
   unmerge-recompute equivalence; a Forge↔master blind-index parity test that fails if the
   seam ever re-diverges; a property test that degenerate m/u are rejected at load.

## Migration strategy

1. **Shadow first (F2, weeks 1–6 of the ER slice).** `FORGE_ER_ENABLED=true`,
   `FORGE_ER_AUTOMERGE_ENABLED=false`. The engine scores everything, persists all edges and
   review candidates, merges nothing. Runs on staging/synthetic tenants first (capture stays
   dark per suite invariant 6), then over real silver as F1's pipeline fixes land. Collect:
   block-size distribution, candidates/record, disposition mix, review-band volume.
2. **Dual-run comparison.** Tier A implements the same ladder as Layer-0 `resolveForImport`
   (fact pack §6.1); run both on the same records and diff decisions. Disagreement is a
   correctness canary for normalization/blind-index drift — it must trend to zero before
   cutover.
3. **Calibrate.** Label 1–2K stratified review-band pairs (plus honeypots); train m/u/λ in
   the Splink sidecar; activate an `er_model_versions` row. The engine hard-fails enforce
   mode if no activated model exists (P-05.5 becomes structurally impossible).
4. **Enable Tier-A auto-merge** (deterministic only) once the dual-run diff is clean and
   `identifier_stats` is warmed. Then **enable Tier-B auto-merge** only after a sampled
   precision audit of would-be auto-merges reads ≥ 99.5%.
5. **Backfill.** Retro-resolve the existing corpus (silver + previously minted master
   identities) in partitioned id-range jobs; populate `master_id_map` as clusters confirm
   (closes P-01.20); company events start carrying resolver keys in the outbox payload
   (closes the §6.1 TODO).
6. **Cutover authority (the ADR-0047 one-way door, OQ-3).** Forge ER becomes the writer of
   record for `match_links` confirmations into `master_*` via the existing sync contract;
   the main `erSweep` flag is removed and `packages/core/src/er/` is deleted (F3). The HTTP
   `/api/v1/master-sync` seam stays as the future split path per S.2 #3.
7. **Rollback.** Flags off → resolve reverts to pass-through (pipeline keeps flowing;
   nothing downstream depends on ER output until Stage-5 handoff is wired). Merges are
   reversible by construction: tombstone edge + compensating `merge_log` row + golden
   recompute from surviving members. `golden_versions` pins every historical output.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Over-merge welds two real people (identity bleed; GDPR-relevant) | Medium | Critical | Tier-A-only auto-merge initially; ≥0.97 + strong-id rule for Tier B; cluster cap 100 + freeze; cardinality caps; auto-grade-edges-only closure; reversible merges + sampled precision audits |
| Under-merge leaves duplicate golden records | High | Medium | Recall measured via er-evaluation sampling; blocking-coverage monitors (share of true pairs blocked together); add MinHash/ANN keys when deterministic recall plateaus |
| Placeholder weights reach enforce mode | Medium | High | Engine refuses enforce mode without an `activated_at` model row; CI test asserts it |
| Splink Postgres backend instability | Certain (it is experimental) | Low | Splink runs only offline in the DuckDB sidecar; production scoring is our own TS/SQL |
| Shared identifiers (info@, agency emails, hosted domains) poison clusters | High | High | `identifier_stats` caps + `shared_domains` blocklist + demotion to non-evidence (Segment pattern) |
| LinkedIn slug edited/recycled | Medium | Medium | `linkedin_slug_history`; slug conflicts → review, never silent re-bind; slug is high-trust, not infinite-trust |
| Blind-index seam re-diverges after unification | Medium | Critical | Single shared implementation (S.2 #2) + permanent parity itest in CI |
| Union-find races under concurrent resolves | Medium | High | Advisory/Redis lock per component (min entity id); per-stage idempotency keys |
| Backfill cost/time balloons at 30M+ | Medium | Medium | Partitioned DuckDB/Spark backfill path; R2 zero-egress makes re-reads free (`09-storage-strategy.md`) |
| One-way door regret (master_* as projection) | Low | High | Ratify ADR-0047 explicitly; `master_id_map` + reversible merges keep a re-projection path |
| Review queue overwhelms humans | Medium | Medium | Thresholds tuned to ≤1% of pairs; ranked queue (04) ; LLM adjudication of the uncertain band caps human load (11) |

## Success metrics

- **Precision:** ≥ 99.5% on quarterly stratified audits of auto-merged pairs
  (er-evaluation-style cluster sampling); zero confirmed cross-person merges reaching
  `master_*` without a reversal path exercised in test.
- **Recall / dedup effect:** duplicate rate among sampled golden persons < 1%; ingest-time
  dedup ratio ≈ 4:1 at steady state (scale model, fact pack §2.5).
- **Blocking efficiency:** mean candidates/record < 50, p99 block size ≤ 1,000, pair
  comparisons within 0.05–1% of the cartesian bound (NFR, fact pack §2.5).
- **Human load:** review-band routing ≤ 1% of scored pairs, absolute volume within the
  5–15K/day human ceiling; review SLA p95 < 72h.
- **Freshness SLO:** 95% of newly parsed records resolved (edges written, cluster updated)
  within 10 minutes at steady state; `forge_er_oldest_unresolved_seconds` exported and
  alerting (`12`-doc metrics catalog).
- **Evidence invariant:** 100% of merges carry a `match_edges` row and a `merge_log` row —
  enforced by a reconciliation sweep that pages on violation; every golden has a
  `golden_versions` row reproducible from inputs (recompute equivalence test in CI).
- **Cost ceilings:** ER incremental compute rides existing Postgres/BullMQ (< $100/mo
  marginal at 10M records); LLM adjudication ≤ $1K/mo hard budget cap (Haiku batch ≈
  $0.5–1/1K pairs, `11-ai-assisted-processing.md`); no full-corpus pass costing more than
  ~$50 in sidecar compute below 30M records.

## Effort & priority

Priority is **P1 in phase F2** because ER v1 is the F2 centerpiece (S.1) and cannot start
until F1's P0 prerequisites land (parse FK, extraction persistence, silver keys, unified
blind index, schedulers — all doc-01 items); the *decision* itself (one engine, ADR-0047
ratified) is P0-adjacent and should be taken now, while both engines are dark and deletion is
free. Effort: ~14–20 eng-weeks for the ER engine proper on the 2–3-engineer pod — Stage 0–2
(normalization assets, blocking SQL, rebuilt scorer, edge persistence) ≈ 5–6 wks; Stage 3–4
(guarded clustering, survivorship, unmerge) ≈ 4–5 wks; training sidecar + calibration ≈
2–3 wks; review API + itests + shadow/dual-run operation ≈ 3–4 wks. This sits inside the
research agent's 1–2 engineers × 3–6 months envelope for ER-plus-identity-graph, with the
graph storage share costed in `06-identity-graph.md`; expect ~0.5 FTE ongoing stewardship
(fact pack §8.6).

## Future enhancements

- **Embedding-ANN blocking** (pgvector key family) for semantic recall on titles/company
  names once deterministic + phonetic + MinHash keys plateau (fact pack §8.1).
- **Active-learning ER** (planning doc 20's E3): review outcomes and honeypots feed
  continuous weight retraining; fine-tune a small matcher when LLM adjudication spend
  exceeds ~$1–2K/mo and 10K+ labels exist (fact pack §11.2).
- **LLM adjudication expansion** beyond the uncertain band — e.g. company-name conflicts,
  cross-language names — governed by the cascade and budgets in
  `11-ai-assisted-processing.md`.
- **Company hierarchies** seeded from GLEIF Level 2 / Companies House bulk, modeled as
  `parent_company_id` / `ultimate_parent_id` in the identity graph
  (`06-identity-graph.md`); D&B family trees only if a commercial gap is proven.
- **Bloom-filter PPRL** for matching third-party hashed feeds without cleartext exchange —
  noting the frequency-cryptanalysis caveat (fact pack §8.2).
- **Graph database layer** (Apache AGE first) only if multi-hop product features (org-chart
  traversal) materialize — never for ER itself (fact pack §8.3).
- **Senzing adoption** as the pre-negotiated fallback if two calibration cycles fail to hit
  the precision/recall bar — the evidence schema above is engine-agnostic, so the buy path
  swaps the scorer, not the pipeline.
