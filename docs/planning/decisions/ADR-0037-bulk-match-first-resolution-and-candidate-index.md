# ADR-0037 — Bulk match-first resolution & candidate index

- **Status:** Accepted
- **Date:** 2026-06-17
- **Context doc:** [30-bulk-csv-enrichment.md](../30-bulk-csv-enrichment.md), [06-enrichment-engine.md](../06-enrichment-engine.md), [03-database-design.md](../03-database-design.md)
- **Amends:** [ADR-0015](./ADR-0015-entity-resolution-dedup-engine.md) (the Splink dedup engine now also backs the **bulk fast-path** matcher — a synchronous, candidate-indexed read of the *resolved* master graph, not a batch re-resolution)
- **Extends:** [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) (bulk rows match against the **Layer-0 global master graph** and the **Layer-1 workspace overlay** through a `MatchPort`; the master-graph matcher is **infra-gated** on the same Citus/OpenSearch/Spark scale track ADR-0021 stages at M12/M13)
- **Sibling ADRs:** [ADR-0036](./ADR-0036-bulk-enrichment-pipeline.md) (bulk pipeline / ingest → match → enrich → export), [ADR-0038](./ADR-0038-bulk-billing-and-quota.md) (bulk billing / quota — only `matched_provider` rows spend credits)

## Context

The bulk CSV enrichment product ([30](../30-bulk-csv-enrichment.md)) takes a sparse customer CSV
(sometimes just *name + company*, or *email* alone) and enriches **every row**, at enterprise scale, with a
promised experience of *"a fraction of a minute"* for files we can answer internally. The naïve
implementation — fan every row out to the provider waterfall ([06 §4](../06-enrichment-engine.md)) — is both
**slow** (network round-trips per row, provider rate limits) and **expensive** (every row burns provider
spend, even rows we already hold a verified golden record for).

