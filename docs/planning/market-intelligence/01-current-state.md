# 01 — Current state, verified against code

**Scan date:** 2026-08-18, branch `feat/data-mgmt-01-research-brief`.
Legend: ✅ live · 🌒 built, dark (gate off) · 💤 built, unfed (no producer) · 🔲 absent.

## 1. What the product ships as today

Contact-level sales intelligence with a company *filter*, not a company *object*.

- `/prospect` is the product (`apps/web/src/features/prospect/`). One page, a
  `Contacts ⇄ Accounts` SegmentedControl (`ProspectPage.tsx`) — accounts are a scope
  toggle, not a destination. No `/companies` route, no account lists, no saved account
  searches (saved search persists a `ContactQuery` only), no account bulk actions.
- Everything account-shaped renders in one drawer:
  `features/prospect/components/AccountDetailDrawer.tsx` — industry, headcount, revenue,
  HQ, funding stage, founded year, ICP fit, technographics, "View N contacts". No URL,
  not shareable.
- Global Layer-0 person search ("Database" scope, Apollo-style) is live per the
  2026-08-18 operator decision — `POST /api/v1/search/database`,
  `masterPersonSearchRepository`, visibility policy `MASTER_PERSON_VISIBLE`.
- Prod runs near-fully dark: `.env.production` sets **no** `*_ENABLED=true` except
  forge capture explicitly false. Imports v2, bulk import/enrich/reveal, CRM writes,
  teams, SSE, LinkedIn ingestion, merge, extension — all built-dark.

## 2. The Layer-0 market substrate (schema exists; contents mostly do not)

| Store | File | State |
|---|---|---|
| `master_company_headcount` monthly series (+ by-function) | `packages/db/src/schema/masterHeadcount.ts` | 🌒 **wired** — populated by `landSourcePayload` from the `linkedin_api` company payload; gates `LINKEDIN_*` off |
| `master_signals` + `master_signal_types` (16 seeded codes; families hiring/funding/tech_change/leadership/filing/other — **no intent family, deliberate**) | `packages/db/src/schema/masterSignals.ts` | 💤 two writers only: `job_change`, `headcount_surge/decline` (`packages/core/src/sourceLanding/landSourcePayload.ts`) |
| `master_company_funding` | `packages/db/src/schema/masterCompanyDetail.ts` | 💤 upsert exists in `masterCompanyDetailRepository`, zero callers |
| `master_technologies` + categories/aliases/vendors/features | `packages/db/src/schema/masterTechnology.ts` | 💤 catalog DDL only; seeding blocked on the C4 GPL decision |
| `master_technology_adoptions` (episode grain, detection methods incl. `job_posting`) | `masterTechnologyAdoption.ts` | 💤 read by account-intelligence routes; nothing writes |
| `master_confidence_policy` (per field × source: weight, half-life, ceiling) | `masterConfidencePolicy.ts` | 💤 "feeds nothing — conflict C9" |
| `master_company_locations` / `contact_points` / identifiers | `masterCompanyDetail.ts` | 💤 |
| `provenance_event` (append-only field-grain log) + `field_provenance` jsonb + `prov_hwm` | `provenanceEvent.ts`, `packages/core/src/prospect/fieldProvenance.ts` | ✅ the spine; live |

Tenant layer: `accounts` carries `technologies` jsonb, `funding_stage`,
`company_stage`, `icp_fit_score` — facets fed only by `runFirmographicRollup`
(`packages/core/src/prospect/firmographics.ts`), which consumes `intent_signals` rows of
type `tech_install`/`funding_round` **that nothing ever writes**. Those filters are
empty in practice.

## 3. Signal systems — two, deliberately split, one-ninth fed

- Layer-1 `intent_signals` (`schema/intel.ts`): tenant+contact-scoped, closed 9-value
  enum. One writer in the whole repo: `recordJobChange.ts` (`job_change` only), driven
  by the leader-locked `job_change_sweep` (🌒 `JOB_CHANGE_SWEEP_ENABLED`).
- Layer-0 `master_signals`: canonical company/person events. Writers as above, both
  dark. `masterSignalsRepository` enforces a no-PII-in-payload guard
  (`assertNoContactValues`).
