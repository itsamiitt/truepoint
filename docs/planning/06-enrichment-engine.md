# 06 — Enrichment Engine

> How LeadWolf fills out a workspace's **own** contacts/accounts. Data enters **per-workspace** via
> **import** (CSV/CRM/Sales Navigator) and **enrichment providers** (Apollo, ZoomInfo, Clearbit) called by
> enrichment workers. There is **no global golden record** and **no field-level merge**
> ([ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md), supersedes the old
> raw/provenance/golden pipeline) — provenance is the per-import `source_imports` row. Implemented in
> `packages/enrichment-sdk` + the enrichment/import BullMQ workers ([ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md)).

## 1. Principles

- **Per-workspace, on-import.** Enrichment writes into the **calling workspace's** `contacts`/`accounts`
  copies only ([ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md)); nothing is shared
  across workspaces and there is no cross-source merge or replay.
- **Cache-first, cost-aware.** Never pay twice for the same provider answer; try cheap/likely sources first.
- **Charge on reveal, not enrichment.** Enrichment cost is a system metric
  (`provider_calls.cost_micros`); users pay credits only when they **reveal**
  ([07 §1](./07-billing-credits.md), [07 §3](./07-billing-credits.md)).
- **Every import is provenance.** Each import writes one `source_imports` row holding the raw source
  payload (`raw_data` jsonb) — the only lineage record under this model (no `field_provenance`).
