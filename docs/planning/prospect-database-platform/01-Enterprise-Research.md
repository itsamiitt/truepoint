# 01 — Enterprise Research

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 01 · **Status:** ✅ Drafted
> · **Prev:** [`00-Vision-and-Scope`](./00-Vision-and-Scope.md) · **Next:** `02-Current-State-Deep-Audit`

---

## 1. Executive Summary

This phase researches how leading Sales-Intelligence platforms operate the **net-new spine** of our program —
multi-source ingestion, identity resolution + accuracy scoring, waterfall enrichment with reuse, the knowledge
database (lineage/freshness), browser-extension capture, and data-operations stewardship — and synthesizes a
TruePoint design intent for each (not a copy of any one product). It complements
[`database-management-research/02`](../database-management-research/02-Enterprise-Research.md) (which covered 23
processing dimensions) by focusing on the **platform/ingestion/knowledge-graph** layer.

The throughline across ZoomInfo, Apollo, Clay, Cognism, Lusha, RocketReach, Seamless.AI, Sales Navigator, and the
CRM incumbents: **data is a compounding asset, not a feed.** It is collected from many channels, resolved to a
canonical identity, enriched *once* and reused, scored for trust + freshness, versioned with lineage, and governed
by a stewardship team. Every decision below is weighed against TruePoint's two-layer model (Layer-1 overlay /
Layer-0 master graph) and multi-tenant RLS.

## 2. Objectives

- Compare ≥2 industry approaches per spine area; capture advantages/disadvantages.
- Extract the **pattern** (not the product) and state the **TruePoint synthesis** for each.
- Surface the compliance + cost + scale constraints that the design phases (03–09) must honor.

## 3. Research Findings

### 3.1 Multi-source ingestion & the "contributory network"

- **ZoomInfo** blends four channels into one pipeline: ML scanning ~28–38M domains/sources **daily**, a
  **contributory network** of 200k+ users who share email-signature + contact-book data in exchange for access,
  third-party partner data, and a 300+ person human-research/verification team. [ZoomInfo, AeroLeads]
- **Apollo / Cognism / Seamless** run similar "community + partners + crawl" intake, differing mainly in
  compliance posture (Cognism leans GDPR/CCPA-cleansed + phone-verified "Diamond Data").
- **Pattern:** a *unified ingestion contract* behind many collectors; the source is recorded as **provenance**,
  and the same record can be re-observed from multiple sources (each observation is evidence, not an overwrite).
- **Trade-off:** contributory data maximizes coverage but raises consent/PII-source risk; crawl data is broad but
  noisy and needs heavy verification.
- **TruePoint synthesis:** a single idempotent ingestion entry (content-hash + idempotency-key, as `runImport`
  already uses) that every collector implements; each ingest writes an **immutable evidence row** (`source_records`,
  today unwritten — audit A2) carrying source + collected-at + confidence, *then* resolves identity. This is the
  substrate the knowledge DB (Phase 05) is built on.

### 3.2 Identity resolution, matching & accuracy scoring

- **ZoomInfo** resolves with deterministic keys (e.g. 200M+ IP-to-org pairings) and publishes a **Contact Accuracy
  Score** = P(person is employed at the profiled company) × confidence the email is correct + current, factoring
  **NeverBounce** validation status, record richness, and **how recently** each data point was validated. Email
  cleaning runs 20+ steps, re-checking an address up to 75×. [ZoomInfo help; ZoomInfo Pipeline]
- **D&B / Salesforce Data Cloud** lean on stable entity ids (DUNS) + probabilistic match-keys for company linking.
- **Pattern:** *deterministic-first, probabilistic-fallback* matching into a canonical entity, with a **published
  confidence score** that decays with age and rises with corroboration.
- **Trade-off:** deterministic is precise but misses; probabilistic lifts recall but risks "Frankenstein" merges —
  so the best systems bias to **false-negatives** above a steward-review threshold.
