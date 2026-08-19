# 09 — Roadmap and decision register

## Phasing logic

Cheapest-unlock first (doc 02): enable what's built → feed what's unfed → build what's
absent. Each phase dark-shippable, flag-off byte-identical, with a kill/adjust
criterion (roadmap discipline from `docs/strategy/06`).

## Phases

### MI-P0 · Ratify + enable (no schema)
- Human ratifications D-1..D-3 below.
- MI-9 enablement track begins: staged linkedin_api vertical flips
  (landing → headcount → signals), `JOB_CHANGE_SWEEP_ENABLED`, reverification backend.
- C9 confidence unification (doc 06 §5) — the one item with stated cost of delay.
- **Kill criterion:** if landed linkedin_api coverage over active workspaces' accounts
  is <40% after the flip (mirrors the Phase-1 reveal-hit bar), pause spend and fix
  matching before building surfaces.

### MI-P1 · Company object + signals v1 [S-02][S-13][S-10]
- MI-1 `/companies` destination + IA regroup (doc 07 §1–2).
- Leadership-signal emitter (in-repo derivation, no new source).
- MI-S6 `tenant_signals` + `signal_fanout` + feed UI.
- **AC gate:** company page renders with ≥1 non-empty momentum section for ≥60% of
  bridged accounts in staging tenant.

### MI-P2 · Watchlists + alerts [S-13][S-14]
- MI-S5 + `alert_dispatch` + digest. Reports tab re-label.
- **AC gate:** watched-event-seen-in-24h ≥90% in dogfood.

### MI-P3 · Licensed feeds (procurement-gated)
- Funding feed → funding facts + signals (D-4).
- Technographics catalog + feed (D-5: C4 + procurement).
- Registry/filings batch (doc 21 M13 shape).
- Each feed independently gated; no feed blocks another.

### MI-P4 · Hiring intelligence [S-02][S-13]
- MI-S1 postings + `postings_ingest` + surge signals + company-page section (D-6 feed).

### MI-P5 · Taxonomy + account scoring + market boards [S-01][S-02]
- MI-S3 taxonomy + alias backfill sweep → MI-S4/MI-S7 + boards + movers.
- Ordered last deliberately: boards without taxonomy are string-grouped garbage;
  taxonomy without feeds has nothing to normalize.

Parallel throughout: MI-9 sales-intel enablement runbook (imports gates, provider
DPAs, CRM promotion, extension GA legal gate).

## Decision register (human, recorded in `docs/strategy/decisions.md` before build)

| ID | Decision | Default proposal |
|---|---|---|
| D-1 | **Ratify the strategy change**: market-intelligence surface now, ahead of the post-Phase-6 rescore (doc 03 §4) | Ratify with the outcome-framing given; X-04 stays deferred |
| D-2 | C9 confidence unification + announced badge-band movement | Shipped leaf fn + policy-table constants |
| D-3 | Monetization: which plan tiers include company pages / watchlists / boards (`plan_templates.features` keys) | Pro+; watch-limits on Free/Community; no new currency |
| D-4 | Funding/registry feed procurement + registry commercial terms (doc 21 open question) | — (commercial) |
| D-5 | C4 GPL resolution + technographics feed procurement | Field-shape only, license-clean seed |
| D-6 | Job-postings feed procurement | — (commercial) |
| D-7 | Extension gesture-gated "Save company" — build or skip | Skip in v1 |
| D-8 | Erasure semantics for person-referencing signals: anonymize vs delete (doc 08 §2) | Anonymize to company event |
| D-9 | IA regroup approval (retiring the Contacts⇄Accounts toggle) | As doc 07 §1 |

## Risks (top 5)

1. **Feed economics** — licensed feeds are the whole supply side; coverage-per-invoice
   is tracked from day one (admin coverage dashboard, doc 07 §7).
2. **Empty-state product** — shipping surfaces ahead of P3 feeds repeats the
   intelligence-platform stall ("blocked on data, not UI"). Mitigation: P1 ships only
   sections the linkedin_api vertical feeds.
3. **Scope creep toward intent** — momentum scoring drifting into in-market inference.
   Guard: MI-7 inputs enumerated as company facts; any topic/keyword/visit input is a
   D-level decision, and the missing `intent` signal family stays missing.
4. **Aggregation load on the OLTP path** — mitigated by MI-S7 materialization + the
   revisit trigger (doc 06 §4).
5. **Suppression-gap inheritance** (doc 08 §3) — new person-rendering egress without
   the gate; AC test-encoded.

## What "done" means

A user can: search companies by normalized industry/size/tech/funding facets → open a
company page whose every field shows provenance recency → watch it → get told within a
day when it raises, hires a VP, adopts or drops a technology, or their saved contact
leaves → see their market segment's movers on a board — while nothing in the system
infers intent, reads message content, scrapes a logged-in site, or stores a personal
datum without lawful basis and provenance. That sentence is the series' acceptance
test; every clause traces to an outcome ID above.
