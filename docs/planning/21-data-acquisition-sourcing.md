# 21 — Data Acquisition & Sourcing

> How records **enter the platform** and how we keep that lawful and defensible: source channels,
> ingestion cadence, provider vetting + DPAs, the **lawful-basis lineage chain**, EU-compliant sourcing,
> and the contribution network. Upstream of enrichment ([06](./06-enrichment-engine.md)) and quality
> ([22](./22-data-quality-freshness-lifecycle.md)); feeds the master graph ([ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)).

## 1. Principles

- **Provider-independent.** No single vendor owns our coverage; a **waterfall** (`06 §3/§4`) blends
  sources, and a **dedicated verifier** grades the result (`22`, [ADR-0013](./decisions/ADR-0013-charge-for-verified-data-credit-back.md)).
- **Lawful by construction.** Every channel has a documented lawful basis and DPA **before** production
  use; we track provenance to the source (`source_records`/`source_imports`, `H3`).
- **Cache-first & cost-aware.** Re-use known records before paying a provider (`06 §5`); cost metered per
  call (`provider_calls.cost_micros`).

## 2. Source channels

| Channel | What | Mode | Milestone |
|---|---|---|---|
| **Enrichment providers** | Apollo / ZoomInfo / Clearbit (+ EU: Cognism / Lusha) | waterfall, licensed (`06 §3`) | M4 / M13 |
| **Email/phone verifiers** | ZeroBounce / NeverBounce; Twilio Lookup / Telnyx | grade on reveal + re-verify (`22`) | M4 |
| **Intent / technographic** | Bombora · G2 · 6sense; BuiltWith · HG Insights | account/domain signal feeds (`06 §2`) | M8 |
| **Public registries** | SEC EDGAR · Companies House · OpenCorporates · Crunchbase | scheduled batch ingest (firmographics) | M13 |
| **CRM / CSV** | customer-imported contacts/accounts | per-workspace import (`05 §3`) | M1 |
| **Sales Navigator** | operator-assisted capture | **human-in-the-loop**, ToS-aware (`06 §8`) | M7 |
| **Contribution co-op** | opt-in customer data feeding the master graph | **opt-in + disclosed**, off by default (§7) | M13 |

**Scraping stance:** no general-purpose web scraping ([02 §2](./02-architecture.md)); web access is limited
to the **AI research agent** (`23`) over public pages, with output **verified** before it becomes a field.

## 3. Ingestion cadence & SLAs

| Channel | Cadence |
|---|---|
| Providers (on-demand) | at import/reveal, cache-first |
| Public registries | scheduled batch (e.g. weekly firmographics, daily filings where relevant) |
| Intent feeds | provider cadence (daily/weekly), rolling 30-day window (`22`) |
| Re-verification | by freshness SLA (`22 §3`) via `verification_jobs` |

Every ingest writes immutable evidence to `source_records` (master) and `source_imports` (overlay), feeding
entity resolution ([ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md)/[ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md)).

## 4. Provider vetting & sub-processor management

- **Vendor due diligence** before onboarding a source: lawful-basis review, DPA + sub-processor agreement,
  security posture, data-residency, opt-out honoring. Tracked in the sub-processor register (`08 §10`).
- **`provider_configs`** (platform, `13 §4`) holds per-provider setup, rate limits, cost, **and compliance
  status**; a provider not cleared cannot be enabled.
- Channel-specific **legal review** (Sales Nav/LinkedIn ToS, registry licensing) gates production
  (`08 §11`).

## 5. Lawful-basis lineage chain

- Beyond `source_name`, each contributing source record carries the **lawful basis** it was collected
  under (legitimate interest / consent / public record) and the provider's basis, forming a
  **lineage chain** queryable for DSAR and audits ("provenance you can show an auditor", `15`).
- Lineage flows into compliance: DSAR access shows where data came from; deletion fans out across the chain
  (`08 §4`, `H6`); suppression overrides all sources (`H5`).

### 5.1 Per-import lawful-basis attestation (user uploads)

