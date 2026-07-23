# 15 — Cost Optimization

> **Priority:** P1 · **Effort:** 4–6 eng-weeks · **Phase:** F1–F2
> (phases are defined in 17-phased-implementation-roadmap.md)

## Executive summary

This document is the FinOps model for Forge: what every component costs at each scale tier, what
to build versus buy, and how spend is bounded per tenant. The thesis, stated up front and defended
with numbers throughout: **buy nothing heavyweight, and spend the savings on compliance.** The
avoided-cost inventory of the heavyweight buys this audit rejects — Senzing ($58,560/yr at 10M
records), AWS Entity Resolution ($25K per full 100M-record pass), Tamr ($250K+/yr, unverified),
self-hosted Temporal (est. $30–54K/yr infra plus SRE labor), a self-hosted data catalog (≥0.5 FTE),
managed search and managed observability — sums to roughly $200–500K/yr at enterprise scale. The
entire recommended governance and quality program costs ~10–14 eng-weeks of build plus ~$6.5–7K/yr
in data-broker registration fees and a $10–30K one-time legal engagement (fact pack §9.8), which is
where sales-intelligence vendors actually die (see 07-data-governance.md). The three most important
findings: (1) Forge's AI extraction is metered but **token spend is never recorded** — the
`extraction_runs` table has `latency_ms`/`input_tokens`/`output_tokens`/`cached_tokens` columns and
the Anthropic port returns three of the four (all but `cached_tokens`), but the metering row omits them
(packages/db/src/schema/forge.ts:159-162; packages/forge-core/src/extraction.ts:283-303), so unit
economics are unmeasurable and the Anthropic invoice is unreconcilable; (2) the AI "budget" is an
`inMemoryBudgetStore` instantiated per worker process (apps/forge-worker/src/processors.ts:103) —
it resets on restart and is keyed per-capture, so there is **no real per-tenant/day cap** on the
one component the planning suite itself names as a hard cost ceiling (P-01.21); (3) the main app
already ships exactly the FinOps machinery Forge needs — `provider_calls.cost_micros`, a
request-hash cache that answers with "no call and no cost", and an advisory-locked daily-budget
breaker (packages/core/src/enrichment/enrichContact.ts:122-141) — and Forge reuses none of it
(P-01.31). The headline recommendation: record spend and enforce a durable per-tenant/day budget in
**F1**; adopt the deterministic-first cascade + Batch API + prompt caching + content-hash result
cache to land blended extraction at **$500–1,500 per million records** (versus $5,500/1M naive
Haiku sync); tier raw storage onto Cloudflare R2 at $15/TB with zero egress; and monitor the
build-vs-buy triggers quarterly so every "buy" happens at its trigger, not under pressure.

## Current state

### What Forge spends today, and what it records

- **The only live spend path is AI extraction, and it buys nothing.** The extract stage invokes the
  real Anthropic adapter (packages/integrations/src/forgeAnthropicExtraction.ts) with the **full
  raw payload** as residue (apps/forge-worker/src/processors.ts:108), then **discards the returned
  candidate fields** (processors.ts:112-127; P-01.2). Every capture that reaches S2 pays for
  extraction regardless of whether the deterministic parser already succeeded — the design's
  "AI only on unstructured residue, ~10% of parsed" routing (fact pack §2.1) is not implemented.
  Because the extract handler is non-idempotent, every BullMQ retry or redelivery re-bills
  Anthropic and duplicates the metering row (P-01.16).
- **Token spend is never recorded.** `forge.extraction_runs` carries `latency_ms` (schema/forge.ts:159),
  `input_tokens` (:160), `output_tokens` (:161), and `cached_tokens` (:162); the port returns these
  values, but `runExtraction`'s metering row never populates them
  (packages/forge-core/src/extraction.ts:283-303; fact pack §3.2). There is no `cost_micros`
  column at all. The org cannot answer "what did extraction cost yesterday, per tenant, per model"
  from its own database.
- **The budget is not a control.** The production budget store is `inMemoryBudgetStore()`
  constructed inside the processor module (apps/forge-worker/src/processors.ts:103): per-process,
  reset on every restart, keyed `rawCaptureId:tenantId` — i.e., per-capture, not per-tenant/day —
  with a limit of 1,000 units (fact pack §3.3; P-01.21). Four ai-extract workers on one process
  share it; a second replica doubles the effective budget silently.
- **One correct default exists:** the extraction model defaults to Haiku 4.5
  (`claude-haiku-4-5-20251001`, packages/config/src/forge.ts:57) — the cheapest current-generation
  model — via the env-var `FORGE_EXTRACT_MODEL`. But that config file reads bare `process.env`,
  bypassing the validated `appEnvSchema` (P-01.29), so a typo'd model id is discovered at runtime
  as API errors, not at boot.
- **Infra cost surface is unbounded in three places:** forge services have **no CPU/memory
  limits** in the compose file while api/auth do (fact pack §4.4) — the Anthropic-spending worker
  is unbounded on the shared single VM; no forge queue sets `removeOnComplete`/`removeOnFail`, so
  Redis grows without bound (P-01.17); and `review_tasks` is inserted but never claimed, resolved,
  or closed — an unbounded open queue (fact pack §3.2).
- **Storage economics today:** raw payloads ≤8KB are stored inline as plaintext `text` in Postgres;
  >8KB goes to S3-compatible object storage via `Bun.S3Client`
  (packages/integrations/src/forgeObjectStore.ts; fact pack §3.3). At the design payload profile
  (p50 6KB), the bulk of bronze lands in Postgres text columns — the most expensive, least
  replayable place to keep it (TOAST amplification and backup blowup; fact pack §7.3, §7.5;
  see 09-storage-strategy.md).
- **No cost observability of any kind:** `/metrics` emits static gauges only, forge-api logs
  nothing (P-01.27); there is no $/1K-records number, no per-tenant spend view, no budget-burn
  alert anywhere.

### The FinOps machinery the main app already has (and Forge ignores)

The platform's FIXED decision #7 — "enrichment is metered & cached; never pay twice; per-tenant
quotas" — is implemented and hardened on the main enrichment path:

