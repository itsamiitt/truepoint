# 20 — Final Recommendations

> **Priority:** P0 · **Effort:** decision document (the work is scoped in `17-phased-implementation-roadmap.md`)
> · **Phase:** decisions now · Cite problems as **P-01.x**.

## Executive summary

Forge is the right idea, half-built, and quietly off-course from its own plan. The idea — a single
enterprise data platform that owns ingestion, resolution, governance, and the golden record, so no data
enters TruePoint unresolved or ungoverned — is exactly what a company competing with ZoomInfo, Apollo,
Clearbit, and Cognism needs. The build has the correct *shape* (the medallion pipeline, an
entity-resolution scorer, a four-eyes gate, a hash-chained audit) but does not yet run end to end, trusts
the client on its most sensitive write paths, duplicates identity-critical logic already present in the
main app, and diverges from the frozen planning suite in fundamental ways (separate repo → nested; HTTP
sync → in-process; real capture SDK → stub). None of this is fatal, and most of it is cheap to fix now,
because **capture and sync are dark and there is no production data at risk** — that is the entire window
this program exploits.

This document records the decisions leadership must make, in priority order. The headline: **ratify the
nested build, fix correctness and the write path before any flag flips (F1), then build the enterprise
core on Postgres + cheap object storage + ClickHouse (F2), add scale and the compliance spine (F3), and
scale out only at measured triggers (F4)** — buying nothing heavyweight and spending the saved budget on
the legal and governance work that actually sinks data vendors. The single most urgent technical action is
converging the duplicated blind index and content hash (they silently corrupt identity); the single most
urgent non-technical action is starting the compliance/legal track, whose regulatory clock is already
running.

## Current state (the one-paragraph version)