- **Correctness ≠ quality.** Verification (`email_status`) is field **correctness**; lead scoring
  ([§7](#7-lead-scoring--intent-signals)) is prospect **quality**. Never conflate the two
  ([ADR-0008](./decisions/ADR-0008-lead-scoring-model.md)).

## 2. Source channels (how data enters a workspace)

| Channel | Mechanism | Provenance / dedup |
|---|---|---|
| **CSV / manual** | Upload or manual create → staged → upsert into workspace `contacts`/`accounts` | `source_imports.source_name = csv`/`manual` |
| **CRM sync** | Salesforce / HubSpot / Pipedrive pull → field mapping | `source_imports.source_name = salesforce`/`hubspot` |
| **Sales Navigator** | Operator-assisted capture of profiles/lists → workspace contacts (see [§8](#8-sales-navigator-as-a-source)) | `source_imports.source_name = sales_navigator`; dedup on `sales_nav_lead_id` |
| **Enrichment providers** | Workers call Apollo / ZoomInfo / Clearbit to fill missing fields ([§3](#3-provider-interface)) | `source_imports.source_name = apollo`/`zoominfo`/`clearbit` |
| **Technographic** | Workers call **BuiltWith / HG Insights / Wappalyzer** to fill an account's tech stack | provenance via `provider_calls`; enriches account technographic fields + emits `tech_install` signals |
| **Intent data** | Co-op / signal feeds — **Bombora** (B2B intent co-op), **G2**, **6sense** — keyed to accounts/domains | not a contact source; populates `intent_signals` (`signal_source = bombora`/`g2`/`6sense`) |

All **contact** channels land through the same import/enrich workers and dedup **within the workspace** on
`(workspace_id, email_blind_index)` / `(workspace_id, linkedin_public_id)` /
`(workspace_id, sales_nav_lead_id)` ([03 §5](./03-database-design.md#5-data-layer)). The old proprietary
web-scraper engine and global golden pipeline were **removed**
([ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md)). **Technographic and intent providers
enrich *accounts* and emit *signals*, not new contacts** — their provenance lives in `provider_calls` and
`intent_signals.signal_source` (feeding scoring, [ADR-0008](./decisions/ADR-0008-lead-scoring-model.md)),
not in `source_imports` (data-side research:
[../research/sales-intelligence-data-research.md](../research/sales-intelligence-data-research.md) §1).

## 3. Provider interface

One contract; the engine is provider-agnostic. Adapters wrap **Apollo, ZoomInfo, Clearbit** (first wave).

```ts
type ProviderName = 'apollo' | 'zoominfo' | 'clearbit' | string;
type Capability =
  | 'contact.email' | 'contact.phone' | 'contact.profile'
  | 'account.firmographics' | 'account.domain' | 'email.verify';

interface EnrichRequest {
  workspaceId: string;                 // results write into THIS workspace's copies only
  entityType: 'contact' | 'account';
  fields: string[];                    // requested fields, e.g. ['email','phone']
  subject: {                           // what we know to look it up
    fullName?: string; companyDomain?: string; companyName?: string;
    linkedinUrl?: string; email?: string;
  };
  region?: string;                     // residency / routing hint
}

interface ProviderResult {
  fields: Array<{ field: string; value: string; confidence?: number }>;
  rawPayload: unknown;                 // stored verbatim -> source_imports.raw_data
  costMicros: number;                  // actual/estimated spend -> provider_calls
  status: 'hit' | 'miss' | 'rate_limited' | 'error';
}

interface EnrichmentProvider {
  name: ProviderName;
  capabilities: Capability[];
  estimateCostMicros(req: EnrichRequest): number;
  rateLimiter: RateLimiterSpec;        // tokens/sec + max concurrency
  enrich(req: EnrichRequest, ctx: ProviderCtx): Promise<ProviderResult>;
}
```

## 4. The enrichment flow (per requested field)

```mermaid
flowchart TB
  A[Request field e.g. contact.email\nfor a workspace contact] --> B{Provider cache hit?\nprovider_calls.request_hash}
  B -- yes --> Z[Use cached payload. No call, no cost]
  B -- no --> C[Order capable providers by\nexpectedHitRate x trust / cost]
  C --> D[Call next provider\n(rate-limited, circuit-broken)]
  D --> E{hit?}
  E -- yes --> F[Persist source_imports row + provider_call]
  F --> G{more fields?}
  E -- no/miss/error --> H{more providers?}
  H -- yes --> D
  H -- no --> I[Mark field unfilled; record attempts]
  G -- yes --> A
  G -- no --> Z2[Upsert workspace contact/account copy]
```

1. **Cache check** — `provider_calls.request_hash` (workspace-scoped). A hit short-circuits (no call, no
   cost).
2. **Order providers** — `score = expectedHitRate × trust ÷ estCostMicros`, cheapest/most-likely first.
   `expectedHitRate` is learned over time from `provider_calls` (per provider × field).
3. **Sequential waterfall** — call provider; `hit` → stop; otherwise next. (A "parallel-cheap" mode is
   allowed for low-cost providers when latency matters.)
4. **Persist** — every response writes a `source_imports` row (`raw_data` verbatim) +
   `provider_calls` (cost/latency/cache_hit). The workspace's `contacts`/`accounts` copy is upserted
   transactionally; conflicting values on re-enrich are last-writer-wins within the workspace (no
   cross-source merge, no `merge_log`).

## 5. Caching

| Tier | Store | Keyed by | Purpose |
|---|---|---|---|
| Persistent | `provider_calls` (Postgres) | `request_hash = sha256(provider, normalized_request)` | Don't re-pay; TTL per provider policy |
| Hot / in-flight | Redis (ElastiCache) | same hash | Dedup concurrent identical requests; short TTL |

Normalization (lowercasing, domain canonicalization, trimming) happens **before** hashing so trivially
different requests share a cache entry. `provider_calls` is **optional and workspace-scoped** — it tracks
provider cost/cache for the enrichment workers, not user-facing billing
([03 §8](./03-database-design.md#8-billing--compliance)).

## 6. Rate limiting, idempotency, resilience

- **Rate limiting:** Redis **token bucket** per provider (and per customer API key for the public API).
  Respect provider `429`/`Retry-After` with exponential backoff + jitter.
- **Circuit breaker:** open after N consecutive errors for a provider; while open, the waterfall skips
  it and continues with the rest. Half-open probe to recover.
- **Idempotency:** enrichment jobs carry an idempotency key; `provider_calls.request_hash` unique +
  Redis in-flight lock prevent duplicate **paid** calls under retries/concurrency.
- **Cost control:** per-provider + global **daily cost budgets** with alerts; the breaker can be tripped
  by budget exhaustion. All spend is observable (cost-per-reveal dashboard, [§9](#9-metrics-the-economics-dashboard)).

## 7. Lead scoring & intent signals

Scoring is the **intelligence** layer ([ADR-0008](./decisions/ADR-0008-lead-scoring-model.md)) and is
**explicitly distinct from data correctness** ([§1](#1-principles)): `email_status` says whether a field is
*right*; the lead score says how *good a prospect* is. They never share a column or a vocabulary.

- **Versioned `scores`** ([03 §6](./03-database-design.md#6-intelligence-layer-adr-0008)) — each re-score
  **appends** a row with `icp_fit`, `intent_score`, `engagement_score`, `composite_score` (all `0–100`)
  and a `score_breakdown` jsonb explaining the math. History is preserved so a score change is explainable.
- **`contacts.priority_score`** is a denormalized cache of the latest `composite_score`, kept in sync by an
  `AFTER INSERT ON scores` trigger ([03 §10](./03-database-design.md#10-triggers--db-side-logic)).
- **`intent_signals`** feed the intent component: a typed `signal_type`
  (`job_change`/`new_hire`/`funding_round`/`tech_install`/`web_visit`/`content_engagement`/
  `keyword_search`/`linkedin_activity`/`sales_nav_view`) with a `weight` (`1–10`) and `signal_source`.
- **Workspace-private.** Two workspaces can score the same person differently; scoring is **not** a
  billable reveal event and never crosses workspace boundaries.

Scores rank prospects in search/lists and feed AI/ICP features ([05](./05-features-modules.md)); they do
**not** gate reveals or sends — suppression/consent and credits do.

## 8. Sales Navigator as a source

Sales Navigator is an **import/source channel** ([§2](#2-source-channels-how-data-enters-a-workspace)), not
a scraper. Captured profiles/lists become workspace `contacts`/`accounts` carrying
`sales_nav_profile_url`/`sales_nav_lead_id`; the link graph (profile/account/saved_search/lead_list/
account_list/inmail_thread) lives in `sales_nav_links` ([03 §5](./03-database-design.md#5-data-layer)).
Dedup within the workspace uses `(workspace_id, sales_nav_lead_id)`. `source_imports.source_name =
sales_navigator` records the raw payload as provenance.

> **Legal posture.** LinkedIn / Sales Navigator carry **ToS and account-risk**; automated capture/send is
> not assumed — **operator-assisted (human-in-the-loop)** is the default. Per-source legal review gates
> production use; see compliance [08 §11](./08-compliance.md#11-collection--channel-legality-ties-to-06-2) and the
> channel-ToS note in [ADR-0009](./decisions/ADR-0009-outreach-engine-enroll-and-send.md).

## 9. Data quality & verification

- **Email verification on reveal** (gate before charging): MX + SMTP probe + catch-all/role detection →
  `email_status` (`unverified`/`valid`/`risky`/`invalid`/`catch_all`/`unknown`). Verification now **drives the
  charge** ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md), H7): only `valid` is
  charged; `invalid`/`catch_all`/`unknown`/provider-miss → **0 credits**; `risky` → charged-but-flagged. The
  reveal-transaction sequence is described identically in [07 §3](./07-billing-credits.md).
- **Phone validation:** `libphonenumber` for format/region + a validation provider for line type
  (`direct`/`mobile`/`hq`) → `phone_status`. Charged only when a line type resolves
  ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)).
- **Bounce/complaint feedback** from SES (SNS→SQS, [ADR-0010](./decisions/ADR-0010-aws-native-self-hosted-stack.md))
  updates `email_status` and feeds the suppression list ([08 §3](./08-compliance.md)) — closing the loop
  between sending and field correctness. A hard bounce within the guarantee window also triggers the
  **credit-back** on the original reveal ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md),
  [07 §3](./07-billing-credits.md)).
- **Dedicated, provider-independent verifier.** Email verification runs through a **dedicated** service
  (e.g. **ZeroBounce / NeverBounce**), *separate from the enrichment providers that supply the address* — so a
  provider never grades its own data and the charge-only-for-`valid` + credit-back guarantee
  ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)) rests on an independent signal
  (resolves §11 Q1; data-side research
  [../research/sales-intelligence-data-research.md](../research/sales-intelligence-data-research.md) §3).
- **Periodic re-verification** (post-MVP): scheduled jobs re-check fields older than a freshness SLA;
  `last_verified_at` drives ordering.

### Data-quality scoring, dedup & re-verification

A per-record **data-quality subsystem** (flagged as a [03 §14](./03-database-design.md#14-planned-schema-additions-app-surface--platform) amendment):

- **DQ fields** on `contacts`/`accounts`: `last_verified_at`, `verification_source`,
  **`data_quality_score`** (0–100 record-health: completeness × freshness × verification — **distinct**
  from the *lead score* (prospect quality, [ADR-0008](./decisions/ADR-0008-lead-scoring-model.md)) and
  from `email_status`/`phone_status` (field correctness)), and `is_duplicate_of`.
- **DQ rules & jobs:** `data_quality_rules` (validation + per-field **freshness SLAs** + confidence
  thresholds) drive `verification_jobs`. **Bulk re-verification / re-enrichment** runs on **AWS Batch**
  ([01 §4](./01-tech-stack.md#4-background-workers)).
- **Dedup:** exact-match unique indexes (`email_blind_index` / `linkedin_public_id` / `sales_nav_lead_id`)
  catch identical-key dupes at import; the **fuzzy tail** (name+account variants, missing key) is resolved by
  **Splink** (MIT probabilistic record linkage — [ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md))
  running as a batch job that fills `dedupe_candidates` with match probabilities; `is_duplicate_of` links the
  survivor. (No cross-workspace/global merge — [ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md).)
- **Surfacing:** customers see a **Data Health** view in Reports + a per-record quality badge
  ([11 §4.5](./11-information-architecture.md)); staff get platform-wide DQ ops + DB management in the
  admin console ([13](./13-platform-admin.md)).

## 10. Metrics (the economics dashboard)

| Metric | Why it matters |
|---|---|
| Provider hit-rate (per field) | Tunes provider ordering |
| Cost per reveal | Core unit economics (spend ÷ monetized reveals) |
| Cache hit-rate | Efficiency of the caching layer |
| Verification pass-rate | Data quality / deliverability |
| Coverage (% records with verified email/phone) | Product value |
| Daily provider spend vs budget | Cost control / breaker triggers |

## 11. Open questions

1. ~~Add a dedicated email-verification provider (e.g. ZeroBounce/NeverBounce) alongside the enrichment
   providers?~~ **Resolved — yes** (§9): a **provider-independent** verifier backs the charge-only-for-`valid`
   + credit-back guarantee ([ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)). Remaining:
   which vendor + pricing tier.
2. Exact freshness SLA per field for re-verification (e.g. emails re-verified every 90 days)?
3. Sales Navigator capture posture — how far does "operator-assisted" extend before it becomes ToS risk
   (cross-ref [08 §11](./08-compliance.md#11-collection--channel-legality-ties-to-06-2))?
4. Per-workspace dedup quality without a global identity — exact-match indexes at import + **Splink**
   probabilistic linkage for the fuzzy tail ([ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md),
   §9); remaining: blocking-rule + match-threshold tuning per dataset
   ([03 §13](./03-database-design.md#13-open-questions)).
