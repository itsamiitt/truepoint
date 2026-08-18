# 05 — Data acquisition per pillar

Principle (`04-opportunity-scores.md`, held): **buy/license the baseline, never compete
on collection.** Every source below enters through existing plumbing; the "what's
reused" column is the point — acquisition is mostly configuration of a rig that exists.

## 0. The rig being reused (do not rebuild)

| Piece | File | Role |
|---|---|---|
| Ingestion envelope + connector registry | `packages/core/src/ingestion/` | New source = new connector id, same pipeline. `partner`, `marketplace`, `api` are free declared names |
| Hardened vendor transport | `packages/integrations/src/enrichment/httpProvider.ts` (`VendorSpec`) | https-only, host allowlist, timeout, size cap, no-redirect, 429 handling — a new HTTP vendor is ~40 lines + one `ALLOWED_PROVIDER_HOSTS` entry |
| Origin fleet + freshness clock | `provider_origins`, `source_fetch_registry` | Per-origin encrypted keys, failover, per-URL 30-day freshness — generic "fetch doc for entity, dedup, land, record health" |
| Landing + provenance | `landSourcePayload`, `source_records` (content-hash idempotent), `provenance_event`, `field_provenance` fold | The only lawful write path into the graph (CLAUDE.md rule 5) |
| Fact + dated-event pattern | `master_company_funding` ↔ `master_signals` | Designed, migrated, ACL'd; working reference = headcount. New feeds slot in with no schema work |
| Fan-out sweep pattern | `channelReconcileSweep` idiom | Leader-locked, ids-only census, per-workspace RLS writes (C-02-safe) |
| Forge medallion + parser registry | `packages/forge-core` | Operator-curated lane for any feed needing human review before the graph; needs a `(source, endpoint)` parser + golden fixtures per feed |
| Provider vetting | `provider_configs` compliance status | Uncleared provider cannot be enabled (doc 21 §4) |

## 1. Per-pillar sourcing

### Firmographics + headcount + job-change + leadership (MI-1/2)
**Source: the existing `linkedin_api` licensed vendor — already integrated.** The
sample payloads (`source plan/`, untracked, keep out of git) confirm company doc v2
carries firmographics, 25 months of monthly headcount, growth windows, by-function
splits; profile doc v1 carries full employment history. Leadership signals
(`exec_hired/departed`) are **derivable at landing** from employment deltas on
c_suite/vp seniority — a new emitter inside `landSourcePayload`, no new source.
Refresh cadence: the `source_fetch_registry` 30-day clock + `linkedin_company_refresh`
6h queue (built). *Acquisition work = enablement + one emitter.*

### Funding / M&A (MI-2)
**Licensed company-facts feed required** (Crunchbase license, or a registry-plus-feed
mix). Adapter = new `VendorSpec` vendor with a **new capability vocabulary entry**
(today capabilities are contact-only): `company.funding`. Writes
`master_company_funding` (writer exists) + `funding`-family signal. Investor↔round M:N
is a schema delta (doc 06 MI-S2) — defer participants until a feed actually supplies
them (schema-shape rule: don't block on unanswered shape, land the fact).

### Filings / registries (MI-2)
Doc 21 already plans it: SEC EDGAR / Companies House / OpenCorporates, scheduled batch
(weekly firmographics, daily filings), M13. Open question carried from doc 21: **which
registries at GA + commercial-use terms** — a procurement decision (doc 09 D-4).
Registry batch lands through the Forge lane (operator-curated, second parser) or a
`partner` connector — choose per feed's trust level.

### Technographics (MI-5)
Two gates before any code: **C4** (GPL — seed catalog from license-clean vocabulary,
keep only the field *shape* from enthec/webappanalyzer) and **feed procurement**
(BuiltWith / HG Insights per doc 21 §2). Until both clear, MI-5 is frozen; the UI
correctly self-hides.

### Job postings (MI-4)
**Licensed postings aggregator feed only** — no crawling (hard constraint 4; also the
`21` "no general-purpose web scraping" stance). Batch cadence daily. Postings double as
technographic evidence (`detection_method='job_posting'`).

### News-shaped events (bounded)
No feed ingestion of articles. Two allowed forms (doc 03 §2): licensed feeds emitting
**signal-shaped events** (headline + evidence_url + amount, no bodies), and the doc 23
**AI research agent** on-demand per-account brief — Opus-routed, findings verified
before becoming fields/signals, prompt-injection posture per doc 23 §6. Cache agent
findings per company with a freshness clock to control cost (doc 23 open question).

### CRM inbound (supporting)
`crm_field_mappings` default `inbound` + `authority='crm'` — once connections promote
from shadow, CRM becomes a corroboration source for firmographics. No new work beyond
the MI-9 enablement track.

### Extension (deliberately minimal)
No automatic company DOM extraction (constraint 4 posture: extension stays a compliant
citizen). Keep the existing company `VIEW_FETCH` server-side fetch trigger. The only
candidate addition — a **gesture-gated** "Save company" on company pages mirroring the
person Save — is optional and listed as a decision (doc 09 D-7), not assumed.

## 2. Source-onboarding checklist (every new feed)

1. `provider_configs` row + compliance clearance (DPA/ToS, lawful basis of the
   provider's own sourcing) — blocking.
2. `ALLOWED_PROVIDER_HOSTS` entry or `provider_origins` registration.
3. Connector or vendor adapter + parser/normalizer with golden fixtures.
4. Landing path emits: `source_records` (content-hash), `provenance_event` per field,
   `field_provenance` fold, signal rows where dated events exist.
5. `master_confidence_policy` rows for the new (field, source_type) pairs.
6. Env kill-switch, default off; per-tenant flag if user-visible.
7. Doc 08 compliance checklist pass recorded in the PR.