- **TruePoint synthesis:** keep the shipped deterministic resolve-or-mint
  (`masterGraphRepository.resolveForImport`), add a **probabilistic tier** (Fellegi-Sunter / Splink-style weights)
  that writes `match_links` with a `review_status` (the clerical queue, today empty), and compute a **trust +
  freshness score** per record/field from validation status + corroboration count + recency. Above the auto-merge
  threshold → steward review (Phase 04/08), never a silent merge.

### 3.3 Waterfall enrichment + reuse (the cost-control core)

- **Clay** popularized **waterfall enrichment**: query providers *in a configured order*, each gated "run only if
  the field is still blank", stop at the first hit; 75+ providers; coverage +30–50% vs single-provider, ~80%+
  email discovery; **you pay one credit per provider hit**, so a 4-try contact costs 4×. [Clay; LeadMagic]
- **ZoomInfo/Apollo** instead serve from one owned database first (cheap), falling back to partners.
- **Pattern:** an **ordered provider waterfall** with per-step "only-if-missing" gating + **reuse-before-call**
  (check the knowledge DB first) + **refresh rules** (don't re-enrich fresh data; do re-verify stale data).
- **Trade-off:** waterfalls maximize coverage but multiply cost + latency; owned-DB-first is cheap but stale —
  the answer is *cache + freshness TTL + worst-case spend pre-compute*.
- **TruePoint synthesis:** an enrichment engine that (1) checks the knowledge DB for a fresh value before any
  provider call, (2) runs a configurable provider waterfall with only-if-missing gating, (3) caches every result
  with a confidence + freshness clock, (4) **pre-computes worst-case spend** (the pattern already shipped for
  reveal in `estimateBulkSpend`) and gates bulk runs behind it, (5) records provider history for auto-selection.
  This directly fixes audit A3 (the bulk pipeline today has no worker + no spend gate).

### 3.4 The knowledge database — lineage, version history, freshness

- The accuracy-score systems above are only possible because every value carries **source attribution, a
  validation timestamp, and a confidence** — i.e. a **lineage + version** model under the golden record.
- **Pattern:** the golden record is a **derived projection** over an immutable evidence log; changes are appended
  (new observation), never destructive; "version history" = replay of the log; freshness = max(validated-at) per
  field; refresh = re-observe when a field's TTL expires.
- **Trade-off:** an append-only evidence model costs storage + a projector, but it is the only way to support
  rollback, "why is this value here?", and non-destructive merge/unmerge.
- **TruePoint synthesis:** populate `source_records` (evidence) + `match_links` (cluster membership) on every
  ingest; add a **survivorship projector** that rebuilds the golden `master_*` columns + `field_provenance` from
  the log (the seam exists, unread). Version history + lineage + non-destructive merge all fall out of this. This
  is Phase 05, and it is the prerequisite the export/dedup audit (A2) flagged.

### 3.5 Browser-extension capture + compliance

- **Apollo/ZoomInfo extensions** capture from LinkedIn, Gmail, company sites, and CRMs — "Save contact / access
  email & phone" inline, with org-charts/tech-stack/intent shown on the profile. [Apollo KB; ZoomInfo Pipeline]
- **Compliance reality:** "BrowserGate" reporting (June 2026) shows LinkedIn actively scanning visitors' browsers
  for 6,000+ extensions; scraping ToS + consent are live legal risks. [Tom's Hardware; Computing]
- **Pattern:** capture is a **queued ingestion source** (the extension posts to the same unified entry, async),
  with **consent/compliance checks at capture time** and dedup/enrich *server-side*, not in the page.
- **Trade-off:** extensions massively boost coverage but carry ToS/scraping/consent exposure — so capture must be
  consented, rate-limited, source-attributed, and suppression-aware from the first byte.
- **TruePoint synthesis:** the extension is *one connector* on the unified ingestion contract (Phase 03/06); it
  never writes the DB directly — it enqueues an evidence row that flows through the same validate→resolve→enrich→
  suppression pipeline. Security/compliance (Phase 09) owns the consent + ToS + residency gates; *Security has
  final say.*

### 3.6 Data-operations & stewardship

- Every accurate vendor runs a **human + ML stewardship loop**: ML proposes, humans review the uncertain tail
  (ZoomInfo's 300+ researchers; the clerical-review queues in MDM tooling), with **match-confidence thresholds**
  routing only ambiguous cases to people.
- **Pattern:** a **review queue** (new / pending-enrich / failed / duplicate) + manual approve/reject + merge/split
  + conflict resolution + bulk admin, all audited, with quality dashboards.
- **TruePoint synthesis:** the Database-Operations module (Phase 08) extends the shipped read surfaces with the
  *operate* verbs — over the maker-checker approval engine already built — so destructive ops (merge, bulk delete,
  enforce, export) stay approval-gated and audited.

## 4. Cross-cutting decisions recorded here (rationale)

1. **Evidence-log-first** (not golden-column-first): chosen for lineage/rollback/non-destructive-merge despite the
   projector cost — it is the foundation every other capability needs.
2. **Reuse-before-enrich + freshness TTL + waterfall**: chosen over "always call the best provider" to control the
   metered cost that continuous multi-source ingestion would otherwise explode.
3. **Capture is a connector, server-side processing**: chosen over in-page enrichment for compliance, dedup
   correctness, and suppression enforcement.
4. **Deterministic-first, probabilistic-fallback, steward-the-tail**: chosen to lift recall without Frankenstein
   merges; bias to false-negatives above threshold.

## 5. Risks / compliance signals for later phases

- Contributory + extension capture ⇒ **consent, scraping-ToS, PII-at-source, residency** (Phase 06/09; legal sign-off).
- Waterfall enrichment ⇒ **runaway metered spend** without the pre-compute gate (Phase 07).
- Evidence-log migration ⇒ must **dual-write** alongside the shipped deterministic landing without regressing it (Phase 04/05).

## 6. Implementation Checklist (this phase)

- [x] Researched ingestion / identity / enrichment / knowledge-DB / extension / data-ops patterns (cited).
- [x] Per-area advantages/disadvantages + TruePoint synthesis recorded.
- [x] Cross-cutting decisions + rationale captured.
- [ ] Phase 02 (Current-State Deep Audit) — next iteration: map every gap vs these patterns, grounded in code.

## 7. Sources

- [How Does ZoomInfo Work? Full 2026 Breakdown — Prospeo](https://prospeo.io/s/how-does-zoom-info-work)
- [How Did ZoomInfo Get My Information? — AeroLeads](https://aeroleads.com/blog/how-did-zoominfo-get-my-information-sources-behind-your-profile/)
- [Overview of the Contact Accuracy Score — ZoomInfo Help](https://help.zoominfo.com/s/article/Overview-of-the-Contact-Accuracy-Score)
- [Data Demystified: Email Accuracy & Verification — ZoomInfo Pipeline](https://pipeline.zoominfo.com/sales/data-demystified-email-accuracy-verification)
- [Data Waterfalls: Maximize Contact Coverage — Clay](https://www.clay.com/blog/data-waterfalls)
- [Clay Waterfall Enrichment Guide — LeadMagic](https://leadmagic.io/guides/clay-waterfall-enrichment-guide)
- [Prospect on LinkedIn with the Apollo Chrome Extension — Apollo](https://knowledge.apollo.io/hc/en-us/articles/4409229262093-Prospect-on-LinkedIn-with-the-Apollo-Chrome-Extension)
- [10 Best Email Finder Extensions for 2026 — ZoomInfo Pipeline](https://pipeline.zoominfo.com/sales/email-finder-extensions)
- [LinkedIn scans visitors' browsers for 6,000+ extensions ("BrowserGate") — Tom's Hardware](https://www.tomshardware.com/software/browsers/linkedin-scans-visitors-browsers-for-over-6000-chrome-extensions-and-collects-device-data)