We already own the answer for most rows. [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md) built a
**two-layer** model: a globally entity-resolved **Layer-0 master graph** (`master_persons`,
`master_companies`, `master_emails`, `master_phones`, `master_employment`) and a **Layer-1 per-workspace
overlay** (the workspace's own `contacts`/`accounts`). [ADR-0015](./ADR-0015-entity-resolution-dedup-engine.md)
(amended by ADR-0021) resolves that graph with **deterministic keys → blocking + MinHash/LSH → Splink → 
survivorship**, and [06 §9](../06-enrichment-engine.md#9-data-quality--verification) specifies the normalize →
deterministic-match → blocking/LSH → Splink → cluster/survivorship pipeline plus a **low-confidence → manual
review queue**. What neither ADR specifies is **how a bulk import row matches *into* that already-resolved
universe synchronously**, on the read path, so internal hits never touch a provider.

Industry match rates set the expectation that internal matching carries most of the load (cite as
*approximate industry figures — Apollo/ZoomInfo-class — not a LeadWolf promise*): roughly **70–85% on email**,
**50–65% on phone**, **85–95% on company**. If even a large fraction of rows resolve internally, the bulk job
finishes fast and cheap, and only the residual misses cost provider money ([ADR-0038](./ADR-0038-bulk-billing-and-quota.md)).

Forces in play:

- **Latency** — internal matches must be **instant** (indexed read), not a batch ER run.
- **Cost** — provider spend only on rows we genuinely cannot answer internally.
- **Consistency** — bulk matching must use the **same normalization and the same match keys** as the global
  ER pipeline ([06 §9](../06-enrichment-engine.md#9-data-quality--verification)), or a row could "miss" in
  bulk yet "match" in batch (drift).
- **Infra timing** — the Layer-0 master graph at scale (Citus / OpenSearch / S3+Iceberg+Spark) is **staged at
  M12/M13** ([10](../10-roadmap.md), [ADR-0021](./ADR-0021-global-master-graph-and-overlay.md)); the bulk
  product ships **before** that infra is fully live, so the master-graph matcher must be a **seam now, real
  later**.

## Decision

Bulk rows resolve **match-first** through a single port, **`MatchPort`**
(`packages/core/src/enrichment/bulk/matchPort.ts`), in a strict, short-circuiting order. The first stage that
returns a confident match wins; only rows that fall through every internal stage reach the provider waterfall.

**Resolution order (per row):**

1. **Workspace overlay deterministic match** (`overlayMatcher.ts` — **real now**). Blind-index / exact match
   of the normalized keys against the calling workspace's Layer-1 overlay (`(workspace_id,
   email_blind_index)`, `linkedin_public_id`, normalized phone, registrable domain → account). **Free and
   instant** — the workspace already owns this record. Outcome `matched_internal`.
2. **Global master-graph Layer-0 candidate match** (`masterGraphMatcher.ts` — **stub now, real when the scale
   infra lands**). Resolve the normalized keys against the *already-resolved* master graph:
   - **Deterministic KV lookup** (email blind index / registrable domain / E.164 phone / LinkedIn id) in
     **Redis** — the ~95% common case, O(1).
   - **Blocking + MinHash/LSH candidate generation** against the resolved golden set (never a billions² scan),
     then a **Splink** fuzzy-tail score for `fuzzy_name_company`.
   This reuses the *output* of the ADR-0015/0021 ER pipeline — it is a **read against resolved clusters**, not
   a re-resolution. **Free and instant** (no provider spend). Outcome `matched_internal`. Because the
   billions-scale candidate index (Citus golden store + OpenSearch + Spark-built LSH blocks) is **infra-gated
   on the M12/M13 scale track**, this matcher ships **now as a stub behind `MatchPort`**: it returns
   `unmatched` (falls through to stage 3) until the scale infra is live, at which point the real implementation
   drops in **with no caller change** (the seam pattern, like `SearchPort` / `ProviderPort`).
3. **Provider waterfall on residual misses only** (existing [06 §4](../06-enrichment-engine.md) waterfall via
   `ProviderPort`). Only rows that missed both internal layers fan out to paid providers, ordered by
   trust ÷ cost with circuit breakers. A provider hit is `matched_provider` (the **only** outcome that spends
   credits — [ADR-0038](./ADR-0038-bulk-billing-and-quota.md)); a provider miss is `unmatched`.

**Canonical normalization (shared with [06 §9](../06-enrichment-engine.md#9-data-quality--verification), identical to the global ER pipeline):**

- **Email** → lowercased, plus-addressing stripped, then **blind-indexed**.
- **Domain** → **registrable domain** via the **Public Suffix List**.
- **Phone** → **E.164** via **libphonenumber**.
- **Name** → canonicalized; **LinkedIn** → public id.

**Canonical enums (shared across the bulk units — keep EXACT):**

- `match_method`: `deterministic_email` | `deterministic_linkedin` | `deterministic_phone` |
  `deterministic_domain` | `fuzzy_name_company` | `provider` | `none`.
- `match_outcome`: `matched_internal` | `matched_provider` | `unmatched` | `suppressed` | `error`.

**Match confidence & manual review.** Every match carries a confidence. Deterministic-key hits (stages 1 and
the Redis KV part of stage 2) are confidence `1.0`. The Splink fuzzy tail (`fuzzy_name_company`) carries a
probability; a configurable **review threshold** splits it into auto-accept vs. **low-confidence → manual
review**, consistent with the master-graph manual-review queue in
[06 §9](../06-enrichment-engine.md#9-data-quality--verification). Below the accept threshold a row is **not**
silently merged or sent to a provider as if matched — it is flagged for review. Suppression/consent gates
([08](../08-compliance.md)) apply at match time: a suppressed identity yields `suppressed`, never a billed
reveal.

**Port placement.** `MatchPort` and its two implementations live under `packages/core/src/enrichment/bulk/`:
`matchPort.ts` (contract), `overlayMatcher.ts` (real now), `masterGraphMatcher.ts` (stub now, real when scale
infra lands). The bulk pipeline ([ADR-0036](./ADR-0036-bulk-enrichment-pipeline.md)) calls `MatchPort`; billing
([ADR-0038](./ADR-0038-bulk-billing-and-quota.md)) reads the `match_outcome`. New milestone **M17**.

## Rationale

**Match-first is what makes bulk fast and cheap.** Internal matches are an **indexed read of data we already
own** — no network, no provider rate limit, no spend — so a file that resolves mostly internally finishes in
"a fraction of a minute," and only the genuine residual reaches paid providers. This directly serves the
[30](../30-bulk-csv-enrichment.md) product promise and the [ADR-0038](./ADR-0038-bulk-billing-and-quota.md)
unit economics.

**Reusing the resolved graph, not re-resolving, is the key specialization.** ADR-0015/0021 run ER as a
**batch** that *produces* golden clusters; bulk matching is a **synchronous read** of those clusters via a
candidate index (Redis KV for deterministic keys, LSH blocks + Splink for the tail). Sharing the **exact same
normalization and match keys** ([06 §9](../06-enrichment-engine.md#9-data-quality--verification)) guarantees a
bulk row and a batch row resolve identically — no drift. This is why this ADR **amends** ADR-0015 (same engine,
new read-path role) and **extends** ADR-0021 (same two layers, new bulk entry point) rather than introducing a
parallel matcher.

**The port + stub keeps us shippable before the scale infra.** The master-graph candidate index needs the
Citus/OpenSearch/Spark track ADR-0021 stages at **M12/M13**. Hiding the matcher behind `MatchPort` lets bulk
ship **now**: `overlayMatcher` is fully real, `masterGraphMatcher` is a stub that falls through to providers,
and the real master-graph matcher lands later with **zero caller change** — the same swappable-seam discipline
as `SearchPort` ([ADR-0035](./ADR-0035-search-query-and-filter-architecture.md)) and the `ProviderPort`
waterfall.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Match-first via `MatchPort`: overlay → master-graph candidate index → provider residual (this ADR)** | Chosen | Internal hits are free + instant (most rows); providers billed only on residual; reuses the ADR-0015/0021 resolved graph + identical keys (no drift); stub seam ships before the M12/M13 scale infra. |
| **Provider-first** (call the waterfall for every row) | Rejected | Slow (per-row network + rate limits) and expensive (every row burns provider spend even when we already own a verified golden record) — defeats the [30](../30-bulk-csv-enrichment.md) speed/cost promise. |
| **Batch re-resolution** (run the full Splink ER pipeline over the upload) | Rejected | The ADR-0015/0021 batch ER is minutes-to-hours and built for full-universe dedup; bulk needs a **synchronous read** of the *already-resolved* graph, not a fresh resolution per upload. |
| **Overlay-only matching** (skip the master graph; overlay then provider) | Rejected | Throws away the shared Layer-0 universe — the very asset ADR-0021 built; most "find-anyone" rows live in the master graph, not a given workspace's overlay. Equivalent to **today's stub behaviour**, accepted only until the scale infra lands. |
| **Build a separate bulk-only matcher** (new keys/normalization) | Rejected | Two normalizers = drift: a row could miss in bulk yet match in batch. Sharing [06 §9](../06-enrichment-engine.md#9-data-quality--verification) keys is mandatory. |

## Consequences

- **Positive:** internal matches are **free and instant**, so internally-answerable files finish in a fraction
  of a minute; provider spend is confined to true residual misses ([ADR-0038](./ADR-0038-bulk-billing-and-quota.md));
  one normalization/key set shared with the global ER pipeline (no bulk-vs-batch drift); the master-graph
  matcher is a **swappable seam**, so bulk ships before the M12/M13 scale infra and upgrades with no caller
  change.
- **Negative (consciously accepted):** until the scale infra lands, `masterGraphMatcher` is a **stub** — rows
  that *would* hit Layer-0 currently fall through to providers, so early bulk match-rate (and cost) is closer
  to provider-first for non-overlay rows; the candidate index (Redis KV + LSH blocks) is a real maintenance
  surface once live; the fuzzy tail needs per-dataset **review-threshold tuning**
  ([06 §9](../06-enrichment-engine.md#9-data-quality--verification) open question).
- **Mitigation:** the **overlay matcher is real from day one** (workspace-owned rows are free immediately); the
  stub falls through **safely** to the proven provider waterfall (no correctness regression, only a cost/speed
  one for Layer-0-only rows); low-confidence fuzzy matches route to the existing **manual review queue** rather
  than auto-merging or auto-billing; the candidate index is built by the **same Spark/Iceberg ER track**
  ([ADR-0021](./ADR-0021-global-master-graph-and-overlay.md)) already planned for M12/M13, not new infra.

## Revisit if

- The **scale infra (Citus/OpenSearch/Spark) lands** — promote `masterGraphMatcher` from stub to the real
  candidate-indexed implementation (the seam's purpose).
- Synchronous Splink scoring on the fuzzy tail proves too slow for the bulk latency target — precompute more
  of the tail offline, or tighten the deterministic-only fast path and route fuzzy candidates to async review.
- Match confidence / review-threshold tuning shows internal matches degrading data quality — recalibrate
  thresholds with the global ER pipeline ([06 §9](../06-enrichment-engine.md#9-data-quality--verification)),
  keeping bulk and batch in lockstep.