- Consumers already waiting: `firmographics` queue rolls signals → account facets;
  `computeScore` reads intent from an empty table; web `SignalsSection.tsx` renders
  whatever exists; reports Intent/LeadScore tabs are permanent empty states.

## 4. Account-intelligence read spine (the beachhead — live code)

`apps/api/src/features/account-intelligence/routes.ts`:
`GET /accounts/:id/{technologies,displacement,alumni,headcount}`,
`/technologies/:techId/peers`, contact-side `/{education,employment,provenance,signals,attributes}`.
Resolve-then-traverse tenancy pattern (`withTenantTx` → `withErTx` → map back).
Headcount returns a 36-month series; growth windows computed client-side (explicit
no-stored-rollup rule — a precedent doc 06 argues with). Web components exist and
self-hide when empty: `HeadcountSection`, `AccountTechnologySections`,
`AccountGraphSections` (displacement + alumni), `SignalsSection`, `ProvenanceSection`.

## 5. Acquisition surfaces

- **Enrichment vendors** (`packages/integrations/src/enrichment/providers.ts`): apollo,
  zoominfo, clearbit (key-gated), pdl + coresignal (dark pending DPA), **linkedin_api**
  — the only deep-document source (positions, education, skills, company firmographics,
  monthly headcount), served through the `provider_origins` failover fleet +
  `source_fetch_registry` 30-day freshness clock. Capability vocabulary is
  contact-only: `contact.email|phone|profile`. No `company.*` capability exists.
- **Sample payloads** (repo-local, untracked `source plan/`): company doc v2 =
  firmographics + `headcount.monthly` (25 months) + growth windows 1m/3m/6m/1y/2y +
  `by_function` + `changes_by_function`; profile doc v1 = full position history,
  education, skills, languages, contact channels. Confirms the licensed source already
  delivers market-intel raw material; keep these files out of git (PII).
- **Ingest connectors** (`packages/core/src/ingestion/registerBuiltins.ts`): 2 of 10
  declared implemented (`admin_upload`, `chrome_extension`). `partner`, `marketplace`,
  `api` are free names.
- **Forge** medallion pipeline (bronze→silver→gold→sync) is generic and running; exactly
  one parser registered (`chrome_extension` / `voyager/identity/profiles`, person-only).
- **Extension**: person extraction only; recognises company pages but extracts nothing —
  fires a server-side `VIEW_FETCH`. Hover card has `score` stubbed `null` "until the
  signals feature is built" (`apps/extension/src/background/api/client.ts`).
- **CRM sync** (9 tables, shadow mode): inbound-by-default field mappings — an
  enrich-in channel once promoted.

## 6. Processing + search infrastructure

- Workers: ~25 always-on queues + ~15 env-gated, leader-locked sweep idiom, leaderless
  `worker_outbox` relay, per-queue DLQs, Prometheus depths (`apps/workers/src/register.ts`).
  A new `market_intel_*` sweep is a mechanical addition.
- Search: **not** FTS — pg_trgm ILIKE + keyset (`packages/db/src/repositories/searchRepository.ts`);
  no relevance ranking; `facetCounts` is the only aggregation primitive. Account search
  is a separate seam (`accountSearchRepository`). The 2026-08-18 decision makes
  **Postgres the global read path** (trgm indexes landed; engine adapters demoted).
- Confidence is **forked**: shipped badge (`packages/types/src/confidence.ts`,
  hardcoded half-lives) vs the policy-driven noisy-OR engine
  (`packages/core/src/prospect/confidence.ts`) with zero consumers — open decision C9.

## 7. What is flatly absent (🔲)

No job-postings entity. No news/press/filings store beyond the `filing` signal family.
No industry taxonomy (free-text `industry`/`sub_industry`, zero NAICS/SIC/GICS
occurrences repo-wide). No account-grain score table (`scores.contact_id NOT NULL`).
No watchlists, no signal alerts, no digests — notifications are operational-only. No
market/segment/TAM aggregates and no seam to compute them. No investor↔round M:N.
