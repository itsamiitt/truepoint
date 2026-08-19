# 04 — Capability blueprint

Nine capabilities (MI-1 … MI-9), each with outcome tags, the acceptance metric shape
(rule 2: time / likelihood / count), and its dependency class from doc 02
(DARK / UNFED / ABSENT). Ordering rationale in doc 09.

## MI-1 · Company as a first-class object [S-02][S-09][S-10]

Promote the account drawer to a routed `/companies/:id` page + a `/companies` list
scope with saved account searches and account lists. Content already exists
(firmographics, headcount, technographics, displacement, alumni, signals, provenance).
- **Class:** surfacing (data DARK behind linkedin_api gates).
- **AC:** time-to-answer "is this the right account and is it growing" from search →
  company page ≤ 60s; every displayed field shows provenance recency (S-10 parity with
  contact view).

## MI-2 · Signal engine v1 — populate the existing vocabulary [S-13][S-09][A-01]

Producers for the already-seeded, already-consumed signal codes, in privacy-weight
order: `job_change` (built — enable), `headcount_surge/decline` (built — enable),
`funding_round`/`acquisition`/`acquired_by`/`ipo` (licensed feed → `master_company_funding`
fact + `funding` signal), `exec_hired/departed` (derived from employment deltas already
landing), `regulatory_filing` (registry batch, doc 21 M13). Layer-0 write fans out to
Layer-1 `intent_signals`-shaped tenant copies for scoring/alerting (doc 06 §3).
- **Class:** DARK (2 codes) + UNFED (rest).
- **AC:** median lag event-observed → signal-visible ≤ 24h per family; every signal row
  carries `evidence_ref`/`evidence_url` + lawful basis (A-01: count of signal rows
  without provenance = 0, enforced by test).

## MI-3 · Watchlists, alerts, digest [S-13][S-14]

The missing structural piece. Watch an account (or a dynamic account search) →
subscribe to signal families → in-app notification + optional digest. Rides the
existing notifications feature + `saved_searches` alert semantics planned in doc 24 §8.
- **Class:** ABSENT (schema: watchlist + subscription tables, Layer-1).
- **AC:** likelihood a watched account's job-change/funding event is seen within 24h ≥
  90%; alert precision instrumented (dismiss-rate).

## MI-4 · Hiring intelligence [S-02][S-13]

`job_postings` entity (title, department, seniority, location, posted_at/closed_at,
canonical URL, company FK) + `job_posting_surge`/`key_role_opened` producers + postings
as technographic evidence (`detection_method='job_posting'` finally has an evidence
table). Source = licensed postings feed only (hard constraint 4 — no crawling).
- **Class:** ABSENT.
- **AC:** "which watched accounts opened ≥N roles in dept X this quarter" answerable in
  one query; posting → signal lag ≤ 48h.

## MI-5 · Technographics population [S-02][S-04-adjacent]

Seed `master_technologies` catalog (C4: GPL-safe — use field *shape*, license-clean
vocabulary) + licensed adoption feed → `master_technology_adoptions`. Retire the
signal-inference hack in `firmographics.ts` (documented supersession §6.5 of
`masterTechnologyAdoption.ts`).
- **Class:** UNFED, human-gated (C4 + feed procurement).
- **AC:** adoption coverage % over watched accounts (count metric, tracked per feed);
  displacement timeline renders for ≥X% of accounts with any adoption.

## MI-6 · Industry & market taxonomy [S-02][A-01]

Lookup-table taxonomy (NAICS-style hierarchy + crosswalk + synonyms) replacing
string-equality facets; map vendor strings at landing; backfill via alias table. The
`master_technology_categories` tree is the in-repo pattern.
- **Class:** ABSENT (was OQ4 deferred refinement in `prospect-company-data/PLAN_01`).
- **AC:** % of `master_companies` with a canonical industry node ≥ target; facet counts
  group by node, not spelling.

## MI-7 · Account-grain scoring [S-01][S-02]

`account_scores` (append-per-rescore, model-versioned, breakdown jsonb) + a tenant ICP
definition; fit from firmographics/taxonomy/technographics, momentum from signal
recency-weighted sums (weights = `master_signal_types.default_weight` × `half_life_days`
— the columns already exist for this). Explicitly **not** intent: inputs are company
facts only.
- **Class:** ABSENT (pattern clone of contact `scores` + `computeScore`).
- **AC:** score explains itself (breakdown renders); rescore latency after a new signal
  ≤ 1 sweep interval.

## MI-8 · Market views & aggregates [S-01][S-02]

Segment boards over the taxonomy: count/headcount-growth/funding by industry × geo ×
size band; "top movers" among watched + searchable universe. Postgres-first
materialized rollups (doc 06 §4) with the stated revisit trigger.
- **Class:** ABSENT (needs the aggregation seam).
- **AC:** segment board p95 < 500ms at current scale; numbers reconcile with drill-down
  counts (test-encoded).

## MI-9 · Sales-intel enablement track (parallel, mostly non-code)

The doc 02 §sales list: flip staged gates for linkedin_api landing, imports (after
S3/AV/COPY gates), reverification backend, provider keys/DPAs, merge/channels,
CRM promotion, extension GA (legal-gated). Owned as a runbook, not features.
- **AC:** per-gate: flag-on in staging with the feature's own outcome metric green,
  then prod.

## Explicitly not in the blueprint

Intent (X-04) · news article bodies/feeds · sequencing (D3) · AI email · org-chart
graph (O5 — sensitive-PII graph, scale-track) · warm-intro graph (O6) · conversation
intelligence (incumbent moat, `market-analysis/02` §6).
