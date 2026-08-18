# 03 — Scope and constraints (rule 6: surface conflicts, never reinterpret)

## 1. The in-scope boundary is already drawn — cite it, don't redraw it

`intelligence-platform/07-integration-and-producers.md` §1 (resolution RD-4), verbatim
in substance: signal families **hiring, funding/M&A, tech-stack change, leadership
change, filings are company facts, in scope**, carrying far lighter privacy weight than
person-level intent. Family "intent / content engagement" is deferred non-goal **X-04**.

Therefore this series defines *market intelligence* as: **company-level facts and dated
events, plus aggregates over them** — never person-level in-market inference.

## 2. Non-goals held (with their enforcement points)

| Non-goal | Enforcement | Effect on this series |
|---|---|---|
| X-04 intent data | `docs/strategy/04` ("revisit after Phase 5"); schema-level: `master_signal_types.family` CHECK has **no `intent` value** | No intent family, no topic taxonomy, no surge scoring, no bidstream vendor. Reports "Intent" tab stays honest-empty or is re-labelled (doc 07) |
| X-01 sequencing | decisions.md **D3 — frozen, zero capacity** | No market-intel work rides the outreach/email engine |
| X-02 AI email writing | `04` non-goal | none |
| S-05 raw database size | `04`: "buy/license the baseline, never compete on the number" — **softened** by decisions.md 2026-08-18 "Layer-0 becomes THE product database" | Market data breadth = what is licensed. No crawl fleet. The 2026-08-18 reversal legitimises *serving* licensed breadth; it does not legitimise *collecting* for breadth |
| News/social **feeds** | Not a channel in `07-data-flywheel` §channel-6; CLAUDE.md non-goals | No streaming news ingestion. Allowed forms: (a) signal-shaped events from licensed feeds (funding/M&A/filing announcements as dated events with `headline` + `evidence_url`, no article bodies), (b) the on-demand AI research agent of `23-ai-intelligence-layer.md` §3 — verified-before-persist, never a feed. Anything beyond needs a decisions.md entry |
| Hard constraint 4 | CLAUDE.md — no background/bulk scraping of logged-in sites, no collection beyond user-initiated extension actions | All new acquisition = licensed vendor feeds, public registries under their terms, or user-initiated capture. The extension gains **no** automatic company scraping |

## 3. Three unreconciled tensions — named, with this series' position

1. **Contact-level intent** — `market-analysis/06` M3 sells it as an edge; strategy X-04
   + compliance rule 3 forbid it now. **Position: strategy wins.** M3 is cited only for
   its account-vs-contact observation; nothing here builds toward it.
2. **Compliant send as keystone** — `market-analysis/06` M1 vs decisions.md D3 freeze.
   **Position: D3 wins.** Market intel here terminates at signal → alert → play
   *recommendation*; execution hand-off is CRM/integration, never the frozen sequencer.
3. **Search engine topology** — `24-advanced-search-exploration-ux.md` plans
   OpenSearch/Typesense/ClickHouse; decisions.md 2026-08-18 makes **Postgres the global
   read path**. **Position: 2026-08-18 wins.** Doc 24 is cited for UX semantics
   (facets, synonym expansion, saved-search alerts) only. Aggregates are designed
   Postgres-first with a stated revisit trigger (doc 06 §4).

## 4. The strategy-change that must be ratified (rule 6)

Two facts, stated plainly rather than reinterpreted:

- `docs/strategy/06-roadmap.md` ends: *rescore everything (including X-04) with real
  data after Phase 6; re-plan.* A market-intelligence product surface **now** is ahead
  of that sequencing.
- `docs/market-analysis/03-market-gaps.md` §10 does **not** list market intelligence as
  whitespace — this series proposes something the 2026-06 analysis did not surface. The
  competitor set would also need a new tier (6sense/Demandbase/Bombora are currently
  profiled as providers, not competitors).

The defensible framing (and the one this series adopts): the in-scope pillars all
advance **already-top-of-board outcomes** — S-13 (job changes, 13.6), S-09 (person
still there, 14.0), S-10 (confidence visible, 13.2), S-02 (locate right accounts,
10.4), A-01 (provenance, 13.7). Market intelligence is packaged as those outcomes'
account-level expression, not as X-04 by the back door. **A human still ratifies this
in `docs/strategy/decisions.md` before build** — decision register, doc 09.

## 5. Standing engineering constraints inherited

- Layer-0 tables: `master_`-prefixed, grant-off from `leadwolf_app` (the `^master_`
  REVOKE loop in `applyMigrations.ts`), partition ACL mirroring, hand-authored
  migrations outside the schema barrel for partitioned tables.
- Signals: `payload` carries **no PII** (`assertNoContactValues`); person-referencing
  signals point at `master_persons.id`, never embed channels.
- Cross-tenant enumeration (fan-out sweeps): owner-connection census returns ids only,
  per-workspace `withTenantTx` writes — the C-02 boundary
  (`intelligence-platform/07` §census).
- Customer-supplied URLs are never fetched (SSRF forward-guard,
  `import-and-data-model-redesign/16`, connected-source imports deferred). Vendor
  fetches ride `vendorProvider` (https-only, `ALLOWED_PROVIDER_HOSTS` allowlist,
  timeout, size cap, no-redirect) or the pinned `provider_origins` fleet.
- Every gate: env kill-switch default-off explicit-`"true"`, plus a per-tenant flag for
  user-visible features (the dual-gate discipline); flag-off byte-identical.
- Two-surface rule: customer surfaces in `apps/web` under org roles; staff/admin
  surfaces in `apps/admin` under staff capabilities. Never crossed.
- Provider vetting: a provider without cleared compliance status in `provider_configs`
  cannot be enabled (`21-data-acquisition-sourcing.md` §4).
- Vendor names collapse to "Data source" in customer UI (`packages/types/src/sourceLabel.ts`).