- **Metering:** every provider attempt persists `cost_micros`, which "aggregates into the daily
  budget breaker" (packages/db/src/repositories/providerCallRepository.ts:3).
- **Cache-first:** `enrichContact` checks a persisted request-hash cache before any paid call and
  returns `{ status: "cache_hit", …, costMicros: 0 }` on a hit
  (packages/core/src/enrichment/enrichContact.ts:122-125).
- **An atomic daily budget breaker:** `lockDailyBudget` takes an advisory transaction lock per
  workspace to serialize the check-through-record window (providerCallRepository.ts:74), then
  `spendSince(startOfUtcDay())` is compared to `env.ENRICH_DAILY_BUDGET_MICROS` — default
  50,000,000 µ$ = **$50/workspace/day** (packages/config/src/env.ts:161) — throwing
  `ProviderBudgetExceededError` before any spend (enrichContact.ts:127-141). The comment history
  records that the naive read-check-act version raced and was fixed (providerCallRepository.ts:65-74).
- **AI request accounting:** the main Anthropic seam persists `ai_requests` rows per call
  (packages/db/src/schema/aiRequests.ts; ADR-0023, fact pack §2.3).

Forge duplicated the Anthropic adapter and the rate limiter but not the cost controls — one more
instance of the fourteen dual stacks (P-01.31; see 16-technology-recommendations.md).

### What the planning suite intended (intent, not reality)

The frozen corpus (docs/planning/forge/, through 2026-07-06) is explicit that cost is a first-class
constraint: the scale model names **two hard ceilings — ai-extract spend and human review** — at
0.5M→5M AI calls/day across the baseline→stress range (fact pack §2.1 doc 17); the AI design
specifies deterministic-first routing with AI touching only ~10% of parsed records, a re-keyed
per-job/per-tenant `budgetGuard`, `extraction_runs` metering, a 24h prompt cache, and tiered
models with fallback (fact pack §2.1). None of the cost-bearing parts of that intent survived into
the build except the metering table's (unpopulated) columns and the Haiku default.

## Problems identified

- **P-15.1 — BUG · Token spend is never recorded.** The port returns latency and token counts;
  the metering row omits them (packages/forge-core/src/extraction.ts:283-303) even though the
  columns exist (packages/db/src/schema/forge.ts:159-162), and no `cost_micros` column exists at
  all. At enterprise scale this means no invoice reconciliation, no unit economics, no per-tenant
  COGS, and no data to calibrate the cascade. Sibling of P-01.21.
- **P-15.2 — RISK · There is no real per-tenant/day spend cap.** `inMemoryBudgetStore` at
  apps/forge-worker/src/processors.ts:103 is per-process, resets on restart, and is keyed
  per-capture (fact pack §3.3). The component the design names as a hard cost ceiling has no
  durable brake; a runaway producer or a retry storm can spend without bound until a human notices
  the Anthropic bill (P-01.21).
- **P-15.3 — BUG · Every dollar spent today buys zero data.** Extraction output is discarded
  (P-01.2) and retries re-bill (P-01.16) — the current pipeline's marginal AI cost per useful
  record is literally infinite. Any cost model must first assume F1 fixes these.
- **P-15.4 — GAP · No deterministic-first routing.** S2 sends the full raw payload to Anthropic
  for every capture (processors.ts:108) instead of the residue-only routing the design specifies —
  a ~5–10× cost multiplier versus the intended ~10% AI share (fact pack §2.1, §11.2).
- **P-15.5 — GAP · No content-hash result cache.** Re-captures, retries, and identical payloads
  from different tenants re-pay full price. The main app's request-hash "no call and no cost"
  pattern (enrichContact.ts:122-125) is the exact template and is unused in Forge — a FIXED
  decision (#7: never pay twice) not applied to the newest paid path.
- **P-15.6 — GAP · Neither the Batch API nor prompt caching is used.** The adapter makes
  synchronous single-shot calls, forgoing a flat 50% batch discount and 0.1× cached-input reads
  that stack (fact pack §11.2) — paying roughly 2–3× the achievable rate for work that is
  overwhelmingly latency-insensitive backfill.
- **P-15.7 — DEBT · Bronze lives in Postgres text columns.** Inline plaintext payloads in the
  most expensive storage tier, multiplied through WAL, backups, and TOAST (fact pack §7.3), when
  R2 costs $15/TB with zero egress and makes replay free (fact pack §7.5; 09-storage-strategy.md).
- **P-15.8 — GAP · No per-tenant metering or usage events.** `extraction_runs.target_tenant_id`
  exists (schema/forge.ts:150) but nothing rolls spend up per tenant/day; tenant attribution
  disappears after bronze for every other cost driver (P-01.23). Per-tenant quotas — a FIXED
  platform decision — cannot be enforced or even displayed without this.
- **P-15.9 — RISK · Unbounded infra growth on the shared VM.** No resource limits on forge
  services (fact pack §4.4), unbounded Redis job retention (P-01.17), and an unbounded open
  `review_tasks` queue (fact pack §3.2) all grow until they degrade the co-tenant main platform —
  a cost problem that presents as an availability problem.
- **P-15.10 — GAP · Zero cost observability.** No spend metrics, no $/1K-records series, no
  budget-burn alerts, no per-model breakdown (P-01.27). FinOps' first phase — inform — is
  impossible; every optimization in this document is unverifiable until this exists.

## Research findings

### Anthropic pricing and extraction cost math (verified 2026-07-22)

Prices from the platform docs ([Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
verified against the console 2026-07-22; fact pack §11.2), $/MTok input/output:

| Model | Input | Output | Role in the cascade |
|---|---|---|---|
| Fable 5 | $10 | $50 | Never for bulk — frontier reasoning only |
| Opus 4.8 | $5 | $25 | Evals + adjudication of uncertain ER pairs only |
| Sonnet 5 (intro) | $2 | $10 | Escalation tier — **intro pricing ends 2026-08-31 → $3/$15** |
| Sonnet 4.6/4.5 | $3 | $15 | Alternative escalation tier |
| Haiku 4.5 | $1 | $5 | The workhorse — already Forge's default (config/src/forge.ts:57) |

- **Batch API: flat 50% off** all token prices; up to 100K requests or 256MB per batch, results
  typically <1h, retained 29 days
  ([Batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing)).
- **Prompt caching: cache reads 0.1×** base input price (5-minute-TTL writes 1.25×, 1-hour writes
  2×), and **it stacks with the batch discount**
  ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
- **Tokenizer caveat:** Opus 4.7+/Sonnet 5/Fable 5 tokenize ~30% more tokens for the same text
  than earlier models — budgets must be re-baselined with `count_tokens`, not extrapolated
  (fact pack §11.2).
- **Per-record math** at the audit's standard assumption (3K input / 500 output tokens per
  record, batch): Haiku 4.5 ≈ **$2,750/1M records** ($0.00275/record); Sonnet 5 intro ≈
  $5,500/1M; Opus 4.8 ≈ $13,750/1M (adjudication/evals only); Fable 5 ≈ $27,500/1M (arithmetic on
  the verified prices — never for bulk). With a cached 2K-token static prefix (system prompt +
  schema + few-shot), the Haiku batch figure falls a further ~30–35% (cache reads at 0.1× of the
  batch input rate — arithmetic). **Blended with a deterministic layer handling 60–80% of records
  at $0, total extraction lands at $500–1,500/1M records**; a content-hash result cache makes
  re-captures **$0** (fact pack §11.2).

### Object storage economics

- **Cloudflare R2:** $15/TB-mo Standard, $10/TB-mo Infrequent Access, **zero egress fees** —
  reprocessing and backfills over the archive are free
  ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).
