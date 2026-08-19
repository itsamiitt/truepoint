# 02 — Gap analysis: pillar × layer

Every pillar graded across four layers. The dominant pattern: **schema ahead of
producers ahead of surfaces**. Three distinct kinds of "missing" — do not conflate:

- **UNFED** — table + reader exist, no producer (cheapest wins)
- **DARK** — full vertical built, gates off (needs enablement, not code)
- **ABSENT** — no schema, no code (real build)

## Master table

| Pillar | Schema | Producer | API | UI | Kind | Notes |
|---|---|---|---|---|---|---|
| Company profile (firmographics) | ✅ `master_companies` + detail tables | 🌒 `linkedin_api` landing | ✅ account-intelligence + account-search | 🟡 drawer only | DARK + surfacing | Promote drawer → page; enable landing |
| Headcount growth | ✅ `master_company_headcount` | 🌒 `landSourcePayload` (25-mo series in payload) | ✅ `/accounts/:id/headcount` | ✅ `HeadcountSection` | DARK | The complete reference vertical — flip `LINKEDIN_COMPANY_REFRESH_ENABLED` etc. |
| Job-change tracking [S-13] | ✅ both signal layers | 🌒 `job_change_sweep` | ✅ `/contacts/:id/signals` | ✅ `SignalsSection` | DARK | |
| Funding rounds | ✅ `master_company_funding` + `funding` signal family | 🔲 none | 🔲 no route | 🟡 stage filter only | UNFED | Writer exists, zero callers; no investor↔round M:N, no valuation |
| Technographics | ✅ catalog + adoptions (episode grain) | 🔲 none — C4 GPL gate | ✅ technologies/displacement/peers routes | ✅ sections self-hide | UNFED | Blocked on catalog seed decision + licensed feed |
| Leadership changes | ✅ `exec_hired/departed` codes | 🔲 none | ✅ signals route | ✅ | UNFED | Derivable from `linkedin_api` employment deltas already landing |
| Filings / registries | ✅ `regulatory_filing` code, `filing` family | 🔲 none | ✅ signals route | ✅ | UNFED | Doc 21 already plans registries at M13 (EDGAR, OpenCorporates…) |
| Hiring / job postings | 🔲 no `job_postings` table — code + detection-method are vocabulary only | 🔲 | 🔲 | 🔲 | ABSENT | "Who hires for X role" unanswerable; also blocks `job_posting` tech detection |
| News / press | 🔲 nothing (only `master_signals.headline` + `evidence_url`) | 🔲 | 🔲 | 🔲 | ABSENT | Strategy lists news feeds as a non-goal — doc 03 scopes what is allowed |
| Industry taxonomy | 🔲 free-text varchar, no NAICS/SIC/GICS anywhere | — | — | facet = string equality on vendor strings | ABSENT | Weakest data-model area (data-model scan); poisons every market rollup |
| Account-grain scoring | 🔲 `scores.contact_id NOT NULL`; `accounts.icp_fit_score` bare int, no writer | 🔲 | 🔲 | drawer shows the bare int | ABSENT | No ICP definition, no model version, no history |
| Watchlists / alerts / digest | 🔲 | 🔲 | 🔲 | notifications are ops-only | ABSENT | **Largest structural gap** for market intel (web-surface scan §4) |
| Market / segment aggregates (TAM boards, top movers) | 🔲 no aggregation seam (`facetCounts` only) | 🔲 | 🔲 | 🔲 | ABSENT | Needs new port/repo or materialized rollups (doc 06) |
| Intent | ⛔ deliberately excluded (no `intent` signal family) | — | — | permanent empty Reports tabs | OUT OF SCOPE | X-04; see doc 03 |

## Sales-intelligence completion gaps (the "and" in the mandate)

The sales-intel half is mostly DARK, not absent. Becoming a credible *sales*
intelligence product is largely an enablement programme:

1. **Reveal economy end-to-end** — live; keep. Bulk reveal 🌒 `BULK_REVEAL_ENABLED`.
2. **Imports** — full v2 vertical 🌒 (`IMPORT_V2_ENABLED`/`BULK_IMPORT_ENABLED` + tenant
   flags); enable-gates are external: prod S3 bucket, AV scanner, COPY spike verdict
   (`import-and-data-model-redesign/16-Implementation-Audit.md` gate tracker).
3. **Verification** — reverification sweep no-ops without `REACHER_BACKEND_URL`; phone
   verify needs Twilio creds. Deploy dependencies, not code.
4. **Enrichment waterfall v2** — 🌒 dual-gated; providers need keys + DPA sign-offs.
5. **Contact merge, channels train, job-visibility** — 🌒 composed fail-closed gates.
6. **CRM sync writes** — connections sit in `shadow`; promotion is a per-connection op.
7. **Extension** — 🌒 `CHROME_EXTENSION_ENABLED` + `EXTENSION_ORIGINS`; capture GA
   additionally gated on legal sign-off (ADR-0043 §9, decisions.md 2026-08-18).
8. **Confidence badge** — live at v1; C9 unification pending (prerequisite for honest
   freshness claims at market scale — doc 06 §5).

## The two cheapest unlocks (read this before the roadmap)

1. **Flip the linkedin_api vertical on** (staged): one enablement decision populates
   headcount, firmographics, job-change + headcount signals — and the already-shipped
   UI sections stop self-hiding. Zero schema, zero new code paths.
2. **Write the two missing producers with consumers already waiting**: `funding_round`
   and `tech_install` have rollup + UI consumers idle today
   (`intelligence-platform/07-integration-and-producers.md`). Each needs a licensed
   source (doc 05), not an invented one — inventing collection violates hard
   constraint 4.