Licensed providers carry the provider's basis in their contract; **customer uploads (CSV/XLSX/CRM sync) do
not** — uploaded data is the **highest-risk channel** because the lawful basis is the *uploader's* to assert,
not ours to infer. So every bulk import job records an explicit **lawful-basis attestation** before its rows
become usable, closing the gap where upload lineage was silent.

- **Default basis per workspace.** A workspace sets a default upload lawful basis
  (`legitimate_interest` / `consent` / `public_record`) in settings (`12`), applied to imports that don't
  override it.
- **Per-import field + attestation.** The import wizard (`05 §3`) requires the uploader to confirm a
  **lawful basis for this file** and **attest they have the right to upload and process it** — a checkbox
  attestation (who/when, the asserted basis, and the per-import notes) recorded on the **import job**
  ([30](./30-bulk-import-export-pipeline.md), [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)).
  The job will not enqueue without it.
- **Mixed-basis handling.** A file may carry rows of differing bases (e.g. a column flagging consented vs.
  legitimate-interest rows). The import supports a **per-row basis column mapping**; unmapped rows fall back
  to the import's declared basis, and the **most restrictive** basis present governs any whole-file decision
  (e.g. co-op eligibility below).
- **Propagated to lineage.** The attested basis is written into the per-import `source_imports` lawful-basis
  snapshot (`08 §11`) so the **lineage chain** above shows *upload* provenance the same way it shows provider
  provenance — DSAR-answerable and audit-defensible.
- **Gates co-op contribution.** Only rows whose attested basis permits onward sharing are eligible to feed
  the **contribution co-op** (§7); a `legitimate_interest`-only or unattested import is **excluded from
  co-op contribution** regardless of the workspace's co-op opt-in. This makes the co-op flywheel
  lawful-by-construction, not opt-in-by-accident.

Set-based suppression/DNC screening of imported rows at ingest, upload virus scanning, and the
rejected-rows artifact policy are specified in compliance (`08 §3.1`/`§9`); the bulk job mechanics live in
[30](./30-bulk-import-export-pipeline.md) / [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md).

## 6. EU-compliant sourcing & residency

- For EU subjects, prefer **compliance-first providers** (Cognism/Lusha) and registry sources with clear
  bases; respect ePrivacy consent where required (`08 §2`).
- Records carry `region`/`jurisdiction` tags ([ADR-0006](./decisions/ADR-0006-per-workspace-multitenant-model.md))
  for the later EU residency split (`08 §8`).

## 7. Contribution / community data network

- **Opt-in, disclosed, off by default** (`06 §1`): a workspace may contribute imported/synced data to the
  master graph under explicit, documented consent, improving shared coverage.
- Contributions are de-identified of workspace-private curation (notes/scores stay Layer 1), entity-resolved
  into golden records, and **attributed** for quality weighting; contributors get coverage/freshness
  benefits. Disclosure language + controls live in settings (`12`) and compliance (`08`).

## 8. Coverage strategy

- Blend licensed + registry + contribution to maximize **email/phone coverage** and firmographic
  completeness, measured against the targets in [22 §5](./22-data-quality-freshness-lifecycle.md).
- Waterfall ordering learns hit-rate per provider×field (`06 §4`); gaps trigger registry/contribution
  fill; persistent gaps inform provider procurement.

## Links
- **Links to:** [06 §1/§2/§3/§8](./06-enrichment-engine.md), [03 §5](./03-database-design.md),
  [08 §2/§3.1/§4/§10/§11](./08-compliance.md), [22](./22-data-quality-freshness-lifecycle.md), [10](./10-roadmap.md),
  [13 §4](./13-platform-admin.md), [30](./30-bulk-import-export-pipeline.md),
  [ADR-0021](./decisions/ADR-0021-global-master-graph-and-overlay.md),
  [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md),
  [ADR-0015](./decisions/ADR-0015-entity-resolution-dedup-engine.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [06 §2](./06-enrichment-engine.md), [08 §11](./08-compliance.md), README

## Open questions
1. Contribution co-op incentive + disclosure model (what contributors get; consent UX) — `12`/`08`.
2. Registry licensing scope (which registries at GA; commercial-use terms).
3. EU provider mix + residency split timing (`08 §8`).