- **Backblaze B2:** $6.95/TB-mo — the cheap second copy/backup target
  ([B2 pricing](https://www.backblaze.com/cloud-storage/pricing)).
- **AWS S3:** ~$23/TB-mo Standard **plus ~$90/TB egress**
  ([S3 pricing](https://aws.amazon.com/s3/pricing/)); S3 Glacier Deep Archive ≈ $1/TB-mo for
  7-year compliance cold copies ([storage classes](https://aws.amazon.com/s3/storage-classes/)).
- **The comparison that decides it:** a 50TB raw archive with one monthly full re-read ≈
  **$750/mo on R2 versus ~$5,650/mo on S3** (storage + egress) — ~$59K/yr avoided by the zero-egress
  choice alone (fact pack §7.5). A replay-heavy pipeline (reparse on every parser version bump) is
  exactly the egress-dominated workload.
- **Do not self-host object storage:** MinIO's community console was stripped in May 2025 and the
  AGPL community edition entered maintenance mode in December 2025 (fact pack §7.5; see
  09-storage-strategy.md for sourcing) — if DPDP residency ever forces self-hosting, SeaweedFS or
  Garage are the candidates, not MinIO.

### OLAP / telemetry

- **Self-hosted single-node ClickHouse:** ≈ $200–400/mo at <10GB/day ingest (research estimate);
  3-node HA ≈ $1,070/mo; 4–8h/wk ops (fact pack §7.4). Compression 10–20× is routine — Cloudflare
  reported ~600B→60B per record for HTTP analytics
  ([Cloudflare on ClickHouse](https://blog.cloudflare.com/http-analytics-for-6m-requests-per-second-using-clickhouse/)).
  Billions of capture-event rows ≈ low hundreds of GB. PG→CH replication is solved by PeerDB
  (acquired by ClickHouse 2024-07, still free OSS; fact pack §7.4).
- **MotherDuck repriced upmarket ($250/mo+);** self-hosted DuckDB over R2 Parquet is the $0
  ad-hoc-analytics path (fact pack §7.2).

### Entity-resolution build-vs-buy market

- **Splink v4 (MoJ, free OSS):** 7M records ≈ 2min/<$1 on a high-spec EC2 node; 100M+ via
  Spark/Athena backends; the Postgres backend is experimental — train weights offline in a
  DuckDB sidecar ([Splink](https://github.com/moj-analytical-services/splink); fact pack §8.1).
- **Senzing:** the only serious embeddable buy — **$58,560/yr at 10M records** (vendor list
  pricing; free ≤100K; extrapolates to six figures at 100M+)
  ([Senzing pricing](https://senzing.com/pricing/)).
- **AWS Entity Resolution:** $0.25/1K records processed ≈ **$25K per full 100M-record pass** —
  and reprocessing (which this pipeline does routinely) pays it again
  ([AWS ER pricing](https://aws.amazon.com/entity-resolution/pricing/)).
- **Tamr:** $250K+/yr (unverified vendor folklore; fact pack §8.1).
- **Build cost for the recommended engine:** 1–2 engineers × 3–6 months to production quality,
  ~0.5 FTE ongoing (fact pack §8.6; see 05-entity-resolution.md).

### Search cost ladder

Engineered Postgres FTS costs $0 to ~10M records; ParadeDB pg_search adds BM25 in-database for
roughly +$100–300/mo of instance headroom, no sync pipeline (vendor benchmark: ranking at 28M rows
6.28ms, ~265× native FTS — validate on own workload;
[ParadeDB benchmark](https://www.paradedb.com/blog/elasticsearch_vs_postgres)); self-hosted 3-node
OpenSearch at 30–50M+ records ≈ $150–400/mo + ~0.25 FTE ops (fact pack §11.1; see
10-search-indexing.md).

### Orchestration cost

Temporal Cloud starts at $100/mo + $50 per million actions
([Temporal pricing](https://temporal.io/pricing)) — at pipeline scale (tens of millions of stage
transitions/month if modeled as actions) that is $1–5K+/mo, and self-hosting is estimated at
$2.5–4.5K/mo infra plus SRE labor (single-source estimate; fact pack §10.3). Hatchet (MIT,
Postgres-backed; verified benchmarks 2K runs/s on 8-vCPU RDS —
[Hatchet](https://github.com/hatchet-dev/hatchet)) and DBOS Transact (a library checkpointing to
existing Postgres — [DBOS](https://www.dbos.dev/)) are $0-license self-host fits when the durable-
workflow trigger hits. BullMQ Pro — the one cheap buy worth flagging — is ~$95/mo intro
($995–1,395/yr) and includes groups, the per-tenant-fairness primitive
([taskforce.sh](https://taskforce.sh/); fact pack §10.2–10.3).

### Catalog / lineage

DataHub self-host needs Kafka + MySQL/PG + Elasticsearch, >7GB RAM, ≥3 nodes; OpenMetadata is
lighter; **any self-hosted catalog ≈ 0.5–1 FTE** ([DataHub](https://datahubproject.io/),
[OpenMetadata](https://open-metadata.org/); fact pack §9.3). The audit's verdict: skip both; a
per-field provenance table doubles as the GDPR Art. 14(2)(f) source-disclosure and DSAR data map
(07-data-governance.md).

### Verification and compliance spend

Email verification is pennies: 4-step verification (syntax→MX→SMTP→risk) catches 95–99% of
invalid addresses (fact pack §9.4); bulk per-check vendor list prices are on the order of
$0.5–4 per 1,000 checks (vendor pricing, unverified) — trivially affordable next to AI extraction,
and cache-forever semantics apply (a verified state has a half-life, not a re-price). Compliance
spend is small and mandatory: CA Delete Act registration $6,000 for 2026 (annual, due Jan 31;
[CPPA data-broker registry](https://cppa.ca.gov/data_broker_registry/)), TX $300, VT $100, plus OR
— ≈ **$6.5–7K/yr in fees**, plus $10–30K one-time counsel and 3–5 eng-weeks for the suppression/
DROP-poller machinery (fact pack §9.5, §9.8; deadlines are near-term — DROP polling obligations
start 2026-08-01). The FinOps framing throughout follows the FinOps Foundation's
inform → optimize → operate loop ([FinOps framework](https://www.finops.org/framework/)).

## Enterprise best practices

A ZoomInfo/Apollo/Clearbit-class platform treats cost per verified record as a first-class product
metric, not an accounting afterthought. Concretely: (1) **unit economics are instrumented at the
call site** — every paid API call lands a cost row keyed to tenant, model/provider, and pipeline
stage, and the monthly invoice reconciles against the sum (the main app's
`provider_calls.cost_micros` is exactly this; providerCallRepository.ts:3); (2) **budgets are
enforced before spend, atomically** — a durable per-tenant daily cap checked under a lock, failing
closed (enrichContact.ts:127-141 is the house pattern); (3) **never pay twice** — request-hash and
content-hash caches make every repeat $0 (FIXED decision #7); (4) **batch-first for anything
latency-insensitive** — bulk extraction, backfills, and evals ride the 50% discount lane, live
capture rides sync; (5) **the two hard ceilings get dashboards** — the planning suite's own scale
model names ai-extract spend and human review as the binding constraints (fact pack §2.1), so both
get burn-rate alerts, not month-end surprises; (6) **build-vs-buy has numeric triggers reviewed on
a calendar** — the trigger table below is re-scored quarterly, so a "buy" happens when its trigger
fires, and never merely because a vendor demo landed during an incident; and (7) **showback before
chargeback** — per-tenant COGS is visible internally for a quarter before any pricing decision
depends on it.

## Recommended architecture

### 1. LLM cost engineering — the cascade and its levers

```text
capture ──► ingest dedup (content_hash ON CONFLICT — exact re-captures FREE)
              │
              ▼
        deterministic parser (JSONPath/Zod mapper, versioned)     60–80% of records: $0
              │  residue only (unmapped/unstructured fields)
              ▼
        extraction result cache: sha256(payload_hash‖prompt_ver‖schema_ver)
              │  hit → $0                                          retries/re-parses: $0
              ▼  miss
        durable budget check (tenant, utc_day) — advisory-locked, fail-closed
              │
              ├── live lane (user-facing, rare): sync Haiku 4.5, cached prefix
              ▼
        batch lane (default): Anthropic Batch API, Haiku 4.5, cached prefix   −50%, −0.1× reads
              │  validation-fail / low-confidence (~5–10%)
              ▼
        Sonnet escalation (batch where possible)
              │  eval sampling only
              ▼
        Opus 4.8 evals / ER adjudication (uncertain band only, <5% of pairs)
              │
              ▼
        record usage: extraction_runs tokens + cost_micros → per-tenant daily rollup
```

The levers, priced (all figures from §Research; per 1M records at 3K in/500 out):

| Lever | Mechanics | Effect on $/1M records |
|---|---|---|
| Naive baseline (today's shape, if it worked) | Sync Haiku on every record | $5,500 |
| Batch API | Flat 50% off, <1h typical turnaround | $2,750 |
| Prompt caching | 2K-token static prefix at 0.1× reads; stacks with batch | ≈ $1,850 (−~33%) |
| Deterministic-first | Mappers handle 60–80%; AI sees residue only | **$500–1,500 blended** |
| Content-hash result cache | Re-captures, retries, cross-tenant identical payloads | $0 marginal |
| Model laddering | Sonnet only on validation-fail/low-conf (~5–10%); Opus evals only | Keeps blend near Haiku rate |
| Sensitivity: +30% tokenizer | Opus 4.7+/Sonnet 5/Fable 5 count more tokens | Multiply all rows ×1.3 worst case |

Spend recording and budgeting reuse the main app's proven pattern wholesale: populate the
existing `extraction_runs` token columns, add `cost_micros` computed from a versioned price table,
and enforce a per-tenant/day budget with the advisory-lock + `spendSince` shape from
providerCallRepository.ts:74-84 — durable in Postgres, shared across workers and restarts,
fail-closed. Full cascade design in 11-ai-assisted-processing.md. **Assignment: record spend +
per-tenant budget = F1; batch/caching/result-cache = F2** (per the phase definitions in
17-phased-implementation-roadmap.md).

### 2. Object-storage tiering for bronze

| Tier | Store | Price | What lives there |
|---|---|---|---|
| Hot archive (0–90d, replay-heavy) | Cloudflare R2 Standard | $15/TB-mo, **zero egress** | Content-addressed immutable batches (zstd JSONL/Parquet), hash-keyed |
| Warm (90d+) | R2 Infrequent Access lifecycle | $10/TB-mo | Older batches, still replayable free |
| Second copy / backup | Backblaze B2 | $6.95/TB-mo | Async replicated copy; vendor-risk hedge |
| Compliance cold (7-yr) | S3 Glacier Deep Archive | ~$1/TB-mo | WORM-anchored audit segments + legal-hold copies |

Bronze leaves Postgres text columns in F2 (09-storage-strategy.md owns the mechanics); the
`forgeObjectStore` adapter already speaks S3 (packages/integrations/src/forgeObjectStore.ts), so
R2 is an endpoint + credentials change, not a rewrite. At the design profile (~31GB/day of blobs
at stress; fact pack §2.1) a year of raw is ~11TB ≈ $165/mo hot on R2 — versus the same bytes
amplifying Postgres storage, WAL, and every backup. Egress-free replay is the strategic property:
the reparse-everything-on-parser-bump loop (02-enterprise-data-platform.md) costs $0 in transfer
forever. **Assignment: R2 tiering = F2.**

### 3. Build-vs-buy, every component

Chosen option, its cost, and the numeric trigger at which the answer changes. "Build" means thin
code on Postgres; "adopt" means self-hosted OSS; "rent" means metered SaaS with no commitment.

| Component | Chosen | Cost (USD/mo unless noted) | Buy alternative (price) | When to buy — the trigger |
|---|---|---|---|---|
| Object storage | **Rent R2 + B2 copy** | $15/TB + $6.95/TB | S3 ($23/TB + $90/TB egress) | Never for cost; self-host (SeaweedFS/Garage) only if DPDP residency forces it at >200–500TB |
| LLM extraction | **Rent Anthropic API** (metered, cascaded) | $500–1,500/1M records blended | GPU self-host | Effectively never at this scale; revisit only if sustained spend >$50K/mo AND workload is commodity-model-shaped |
| Entity resolution | **Build**: deterministic ladder + FS, weights via Splink/DuckDB offline | ~0.5 FTE ongoing; $0 license | Senzing ($58,560/yr @10M, list); AWS ER ($25K/100M pass); Tamr ($250K+/yr, unverified) | Match quality is demonstrably revenue-blocking after Tier-A/B tuning + active learning are exhausted (05-entity-resolution.md) |
| Search | **Adopt** ladder: PG FTS → ParadeDB → self-host OpenSearch | $0 → +$100–300 → $150–400 + 0.25 FTE | Managed Elastic/OpenSearch (typ. $1–3K/mo at 3-node scale, unverified) | Managed only if the 0.25 FTE cannot be staffed when the 30–50M-record trigger fires (10-search-indexing.md) |
| Telemetry OLAP | **Adopt** single-node ClickHouse (+PeerDB) | $200–400 (est.) | ClickHouse Cloud / managed | Events >100–200M rows triggers adoption itself; managed only if ops >8h/wk sustained |
| Observability | **Adopt** SigNoz (single ClickHouse-backed app; [signoz.io](https://signoz.io/)) | rides CH node, ~$50–200 (est.) | Datadog-class SaaS (commonly $2–5K+/mo at this footprint, unverified) | Only if the team drops below the size to run one container stack — i.e., practically never |
| Queue transport | **Keep** BullMQ OSS | $0 | BullMQ Pro ($95/mo intro / $995–1,395/yr) | **Buy cheerfully** when per-tenant fairness needs groups (F2 backpressure work) — the one cheap buy |
| Durable workflows | **Defer**, then adopt Hatchet or DBOS | $0 license | Temporal Cloud ($100/mo + $50/M actions); never Temporal self-host ($2.5–4.5K/mo est. + SRE) | >2–3 hand-rolled BullMQ state machines for verify/HITL, or backfills need pause/resume/fork (08-pipeline-architecture.md) |
| Catalog / lineage | **Build thin**: per-field provenance table (doubles as Art-14 map) | ~2–4 wks one-time | DataHub/OpenMetadata self-host (≥0.5–1 FTE) | ≥3 data engineers AND ≥5 distinct stores AND enterprise lineage demand → OpenMetadata first |
| Email verification | **Rent per-check APIs**; build the cache/state machine | ~$0.5–4/1K checks (vendor list, unverified) | Building SMTP verification infra | Never build the SMTP layer — deliverability/IP-reputation is a vendor's whole job (04-data-quality-framework.md) |
| Ad-hoc analytics | **Adopt** DuckDB over R2 Parquet | $0 | MotherDuck ($250/mo+) | Only if analysts outgrow single-node DuckDB — revisit at raw >1–5TB alongside DuckLake (09-storage-strategy.md) |
| Company hierarchy data | **Adopt free**: GLEIF LEI L2, Companies House bulk | $0 | D&B DUNS family trees (enterprise contract) | A paying enterprise segment demands DUNS-grade hierarchies; avoid OpenCorporates ODbL in the proprietary dataset (share-alike contamination) |

The pattern across every row: the client's stated preference — open-source, self-hostable,
low-ops, build-internal — is also the economically correct answer at this scale, **except** where
renting is the low-ops choice (object storage, LLM, verification), and in exactly those cases the
rent is metered pennies with no commitment. Nothing on this table carries a five-figure annual
license. Full consolidated stack rationale in 16-technology-recommendations.md.

### 4. Per-tenant quotas and metering

Reuse the FinOps pattern, don't reinvent it (FIXED decision #7). One usage-event spine, one daily
rollup, one breaker:

```sql
-- forge.usage_events — append-only meter, one row per billable action
CREATE TABLE forge.usage_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,             -- attribution pinned at the paid call site
  kind            text NOT NULL,             -- 'ai_extract' | 'ai_escalate' | 'verify_check' | 'storage_gb_day' | 'sync_apply'
  quantity        bigint NOT NULL,           -- tokens, checks, bytes…
  unit            text NOT NULL,             -- 'tokens_in' | 'tokens_out' | 'checks' | 'bytes'
  cost_micros     bigint NOT NULL DEFAULT 0, -- µ$ at the versioned price table
  price_version   text NOT NULL,             -- which pricing.ts snapshot priced it
  ref_id          uuid,                      -- extraction_runs.id / provider call / batch id
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  day             date GENERATED ALWAYS AS ((occurred_at AT TIME ZONE 'utc')::date) STORED
);
CREATE INDEX idx_usage_events_tenant_day ON forge.usage_events (tenant_id, day, kind);

-- forge.tenant_spend_daily — the rollup the breaker and the console read
CREATE TABLE forge.tenant_spend_daily (
  tenant_id    uuid NOT NULL,
  day          date NOT NULL,
  kind         text NOT NULL,
  total_micros bigint NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day, kind)
);
```

```ts
// packages/forge-core/src/budget.ts — the durable port replacing inMemoryBudgetStore
export interface DurableBudgetPort {
  /** Atomically check-and-reserve under an advisory xact lock keyed (tenantId, utcDay).
   *  Mirrors providerCallRepository.lockDailyBudget + spendSince (:74-84). Fail-closed. */
  reserve(tx: Tx, tenantId: string, estimateMicros: number): Promise<
    { ok: true } | { ok: false; spentMicros: number; capMicros: number }
  >;
  /** Settle actual cost after the call returns (refund the over-estimate). */
  settle(tx: Tx, tenantId: string, refId: string, actualMicros: number): Promise<void>;
}
```

Semantics: `reserve` runs in the same transaction that will insert the `usage_events` row, under
`pg_advisory_xact_lock(hash(tenant_id, day))` — the identical serialization fix the main breaker
already needed and got (providerCallRepository.ts:65-74). Caps come from validated env
(`FORGE_AI_DAILY_BUDGET_MICROS`, default $25/tenant/day, alongside the main
`ENRICH_DAILY_BUDGET_MICROS` at env.ts:161) with per-tenant overrides in a `tenant_budgets` row
when a tenant pays for more. Enforcement order at the call site: result cache → reserve → call →
settle + usage event — so a cache hit never touches the budget, and a budget denial emits a
`budget_denied` outcome the console can show. Storage and verification meter through the same
spine, giving one per-tenant COGS view. Global backstop: a platform-wide daily cap (sum across
tenants) wired to the same table protects the Anthropic account itself.

### 5. Estimated monthly infrastructure cost by scale tier

All figures are estimates (marked); AI rows assume the F2 cascade is live (deterministic share
60–80%, batch+cache on). Volumes anchor to the planning scale model (fact pack §2.1): ~4 captures
per profile, dedup ~4:1.

| Line item | **Baseline** (F1, capture dark; synthetic only) | **Growth** (F2–F3, ~100K captures/day ≈ 25K unique records/day) | **Enterprise** (F4, design baseline: 2.5M captures/day ≈ 500K unique/day) |
|---|---|---|---|
| Compute (VMs; forge share) | ~$0 marginal (rides existing VM — needs limits, P-15.9) | $150–400 (second/bigger VM) | $1,000–2,000 (small fleet or k8s) |
| Postgres | $0 marginal | $100–300 (headroom + ParadeDB) | $500–1,000 (primary + replica) |
| Redis (dedicated, AOF) | $0 (shared) | $30–60 | $100–200 |
| Object storage (R2 + B2 copy) | <$5 | $20–60 (1–3TB) | ~$750–1,100 (≈50TB + copy) |
| ClickHouse (telemetry) | $0 (not yet) | $200–400 (single node) | ~$1,070 (3-node) |
| Search | $0 (PG FTS) | included in PG row (ParadeDB) | $150–400 (OpenSearch 3-node) + 0.25 FTE labor |
| Observability (SigNoz) | $0 | $50–100 | $100–200 |
| BullMQ Pro (optional) | $0 | $95 | $95 |
| **AI extraction (blended $0.5–1.5/1K unique)** | <$100 (synthetic + evals) | **$375–1,125** (~750K/mo) | **$7,500–22,500** (~15M/mo) |
| Email verification (vendor, unverified rates) | ~$0 | $300–1,000 | $1,000–4,000 |
| Compliance fees (amortized $6.5–7K/yr) | $550 | $550 | $550 |
| **Total (ex-labor)** | **≈ $650–1,200** | **≈ $1,900–4,100** | **≈ $12,700–33,000** |

Two readings of the table: first, **AI extraction is 20–70% of total COGS at every real tier** —
the planning suite was right to call it a hard ceiling, and every F2 cost lever attacks this line;
second, everything that is not AI or storage is **hundreds, not thousands** — which is precisely
why buying a $58K/yr ER engine, a $30–50K/yr workflow platform, or a 0.5-FTE catalog would invert
the cost structure of the entire platform. The avoided-buys total ($200–500K/yr at enterprise
tier, summing the buy-alternative column) funds the compliance program (~$7K/yr fees + $10–30K
one-time legal + 3–5 eng-weeks; 07-data-governance.md) roughly thirty times over. That is the
thesis in one row: **buy nothing heavyweight; spend the savings on compliance.**

## Implementation details

Dependency-ordered. F1 items are additive and safe while capture stays dark; F2 items ride the
platform-core phase.

1. **F1 — versioned price table.** New `packages/forge-core/src/pricing.ts`: a frozen map
   `{ model → { inputMicrosPerMTok, outputMicrosPerMTok, cacheReadMultiplier, batchMultiplier } }`
   with a `PRICE_VERSION` string and the Sonnet-5 intro expiry (2026-08-31) encoded as a dated
   entry. Unit-tested against the verified figures in §Research. Re-baseline token estimates with
   `count_tokens` for the +30% tokenizer generation before trusting projections.
2. **F1 — record spend.** Populate the existing columns in the metering row inside
   `packages/forge-core/src/extraction.ts` (the omission is at :283-303): `latencyMs`,
   `inputTokens`, `outputTokens`, `cachedTokens` from the port result. New hand-authored migration
   `packages/db/src/migrations/0071_forge_cost_metering.sql` (drizzle-kit generate is unsafe in
   this repo; fact pack §2.3) adding `extraction_runs.cost_micros bigint` and
   `extraction_runs.price_version text`, plus the `forge.usage_events` and
   `forge.tenant_spend_daily` tables from §Recommended architecture. Update
   `packages/db/src/schema/forge.ts` accordingly (token columns already at :159-162).
3. **F1 — durable per-tenant/day budget.** New
   `packages/db/src/repositories/forge/budgetRepository.ts` implementing `DurableBudgetPort` with
   the advisory-lock pattern copied from
   `packages/db/src/repositories/providerCallRepository.ts:74-84`. Replace `inMemoryBudgetStore()`
   at `apps/forge-worker/src/processors.ts:103` with the durable port injected via the existing DI
   seam. Config keys `FORGE_AI_DAILY_BUDGET_MICROS` (default 25,000,000) and
   `FORGE_AI_GLOBAL_DAILY_BUDGET_MICROS` move into the validated `appEnvSchema` in
   `packages/config/src/env.ts` (closing the P-01.29 bypass for these keys; the pattern to follow
   is `ENRICH_DAILY_BUDGET_MICROS` at env.ts:161).
4. **F1 — extraction result cache + idempotent extract.** New table `forge.extraction_cache`
   (`cache_key text PRIMARY KEY` = sha256(payload_hash‖prompt_ver‖schema_ver), `fields jsonb`,
   `outcome text`, `model text`, `created_at`) in migration 0071; `runExtraction` checks it before
   the budget/port and writes through after. This simultaneously fixes the retry re-billing half
   of P-01.16 (a redelivered job hits the cache) and makes identical payloads $0. Depends on
   server-side contentHash recompute (F1, P-01.12) so cache keys cannot be poisoned by
   client-declared hashes.
5. **F1 — resource limits + queue hygiene (cost containment).** Add CPU/memory
   limits/reservations for the three forge services in `deploy/docker-compose` (matching the
   api/auth services that already have them; fact pack §4.4) and set
   `removeOnComplete`/`removeOnFail` (age+count) on every forge queue in
   `apps/forge-worker/src/register.ts` (P-01.17) — Redis growth is a cost leak with an outage at
   the end (fact pack §10.2).
6. **F2 — Batch API lane + prompt caching.** Extend
   `packages/integrations/src/forgeAnthropicExtraction.ts` with a batch submitter/poller pair
   (BullMQ jobs `forge-ai-batch-submit`/`forge-ai-batch-collect`) and `cache_control` breakpoints
   on the static system-prompt + schema prefix. Routing default: batch for backfill/reparse and
   any record without a waiting user; live sync lane only for operator-triggered extraction.
   Escalation to Sonnet on validation-fail/low-confidence, per 11-ai-assisted-processing.md.
7. **F2 — deterministic-first residue gate.** The parse stage marks which fields the versioned
   mapper filled; extract receives only the residue slice, not the full payload
   (replacing the full-payload send at processors.ts:108). This is the single largest lever
   (60–80% of records skip AI entirely) and also shrinks the PII surface sent to the provider
   (13-security.md).
8. **F2 — R2 tiering.** Point `packages/integrations/src/forgeObjectStore.ts` at R2 via env
   (endpoint + keys in validated config); lifecycle rule Standard→IA at 90 days; nightly B2 sync
   job `forge-archive-replicate`; Deep Archive export for audit WORM anchors. Bronze-out-of-
   Postgres migration itself is owned by 09-storage-strategy.md.
9. **F2 — cost observability.** Replicate `extraction_runs` + `usage_events` to ClickHouse via
   PeerDB (09-storage-strategy.md owns the CH deployment); SigNoz/Grafana dashboards: $/1K unique
   records (by model, by tenant), batch share of tokens, cache hit rate, budget-burn per tenant
   with 80% warning and 100% breaker alerts; Prometheus gauges
   `forge_ai_spend_micros_today{tenant}`, `forge_ai_budget_denials_total` added to the real
   `/metrics` endpoint (P-01.27; 12-observability.md).
10. **F2 — console surface.** Add a Cost panel to the overview BFF
    (`apps/forge-api/src/features/dashboard-bff/routes.ts`) returning today's spend, budget
    headroom, and cache-hit rate per tenant — read from `tenant_spend_daily`, no new write paths.
11. **Ongoing — build-vs-buy trigger review.** A quarterly checklist item (owner: platform lead)
    re-scores every row of the §3 table against its numeric trigger; the review is recorded in
    `docs/planning/` and any trigger crossing opens a decision doc, not a purchase order.

## Migration strategy

Every step is additive and individually reversible; no step increases spend, and capture remains
dark (flags off) throughout F1 per the phase contract.

1. **Meter dark first.** Ship pricing.ts + the 0071 migration + populated token/cost columns with
   no behavioral change. Validate on staging synthetic traffic: assert
   `|Σ cost_micros − Anthropic console spend| < 5%` for a week before trusting the numbers.
2. **Budget in log-only mode.** `FORGE_AI_BUDGET_ENFORCED=false` initially: `reserve` records
   would-be denials as `budget_denied_dryrun` usage events without blocking. Flip to enforce per
   tenant once a week of dry-run shows no false denials at the default cap. Rollback = flag off.
3. **Result cache read-through.** Deploy the cache table with writes-only for a few days (measure
   would-be hit rate), then enable read-through. Rollback = stop reading; the table is advisory.
4. **Batch lane behind a flag.** `FORGE_AI_BATCH_ENABLED` routes backfill/reparse work to the
   batch lane; live lane untouched. Compare per-record cost and error rates lane-vs-lane for one
   backfill before making batch the default. Rollback = flag off; jobs re-route to sync.
5. **R2 dual-write, then cutover.** New captures write R2 + legacy store in parallel; backfill
   old objects; verify hash-for-hash; cut reads to R2; retire the legacy bucket (sequenced with
   09-storage-strategy.md's bronze migration). Rollback at any point = read from legacy.
6. **Dashboards last, alerts first.** The budget-burn and invoice-reconciliation alerts go live
   with step 1; the full ClickHouse dashboard set lands with F2's telemetry work — alerting must
   not wait for pretty graphs.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Budget breaker misconfigured too tight; legitimate pipeline work blocked | Medium | Medium | Log-only mode first; per-tenant overrides; 80% warning alert precedes 100% denial; denial emits a visible outcome, never a silent drop |
| Price/tokenizer drift breaks the model (+30% token counts; Sonnet 5 intro ends 2026-08-31) | High | Medium | Versioned pricing.ts with dated entries; `count_tokens` re-baseline; alert on $/1K-records drift >20% week-over-week |
| Invoice ≠ recorded spend (metering bug or unmetered path) | Medium | High | Weekly reconciliation alert (<5% tolerance); all Anthropic calls route through the one adapter; CI test asserts the metering row carries tokens+cost |
| Result-cache poisoning via client-supplied hashes | Medium | High | Cache keys derive from server-recomputed content hash only — hard dependency on the F1 fix for P-01.12 |
| Batch-lane latency (≤1h typical) applied to a user-facing path | Low | Medium | Lane separation is explicit at the router; live lane stays sync; batch is default only for backfill/reparse |
| Self-host ops burden underestimated (ClickHouse/SigNoz/OpenSearch) | Medium | Medium | Adopt only at numeric triggers; 0.25 FTE budgeted at the search trigger; managed fallback documented per row in the build-vs-buy table |
| Build-vs-buy triggers ignored under delivery pressure (drift into SaaS or into over-building) | Medium | Medium | Quarterly trigger review on the calendar with a named owner; triggers are numeric, so the review is a comparison, not a debate |
| Per-tenant attribution gaps undermine showback (tenant lost past bronze, P-01.23) | Medium | Medium | Meter at the paid call site where `target_tenant_id` exists (extraction_runs:150); F2 provenance work carries attribution through the rest |
| R2 vendor risk (pricing or egress-policy change) | Low | Medium | Content-addressed layout is portable by design; B2 second copy is live; S3/SeaweedFS exit paths costed in 09-storage-strategy.md |

## Success metrics

- **Metering completeness:** 100% of extraction runs carry `input_tokens`/`output_tokens`/
  `cost_micros` (F1 exit); weekly reconciliation vs the Anthropic invoice within **±5%**.
- **Budget enforcement:** zero paid extraction calls without a durable budget reservation; a
  simulated runaway producer on staging is stopped at the cap with a `budget_denied` outcome and
  an alert, spending ≤ the per-tenant daily cap ($25 default) — proven by an integration test.
- **Unit economics:** blended extraction cost ≤ **$1.50/1K unique records** by end of F2
  (stretch: ≤$0.75); deterministic share ≥60% of parsed records; batch share ≥80% of extraction
  tokens; cache-read share ≥50% of input tokens on the batch lane.
- **Result-cache effectiveness:** ≥95% of redelivered/retried extract jobs answered from cache
  ($0); zero double-billed runs in the metering table for the same cache key.
- **Storage:** hot raw archive ≤ $15/TB-mo effective; $0 egress on all replay/backfill jobs;
  bronze bytes resident in Postgres trending to ~0 by end of F2 (09-storage-strategy.md).
- **Infra envelope:** each tier's total (ex-AI) stays within the §5 table's band; forge services
  run under compose resource limits; Redis job-key count flat week-over-week.
- **Visibility:** per-tenant $/day visible in the console within 24h of spend; budget-burn alert
  fires at 80%; the two hard-ceiling dashboards (AI spend, review-queue depth) exist and are
  linked from the runbook.
- **Governance:** the quarterly build-vs-buy review has occurred, is recorded, and every non-OSS
  spend maps to a fired trigger; compliance registrations paid on time (CA due Jan 31).

## Effort & priority

**P1 · 4–6 eng-weeks · F1–F2.** The F1 slice — price table, populated metering, durable
per-tenant budget, result cache, resource limits — is ~1.5–2 eng-weeks and belongs in F1 because
it is correctness-adjacent (P-15.1/P-15.2 make spend both unmeasured and unbounded on a metered
API) and because it must exist **before** any capture flag turns on for a real tenant; it is not
P0 only because capture is dark today, and it becomes P0 the day that changes. The F2 slice —
batch lane, prompt caching, residue gate, R2 tiering, ClickHouse cost observability, console
panel — is ~2.5–3.5 eng-weeks for the 2–3-engineer pod, riding platform-core work that F2 does
anyway. The ongoing trigger review is ~1 hour/quarter. The payback is not subtle: the F2 levers
turn a $5,500/1M naive extraction rate into $500–1,500/1M blended, and the build-vs-buy
discipline keeps $200–500K/yr of heavyweight licenses out of the cost structure — a return
measured in weeks against every line of this document's effort.

## Future enhancements

- **Chargeback and billing integration:** graduate showback to customer-facing metered billing by
  feeding `tenant_spend_daily` into the platform's billing-admin surfaces
  (packages/types/src/billingAdmin.ts) once per-tenant COGS has a stable quarter of history.
- **Value-based model routing:** choose the extraction tier by record value (account tier, list
  membership, requested-by-user) rather than uniformly — spend Sonnet only where a human is
  waiting or an enterprise tenant is paying.
- **Self-hosted embeddings for search/ER candidates:** ~$40–70 one-time GPU compute to embed 100M
  records (fact pack §11.1) when the semantic-recall trigger in 05-entity-resolution.md /
  10-search-indexing.md fires; storage, not compute, is the real cost.
- **Fine-tuned small matcher:** replace LLM adjudication for ER when adjudication spend exceeds
  $1–2K/mo AND ≥10K reviewed labels exist (fact pack §11.2) — the review queue produces the
  training set for free.
- **Enterprise pricing negotiation:** committed-use or enterprise agreements with Anthropic once
  sustained monthly spend clears ~$10K (terms unverified; revisit at the enterprise tier).
- **DuckLake archive economics:** re-cost the raw archive when it crosses 1–5TB and multi-writer
  reprocessing arrives (09-storage-strategy.md); Deep-Archive-tier the audit WORM segments on a
  7-year clock.
- **Per-workspace (sub-tenant) quotas:** extend the budget key from tenant/day to
  workspace/day where enterprise tenants want internal cost allocation — the schema already
  carries both dimensions everywhere the main app meters.