~5,200 lines landed in one 2026-07-07 wave: `packages/forge-core` (well-structured, DI'd domain logic),
`apps/forge-api` (capture edge + BFF), `apps/forge-worker` (the stage processors), `apps/forge` (a
staff-gated console whose screens don't yet render real data), a 5-line capture-SDK stub, and an isolated
`forge` Postgres schema. The pipeline is severed in at least four places (parse can't write, extraction is
discarded, sync has no scheduler, the extension feeds a stub that loses data); the golden-layer write path
is client-assertable; fourteen concerns are implemented twice; and there are no forge integration tests in
CI. Full detail: `01-current-architecture-audit.md`.

## Problems identified (the decisions they force)

The audit surfaces thirty-one problems (P-01.x) across correctness, security, reliability, tenancy,
governance, and duplication. They collapse into six decisions leadership actually has to make; the rest is
execution the roadmap already sequences.

- **P-20.1 — DECISION · Plan vs build.** The planning suite and the code disagree on repo shape, sync
  transport, roles, and the SDK. Someone must decide which is authoritative. **Recommendation: ratify the
  build's nesting, amend the plan.**
- **P-20.2 — DECISION · When do the flags flip?** Capture/sync GA is a go/no-go that must be gated, not
  drifted into. **Recommendation: gate on the F1 security DoD + F3 compliance spine, per-tenant canary.**
- **P-20.3 — DECISION · Interception.** ADR-0046 (MAIN-world raw-API interception) is proposed but
  contradicts the earlier ADR, the founder brief, and the corpus's own ESCALATE verdict.
  **Recommendation: reject interception-as-primary; keep visible-DOM; keep the ADR dark and
  counsel-gated.**
- **P-20.4 — DECISION · Build vs buy for ER, search, orchestration, catalog.** **Recommendation: build ER
  on Postgres; adopt OSS for the rest; buy nothing heavyweight (see `16`).**
- **P-20.5 — DECISION · Duplication convergence ownership.** Two new shared packages
  (`@leadwolf/identity`, `@leadwolf/pipeline-kit`) need an owner and a sequence. **Recommendation:
  identity-critical pairs first, in F1.**
- **P-20.6 — DECISION · Compliance investment timing.** **Recommendation: fund the legal track from F1,
  not F3 — the clock is already running.**

## Research findings (what the evidence says to do)

The research across storage, entity resolution, governance, pipelines, search, and AI (fact-pack §7–§11)
converges on a consistent verdict for a startup with enterprise ambitions and a small team: **stay on
Postgres far longer than instinct suggests** (OpenAI runs 800M users on one primary + replicas); **add
only cheap, self-hostable substrates with explicit triggers** (R2 for the raw archive, ClickHouse for
telemetry); **build entity resolution in-house on Postgres** (Splink-trained Fellegi-Sunter — free,
explainable, proven at 100M+ — vs six-figure Senzing/AWS-ER/Tamr); **make the pipeline durable by making
Postgres its source of truth** (transactional outbox + per-record state, not a heavyweight orchestrator);
**evolve search Postgres → ParadeDB → OpenSearch**; **run AI as a deterministic-first Claude cascade with
the Batch API and content-hash caching** ($0.5–1.5K per million records, not per thousand); and **treat
compliance as engineering, not paperwork** — provenance per field, DSAR that reaches every store, and the
Art-14/registration/DPDP obligations whose deadlines are near. Every one of these is documented with
primary sources in the sibling documents.

## Enterprise best practices (the bar)

The vendors Forge means to compete with treat the ingestion-and-resolution pipeline as the product: every
stage idempotent and observable, the resolution gate never optional, identity resolved by an explicit
hierarchy with reversible merges, provenance tracked per field for quality and compliance, the golden
record a pure replayable function of its inputs, deletion real across every store, and the whole path
integration-tested because a silent break corrupts the core asset. Forge has the components; the work is
wiring them into a correct, tested, observed, governed whole. That is achievable by a small team on the
existing stack — the research shows the expensive substrates are deferrable, not required.

## Recommended architecture (the program, in one place)

The target is documented in full across docs 02–16; the shape:

```text
 sources ─┐
  CSV     │   ┌─────────────┐   bronze        silver         gold           master graph
  extension├──►│ capture edge │──► raw (R2, ──► parsed ──► AI ──► resolve/ER ──► verified ──► Layer-0
  providers│   │ (envelope v2)│   immutable)   (Postgres)  extract  (one engine)  (golden)    (public)
  future ──┘   └─────────────┘        │            │          │         │            │           │
                                       └─ provenance per field · outbox + per-record state · DSAR reaches all ─┘
                                                          │
                           telemetry/events → ClickHouse ─┴─ OTel → SigNoz ; search: PG→ParadeDB→OpenSearch
```

The seven load-bearing recommendations, each argued in a sibling document:

1. **Ratify the nesting; amend the plan** (`02`, this doc). The nested monorepo is the right call for a
   small team — one toolchain, one deploy, shared packages. Formally amend the planning suite so future
   work follows the real architecture, and accept or amend ADR-0046/0047 rather than leaving them
   "Proposed-but-Locking."
2. **Correctness and the write path first** (`01`, `08`, `13`). F1 fixes the severed pipeline, makes
   four-eyes server-enforced, recomputes hashes and measures bytes server-side, and lands the E2E +
   isolation + identity-match tests in CI — all while the flags are dark.
3. **Kill the identity-critical duplication now** (`16`, `05`, `06`). One blind index, one content hash,
   one ER engine, converged into `@leadwolf/identity` with a parity test, before the drift poisons the
   master graph.
4. **Build the platform core on Postgres + R2 + ClickHouse** (`09`, `08`, `12`). Provenance-first model,
   raw payloads to R2 (encrypted, replayable), the transactional-outbox reliability spine, ClickHouse
   telemetry, OTel + SigNoz, real per-tenant AI budgets. No Iceberg, no Kafka, no data mesh.
5. **One entity-resolution engine, Postgres-native** (`05`, `06`). Deterministic ladder → Fellegi-Sunter
   (weights trained offline in Splink/DuckDB) → union-find with guardrails → field-level survivorship →
   the identity graph; the main app's inert `er/` deleted per ADR-0047.
6. **Compliance as a P0 workstream** (`07`, `13`, `18`). Start counsel and DPIA/LIA in F1; provenance and
   the DSAR executor in F2; Art-14 notices, US data-broker registration, the DROP poller, and DPDP work in
   F3 — with interception kept dark and visible-DOM as the survivable posture.
7. **Scale out only at triggers** (`14`, `16`). OpenSearch at 30–50M records, DuckLake when raw exceeds
   1–5 TB, Citus when the primary saturates — each a measured condition, not a default.

## Implementation details (the decision sequence for leadership)

In priority order, the decisions and their first actions:

1. **Ratify the nested architecture** and task an owner with amending the planning suite + the two ADRs
   (1 meeting; unblocks everything). — P-20.1, R-21/R-24.
2. **Freeze the capture/sync flags off in the deploy template** and make the F1 security DoD the written
   gate for flipping them (1 policy decision). — P-20.2, R-01.
3. **Stand up F1** as the immediate engineering priority: the correctness fixes, the server-enforced write
   path, the identity convergence, and the CI test floor (~6–8 eng-weeks). — R-04/R-05/R-02.
4. **Kick off the legal/compliance track in parallel** (counsel engagement, DPIA/LIA, registration prep) —
   it has the longest lead time and the nearest external deadlines. — P-20.6, R-10.
5. **Decide interception now, on paper:** reject MAIN-world as primary, keep the ADR dark. — P-20.3, R-11.
6. **Approve the build-vs-buy posture** (build ER + DQ + observability; adopt R2/ClickHouse/ParadeDB/
   SigNoz/Splink/Hatchet; buy nothing heavyweight) so the team stops re-deciding per feature. — P-20.4.
7. **Assign the two shared packages** (`@leadwolf/identity`, `@leadwolf/pipeline-kit`) an owner and the
   F1/F2 convergence sequence. — P-20.5.

Exact file paths, DDL, and interfaces are in the owning documents; this list is the order in which the
decisions unblock the work.

## Migration strategy

The whole program is delivered behind flags with the additive → dual-write → backfill → parity → cutover →
delete pattern (`19-migration-plan.md`). The dark capture/sync flags are the outermost safety net: F1 and
most of F2 change a pipeline nothing depends on yet. The one change that touches live data — the
identity-key convergence against the main-app master graph — gets the full dual-gate + identity-match-test
ceremony. Capture/sync graduate to production only via a per-tenant canary with the compliance gate green.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Flags flipped before F1 correctness/security land (R-01) | Medium | Critical | Written go/no-go gate; flags off in template |
| Duplication left to drift, master graph corrupted (R-04) | High if deferred | High | Converge identity-critical pairs in F1 with a parity test |
| Compliance clock missed (R-10) | Medium | High | Legal track starts in F1; registrations are fast |
| Plan/build drift unreconciled (R-21) | High if ignored | Medium | Ratify + amend in the first F1 week |
| Small team over-committed (R-23) | Medium | Medium | F4 is trigger-gated; buy-nothing keeps ops low |

## Success metrics

- **F1:** an E2E test lands a synthetic capture and produces a `verified_records` + `master_*` row in CI;
  zero client-trusted write-path values; one blind index/hash with a green identity-match test; the outbox
  drains; capture/sync still dark.
- **F2:** provenance on every gold field; raw payloads in R2, encrypted, none in Postgres; one ER engine
  producing reversible golden clusters; a DSAR erases a subject across all stores; AI spend recorded and
  bounded per tenant.
- **F3:** search within SLO at 10M rows; registrations filed and Art-14 notices sending; a per-tenant
  canary runs capture→sync in production with the compliance gate green; ≤1% of records hit human review.
- **Program:** Forge becomes the single, tested, observed, governed path for data entering TruePoint — no
  ingestion source bypasses it, and its golden records feed the master graph cleanly.

## Effort & priority

**P0** — this is the decision record the rest of the program hangs on. The engineering is ~9–12 months for
a 2–3-person pod (F1 ~6–8 eng-weeks, F2 ~14–18, F3 ~16–22, F4 trigger-gated), plus a parallel legal track
(~$7K/yr fees + counsel time). The dominant cost is not infrastructure — the buy-nothing-heavyweight stack
keeps that to hundreds of dollars a month scaling to low thousands — it is engineering discipline and the
compliance work, which is precisely where the research says the budget belongs.

## Future enhancements

Beyond F4, the planning suite's E-series is the long horizon: multi-site adapters, an event-bus transport,
active-learning ER, a lakehouse, multi-region/DR, automated survivorship, ML data quality, and parser
auto-generation. The one strategic bet worth evaluating early — even though its build is late — is the
**contributory-data-network** (E7), which the corpus itself names "the industry's true primary ingestion
moat." It is the difference between a well-engineered platform and a defensible data business, and it
should be on leadership's radar as the F1–F3 correctness-and-compliance foundation is laid, because a
contributory network is only as trustworthy as the resolution, governance, and provenance beneath it —
which is exactly what this program builds.
