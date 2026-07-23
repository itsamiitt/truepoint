# 04 — Data-Quality Framework

> **Priority:** P1 · **Effort:** 8–11 eng-weeks · **Phase:** F1–F3 (contracts + pipeline metrics
> land in F1/F2; scoring, verification states, and the published cadence in F2/F3)
> (phases are defined in `17-phased-implementation-roadmap.md`)

## Executive summary

This document covers validation, cleaning, data contracts, per-record quality scoring, decay
modeling, and verification states for Forge — the machinery that decides whether a captured
observation deserves to become golden data. Today Forge has **no data-quality framework at
all**: the planned "weighted DAMA quality gate" exists only as a dead queue with tuning
constants and a comment in a package header, the single quality signal the pipeline computes
(extraction confidence) is degenerate — it evaluates to 1.0 for essentially any grounded field
— and the one numeric gate in the write path operates on a **client-supplied** number. Meanwhile
the main TruePoint app already ships a real, tested data-quality kernel: a 0–100 composite score
(0.4·completeness + 0.3·verification + 0.3·freshness), per-field freshness SLAs, the exact
`valid|catch_all|unknown|invalid` verification vocabulary the industry recommends, pluggable
email/phone verifier ports (Reacher, Twilio Lookup), and a flag-gated re-verification sweep.
The headline recommendation is therefore **reuse, extend, and gate — do not build a second
quality stack**: extend the shared `@leadwolf/types` scoring kernel to a four-dimension golden
score (completeness, accuracy, freshness, consistency), wire the dead quality stage as a
rules-as-code gate with persisted verdicts and quarantine, put zod-v4 contracts with CI
BACKWARD-compatibility snapshots at every stage boundary, add a ~200-line per-batch metrics +
z-score anomaly layer, add per-field `verified_at` + status to gold, and drive a
re-verification queue prioritized by score × account value. Heavyweight tooling (Great
Expectations, DataHub) is explicitly skipped; a Soda Core container is an optional P2 add-on.
The published verification-cadence statement this machinery enables is a sales asset — the
thing ZoomInfo and Cognism lead their pitch with — and Forge can generate it from measured
data rather than marketing copy.

## Current state

### Forge: a quality stage that exists only as vocabulary

There is no functioning validation, cleaning, scoring, or verification-state machinery
anywhere in the Forge pipeline. What exists is scaffolding that names the concern without
implementing it:

- **A dead `forge-quality` queue.** `apps/forge-worker/src/register.ts:45` creates the queue,
  `apps/forge-worker/src/tuning.ts:11,23` assigns it concurrency 4 and a 15 s deadline, and
  `apps/forge-worker/src/retryPolicies.ts:23` gives it an exponential retry policy — but the
  queue has **no producer and no consumer** (fact pack §4.2). The built stage chain skips it
  entirely: parse → ai-extract → resolve → verify (fact pack §3.3).
- **A package header that claims the feature.** `packages/forge-core/src/index.ts:2` describes
  the package as containing "quality/validation rules (P3)"; no such module exists in
  `packages/forge-core/src/`.
- **Schema columns with no writers.** `forge.extraction_runs` has `grounding_coverage`,
  `judge_score`, and `confidence` columns (`packages/db/src/migrations/0070_forge_schema.sql:101-103`)
  plus `latency_ms`/`input_tokens`/`output_tokens`/`cached_tokens` (`0070:104-107`) that the
  metering path never populates (`packages/forge-core/src/extraction.ts:283-303`, fact pack
  §3.2). `forge.verified_records` carries `confidence numeric(4,3)` (`0070:118`) and a nullable
  `verified_at` (`0070:128`) — record-level only, no per-field state, no quality score, no
  bounce feedback. `forge.parsed_records.parse_status` includes a `'quarantined'` enum state
  (`0070:87`) that no code path ever sets: drifted or unparseable captures are `console.warn`'d
  and recorded nowhere (P-01.8).
- **No quality schema.** A grep of migration 0070 for `quality` and `validation` returns
  nothing: the planned `validation_rules` catalog (see intent below) was never created. There
  is no metrics table, no verdict table, no rule registry.
- **A degenerate confidence signal.** The extraction composite is
  0.4·grounding + 0.3·validator + 0.3·judge − 0.15·repair with HIGH = 0.8
  (`packages/forge-core/src/extraction.ts`, fact pack §3.1) — a sound design — but as built,
  `validatorOk = (value !== undefined)`, the judge score defaults to 1, and grounding is a
  loose substring `includes()` check in either direction, so **confidence ≡ 1.0 for any
  grounded field** (fact pack §3.3). A one-word value "grounds" anywhere in the payload.
- **A client-trusted gate.** The only place a quality number is enforced — the 0.8 confidence
  threshold at promotion — reads a **client-supplied** value from the request body, with
  `fields` typed `z.unknown()` and no linkage to `parsed_records`/`extraction_runs` (P-01.11).
- **No console surface.** The operator console ships none of the planned Data-quality pages;
  of doc-13's ten surfaces, quality is one of the five never built (fact pack §5.5).
- **Unused helpers that were meant to feed quality.** `computePriority` (the planned
  confidence·value·freshness·risk review ranking) has zero production callers (fact pack
  §3.1); the verify processor hardcodes `taskType: "ai_low_confidence"`, `confidence: 0.5`,
  `priority: 50` (`apps/forge-worker/src/processors.ts:143-147`, fact pack §3.3).

### The main app: a shipped quality stack Forge ignores

The reuse inventory (fact pack §2.3) mandates reuse over duplication, and for data quality the
main app has materially more built than Forge does:

- **The scoring kernel** lives in the leaf types package so every layer shares one
  implementation: `packages/types/src/dataHealth.ts` defines the 0–100
  `data_quality_score = round(100 × (0.4·completeness + 0.3·verification + 0.3·freshness))`
  with cold-start re-weighting when verification is absent (`dataHealth.ts:133-144`),
  weighted completeness with per-entity weight tables (contact: email 0.3, phone 0.2,
  name/title/company/location/linkedin 0.1 each; account: domain 0.3 — `dataHealth.ts:94-120`),
  and a verification mean over field statuses (`dataHealth.ts:80-84`).
  `packages/core/src/data-health/dataQualityScore.ts:10-27` re-exports it for core consumers.
- **Freshness is a first-class model**: per-field re-verify SLAs
  (`FRESHNESS_SLA_DAYS = { email: 90, phone: 180, employment: 60, firmographics: 180,
  intent: 30 }`, `dataHealth.ts:19-25`), a four-band status (fresh/aging/stale/expired at
  0.5×/1.0×/1.5× SLA, `dataHealth.ts:34-40`), a continuous decay sub-score (linear from 1 at
  age 0 to 0 at 1.5×SLA, `dataHealth.ts:44-47`), and a cold-start constant of 0.5
  (`dataHealth.ts:31`).
- **The verification vocabulary already matches the industry recommendation**:
  `verificationSubScore` grades `valid` (and resolved phone line types `direct|mobile|hq`)
  as 1, `catch_all|unknown` as 0.5, `invalid` as 0, and excludes unverified fields from the
  mean rather than penalizing them (`dataHealth.ts:62-77`).
- **Verifier ports with real adapters**: `EmailVerifierPort`
  (`packages/core/src/data-health/emailVerifier.ts:9-12`) with a `hybridVerifier` composition
  that escalates only the non-decisive `catch_all|unknown` outcomes to a metered secondary
  (`emailVerifier.ts:33-54`), a Reacher SMTP adapter (`reacherVerifier.ts`), a Twilio Lookup
  phone adapter (`twilioPhoneVerifier.ts`), phone validation (`validatePhone.ts`), an email
  prescreen (`emailPrescreen.ts`), and charge-only-for-valid accounting (`chargeFor.ts`,
  ADR-0013 per the header comment at `emailVerifier.ts:1-5`).
- **A re-verification sweep**: `packages/core/src/data-health/reverifyContacts.ts` re-grades
  revealed contacts past their freshness SLA — keyset-paged, per-workspace, network I/O
  outside transactions, recorded in a `verification_jobs` ledger, gated by the per-tenant
  flag `data_health.reverification`, and a safe no-op when only the pass-through verifier is
  configured (`reverifyContacts.ts:1-42`).

None of this is imported by any Forge workspace: `@leadwolf/forge-core` is consumed only by
forge-api, forge-worker, the integrations adapters, and the db forge repositories, and the
Forge tree references nothing from `data-health` (fact pack §6.2). If Forge builds its own
quality layer independently, it becomes duplication #15 on the inventory of fourteen concerns
already implemented twice (P-01.31, fact pack §6.6).

### What the planning suite intended (intent, not reality)

The Forge planning corpus specifies a quality framework it never assigned a standalone
document: promotion into `verified_records` is to be gated on a **weighted DAMA composite**
(`docs/planning/forge/02-functional-requirements.md:177`), with the rule catalog owned by
"05-database-design Group 5 (`validation_rules` / quality schema)" and the gates by the
pipeline doc (`02-functional-requirements.md:190`). Stage S3 is a deterministic
"Quality-validate (gate)" with idempotency key `(record_id, ruleset_version)`, tiered severity
(warn-and-alert vs hard-fail), and **fail → quarantine, not discard**
(`docs/planning/forge/06-data-pipeline-architecture.md:134`). The DAMA six dimensions
(accuracy, completeness, consistency, timeliness, validity, uniqueness) are the stated frame
(`docs/planning/forge/01-research-findings-and-industry-analysis.md:128`), the AI-extraction
doc requires "validator agreement — Zod / DAMA type·format·range"
(`docs/planning/forge/09-ai-extraction-engine.md:250`), and the console plan includes DAMA
quality dashboards (`docs/planning/forge/04-monorepo-structure.md:323`). None of it was built;
the gap between this intent and the empty build is the subject of this document.

## Problems identified

- **P-04.1 — GAP · There is no quality gate anywhere in the built pipeline.** The planned S3
  quality-validate stage never materialized: the `forge-quality` queue exists with tuning and
  retry policies (`register.ts:45`, `tuning.ts:11,23`, `retryPolicies.ts:23`) but has no
  producer or consumer (fact pack §4.2), so once the F1 correctness fixes (P-01.1, P-01.2)
  make the pipeline flow, records will travel bronze → gold with **zero validation**. At
  enterprise scale this is how a data vendor poisons its own golden layer — one bad parser
  version, one drifted DOM, and millions of malformed rows promote silently.

- **P-04.2 — BUG · The only computed quality signal is degenerate.** `validatorOk` is
  `value !== undefined`, the judge defaults to 1, and grounding is substring `includes()` in
  either direction, so the composite confidence is ≡ 1.0 for any grounded field (fact pack
  §3.3). The 0.8 HIGH threshold therefore never routes anything to review on real signal, and
  every stored `confidence` value is meaningless. (The fix — offset-based grounding and a
  wired judge — is owned by `11-ai-assisted-processing.md` per shared decision S.2 #6; this
  document treats real confidence as an input dependency.)

- **P-04.3 — RISK · The one enforced quality threshold trusts the client.** The 0.8 promotion
  gate operates on a client-supplied confidence with `fields: z.unknown()` and no linkage to
  pipeline state (P-01.11). Until the gate reads pipeline-derived values, every quality
  control downstream of it is decorative.

- **P-04.4 — GAP · Invalid data is neither quarantined nor measurable.** The
  `'quarantined'` parse status exists in the schema (`0070:87`) but the quarantine lane is a
  `console.warn` (P-01.8), so there is no invalid-rate, no quarantine queue depth, and no way
  to compute a validity dimension at all. "Never silently into silver" is currently violated
  by design.

- **P-04.5 — GAP · No quality schema exists.** Migration 0070 contains no `validation_rules`,
  no verdict table, no metrics table, and no quality-score column (verified by grep; migration
  0070 defines 17 tables, none for quality). The planned Group-5 quality schema was dropped entirely.

- **P-04.6 — GAP · Gold has no per-field verification state.** `verified_records` carries
  only a record-level `review_status` defaulting to `'verified'` (`0070:119`) and one
  nullable `verified_at` (`0070:128`). There is no per-field status
  (`valid|catch_all|unknown|invalid`), no per-field `verified_at`, no verifier attribution,
  and no bounce-feedback path — even though the exact status vocabulary already exists in
  `dataHealth.ts:62-77`. Without per-field state, a record with a hard-bounced email and a
  valid mobile is indistinguishable from a fully valid one.

- **P-04.7 — GAP · Nothing models decay; gold rots silently.** No code computes age, decays
  confidence, or triggers re-verification; `verified_records.version` is always 1 and
  `sync_state` never advances (fact pack §3.2, P-01.20). At the researched 25–30%/yr B2B
  contact decay rate (§Research), roughly a quarter of the golden layer would be stale within
  a year of GA with no signal that it happened.

- **P-04.8 — GAP · No data contracts at stage boundaries.** Envelope v2 is zod-validated at
  the capture edge, but the payloads flowing between queues (parse output, extraction
  candidates, promotion candidates, sync items) are unversioned and unchecked, and there are
  already **two ingestion-envelope contracts in one types package** (fact pack §6.6 #6). No
  CI job detects a breaking change to any inter-stage shape; `extract_schema_version` exists
  as a column (`0070:100`) with no registry or compatibility discipline behind it.

- **P-04.9 — GAP · No pipeline metrics and no anomaly detection.** `extraction_runs` never
  records tokens or latency (fact pack §3.2), `/metrics` serves static gauges (P-01.27), and
  there is no per-batch record of row counts, null rates, duplicate rates, or invalid rates.
  A LinkedIn DOM change that nulls a field in 100% of captures would be invisible until a
  human notices — the exact failure mode drift monitoring exists to catch.

- **P-04.10 — DEBT · Forge is one decision away from quality-stack duplication #15.** The
  main app's scoring kernel, verification vocabulary, verifier ports, and re-verification
  sweep (§Current state) cover most of what Forge needs; building a parallel Forge-native
  quality stack would extend the fourteen-item duplication inventory (P-01.31) into the one
  domain where the main app is strictly ahead. The blind-index and content-hash splits
  (P-01.6) show exactly how such forks decay.

- **P-04.11 — DEBT · Quality vocabulary without implementation misleads.** The package header
  (`forge-core/src/index.ts:2`), the dead queue, and the unused schema columns all assert a
  quality system that does not exist — a hazard for any engineer (or auditor) reasoning from
  names. Until the gate is real, the artifacts should be either wired or clearly marked.

## Research findings

### DQ frameworks: the buy-vs-build landscape (fact pack §9.1)

- **Great Expectations is fragmented and should be skipped.** GX Cloud was acquired by FICO
  and its public availability ended 2026-06-01; stewardship of the OSS GX Core passed to
  Fivetran ([greatexpectations.io](https://greatexpectations.io/);
  [github.com/great-expectations/great_expectations](https://github.com/great-expectations/great_expectations)).
  It is Python-heavy in a Bun/TS monorepo regardless — acquisition news per the audit's
  research pass, not independently re-verified.
- **Soda Core is the best buy-not-build fit**: Apache-2.0, SodaCL YAML checks compiled to SQL
  against Postgres, deployable as a single container
  ([github.com/sodadata/soda-core](https://github.com/sodadata/soda-core);
  [docs.soda.io/soda-cl](https://docs.soda.io/soda-cl/metrics-and-checks/)).
- **Elementary requires dbt** and is N/A without a warehouse
  ([github.com/elementary-data/elementary](https://github.com/elementary-data/elementary)) —
  but its anomaly method is worth stealing: per-run metrics (row counts, null %, duplicate %,
  invalid %) persisted to a table, then a z-score against a trailing window with |z| ≥ 3
  alerting. That is **~200 lines of TypeScript** on this stack — the build side of the
  buy-vs-build line.
- **No mature TS-native dataset-check framework exists** (fact pack §9.1), so the thin layer
  above is the correct build, not a compromise.
- **Zod v4** brings a ~14× faster parser and **built-in JSON Schema conversion**
  ([zod.dev/v4](https://zod.dev/v4); [zod.dev/json-schema](https://zod.dev/json-schema)),
  which collapses schemas, static types, runtime validators, and contract documents into one
  artifact — the property the contracts design below depends on.

### Data contracts and evolution (fact pack §9.2)

- **ODCS v3.1.0** (Bitol, LF AI & Data) standardizes one YAML per dataset covering structure,
  semantics, quality, and ownership
  ([bitol-io.github.io/open-data-contract-standard](https://bitol-io.github.io/open-data-contract-standard/latest/)),
  with `datacontract-cli` tooling
  ([github.com/datacontract/datacontract-cli](https://github.com/datacontract/datacontract-cli)).
- **Compatibility rules are settled canon** (Confluent):
  **BACKWARD** (the default — new readers accept old data; may delete fields and add
  optional fields), FORWARD, FULL, and their `_TRANSITIVE` variants; renames, type changes,
  and new required fields are unsafe under every mode
  ([docs.confluent.io — schema evolution](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)).
- For a single-team monorepo, a schema **registry is overkill**: zod → JSON-Schema snapshots
  committed to git and diffed in CI under BACKWARD rules give the same guarantee with zero
  infrastructure; Pact-style consumer contracts matter only once independent teams own the
  two sides (fact pack §9.2).

### Decay, verification economics, and the scoring synthesis (fact pack §9.4)

- **B2B contact data decays at ~25–30%/yr** in modern estimates, with all-fields decay up to
  70%/yr and ~30% of professionals changing jobs each year; sector variance is wide (tech
  35–70% vs manufacturing/government 10–25%). The older canonical figure is ~2.1%/mo ≈
  22.5%/yr (MarketingSherpa; primary source paywalled — flagged, not independently verified:
  [marketingsherpa.com](https://www.marketingsherpa.com/)). Vendor-published decay pages
  (e.g., [ZoomInfo on data decay](https://pipeline.zoominfo.com/marketing/data-decay)) are
  marketing material — directionally consistent, figures unverified.
- **Four-step email verification (syntax → MX → SMTP → risk assessment) catches 95–99% of
  invalid addresses**; a hard-bounce rate **<0.5% is achievable**, <2% is safe, and >5%
  damages sender reputation; **catch-all domains need their own confidence state** rather
  than a binary valid/invalid (industry practice, e.g.
  [zerobounce.net/email-validation](https://www.zerobounce.net/email-validation/),
  [sendgrid.com on bounce rates](https://sendgrid.com/en-us/blog/email-bounce-rate) —
  representative sources; exact thresholds are industry guidance, not standards).
- **Verification cadence is a sales asset.** ZoomInfo markets 20M+ email signatures verified
  per month and ~4M person + 1M company updates per day
  ([zoominfo.com — data accuracy](https://www.zoominfo.com/why-zoominfo/data-accuracy));
  Cognism markets human-verified mobiles and a 30-day re-verification cycle for
  director-level contacts ([cognism.com/diamond-data](https://www.cognism.com/diamond-data)).
  Both are vendor claims (flagged, unverified) — the lesson is not the numbers but that each
  vendor **publishes a cadence statement** and sells against it. Multi-source corroboration
  also measurably beats single-source accuracy (~82% single-source vs 90%+ multi-source;
  Apollo markets ~91% email accuracy off its contributor network — fact pack §2.5, vendor
  figures).
- **The scoring-model synthesis** across the researched vendors and literature is a
  four-dimension per-record score: **completeness** (value-weighted — mobile > direct dial >
  email > title, because that is the order of sales utility), **accuracy** (last verification
  outcome + bounce feedback), **freshness** (exponential decay tuned to per-field
  half-lives, calibrated against the 25–30%/yr envelope), and **consistency** (cross-field
  checks), with per-field `verified_at` + a `valid|catch_all|unknown|invalid` status enum and
  a re-verification queue prioritized by **score × account value** (fact pack §9.4).

### Adjacent findings this document consumes

- Anomaly detection at this scale is per-batch stats in Postgres + z-score — it reproduces
  the core of commercial data-observability products (fact pack §11.2); drift monitors on
  payload-shape hashes and per-field null/enum distributions are the AI-side complement
  (owned by `11-ai-assisted-processing.md`).
- Catalog/lineage platforms (DataHub: Kafka + MySQL/PG + ES, >7 GB RAM, ≥3 nodes, ~0.5–1 FTE)
  are **overkill**; minimal viable lineage is per-record provenance + per-field source
  attribution, which doubles as the GDPR Art. 14(2)(f) source-disclosure map (fact pack §9.3
  — owned by `07-data-governance.md`).

## Enterprise best practices

A ZoomInfo/Apollo/Cognism-class platform treats quality as a measured, gated, published
property of the dataset, not an aspiration: every record entering the golden layer passes a
versioned validation gate whose failures quarantine rather than discard; every field of a
golden record carries its own verification status, verifier, and timestamp; scores decay
continuously so staleness is visible before it becomes a bounce; re-verification spend is
prioritized by business value rather than FIFO; per-batch metrics with anomaly detection catch
source drift within one run; contracts between pipeline stages are versioned and
compatibility-checked in CI so a producer cannot silently break a consumer; and the resulting
cadence ("every email re-verified within N days") is published and sold against. Bounce
feedback closes the loop: a delivery failure downgrades the field, the record, and — in
aggregate — the parser or source that produced it. The bar is that quality numbers are
*computed from evidence and reproducible*, because enterprise buyers audit them.

## Recommended architecture

Five components, all Postgres-native, all reusing the main app's kernel. This respects the
FIXED decisions (Postgres as source of truth; queued idempotent jobs; shared Zod contracts in
`@leadwolf/types`; metered verification spend) and shared decisions S.2 #2 (kill duplication)
and S.2 #6 (deterministic-first AI with real confidence).

```text
            capture envelope v2 (zod contract, @leadwolf/types)
                    │
   S0 ingest ──────▶ forge.raw_captures (bronze)
                    │   contract: SilverRecordV1
   S1 parse ───────▶ forge.parsed_records (silver)
                    │   contract: ExtractionCandidateV1 (persisted, doc 11)
   S2 extract ─────▶ extraction candidates (residue only)
                    │
   S3 QUALITY GATE (revived forge-quality queue)          ┌────────────────────────┐
     rules-as-code, RULESET_VERSION, idempotent on        │ forge.pipeline_metrics │
     (parsed_record_id, ruleset_version)                  │ per stage × scope ×    │
     ├─ hard-fail ─▶ quarantine (persisted, doc 08) ──────▶ window: rows, null %,  │
     ├─ warn ──────▶ verdict annotations                  │ invalid %, dup %, p95  │
     └─ pass ──────▶ forge.quality_verdicts               └───────────┬────────────┘
                    │   + four-dimension score                        │ maintenance tick
   S4 resolve (ER, doc 05) ─▶ S5 verify/review ─▶ promote             ▼
                    │                                     z-score anomaly detector
                    ▼                                     (|z| ≥ 3, trailing window)
   forge.verified_records (gold)                          → alerts (doc 12)
     + quality_score / quality_dims columns
     + forge.field_verifications (per-field status, verifier, verified_at)
                    │
   re-verification sweep (maintenance, repeatable job)
     priority = (100 − quality_score) × account-value weight
     → verifier ports from @leadwolf/core (Reacher / Twilio Lookup, metered)
     → docs/trust/verification-cadence.md (generated monthly — the sales asset)
```

### 1. Zod-v4 stage contracts with CI snapshot diffing

Every payload that crosses a stage boundary gets a versioned zod schema in
`packages/forge-core/src/contracts/`: the parse output (`SilverRecordV1` — fields,
field_provenance, channels/blind-index inputs, blockKey), the extraction candidate
(`ExtractionCandidateV1` — per-field value, char offsets, validator verdict, judge score),
the quality verdict (`QualityVerdictV1`), the promotion candidate (`PromotionCandidateV1` —
derived from pipeline state, never the client, per the P-01.10/P-01.11 fixes), and the sync
item (`SyncItemV1` — which doc 06's resolver-key TODO extends). Each schema exports a
`SCHEMA_VERSION` (SchemaVer `MODEL-REVISION-ADDITION`, reusing the existing
`packages/forge-core/src/schemaVer.ts` helpers, which currently have zero production callers
— fact pack §3.1). A build step converts each to JSON Schema via zod v4's native
`z.toJSONSchema()` and writes snapshots under `packages/forge-core/contracts/`; CI diffs the
regenerated snapshots against the committed ones and fails on any change that violates
BACKWARD rules (renames, type changes, new required fields). The capture envelope contract
itself stays in `@leadwolf/types` (FIXED decision 5); unifying the v1/v2 envelope pair is
`03-data-ingestion-architecture.md`'s job — this document only requires that whichever
envelope survives is snapshot-checked the same way. An ODCS YAML export per dataset is a
future nicety, not a requirement; the registry (Confluent-style) is explicitly skipped until
independent teams exist.

### 2. The quality gate: rules-as-code, verdicts persisted, quarantine real

Revive the dead `forge-quality` queue as planned stage S3, between extract and resolve.
Rules live in code (`packages/forge-core/src/quality/rules.ts`), versioned by a
`RULESET_VERSION` string, not in a database rules engine — the planned `validation_rules`
table is replaced by git-versioned TS rules with golden-fixture tests, which is simpler,
reviewable, and sufficient until a metadata-driven source registry (fact pack §7.7) makes a
config-driven catalog worthwhile. Three rule tiers:

- **Hard-fail (quarantine):** schema-invalid against the stage contract; missing identity
  minimum (no linkedin slug AND no email AND no phone); impossible values (captured_at in the
  future beyond skew; linkedin URL host not linkedin.com); payload-provenance mismatch.
  Outcome: `parse_status = 'quarantined'` (finally using `0070:87`) plus a persisted
  quarantine row — the quarantine table itself is owned by `08-pipeline-architecture.md`
  alongside the DLQ persistence work (P-01.17).
- **Warn (annotate, pass):** consistency violations (below), suspicious-but-plausible values,
  free-mail address on a company-titled contact. Warnings ride the verdict row and depress
  the consistency dimension; they never block.
- **Clean (normalize in place):** trim/case-fold email exactly as the unified blind-index
  normalization does (one normalization, per S.2 #2 — the forge-vs-main normalization split
  is P-01.6's fix), E.164 phone via the main app's `validatePhone.ts`, whitespace/case
  normalization on names. Title canonicalization (ESCO/O*NET) is deliberately deferred to
  `11-ai-assisted-processing.md`.

The gate is idempotent on `(parsed_record_id, ruleset_version)` — the planned key
(`06-data-pipeline-architecture.md:134`) — enforced by a UNIQUE constraint on the verdict
table, which also makes the handler safe under BullMQ's at-least-once redelivery (P-01.16's
class of bug, fixed structurally here).

### 3. The four-dimension golden score — one kernel, extended

Extend `packages/types/src/dataHealth.ts` (the shared leaf kernel — every layer already
imports it) rather than forking a Forge scorer:

```ts
// packages/types/src/dataHealth.ts — additions (sketch)
export interface GoldQualityDims {
  completeness: number;        // [0,1] value-weighted presence
  accuracy: number | null;     // [0,1] from field_verifications; null = cold start
  freshness: number;           // [0,1] exponential decay, per-field half-lives
  consistency: number;         // [0,1] 1 − penalty per cross-field violation
}
/** Gold composite: round(100 · (0.35c + 0.30a + 0.25f + 0.10k)); accuracy re-weighted
 *  out on cold start exactly as dataQualityScore() re-weights verification (":141"). */
export function goldQualityScore(d: GoldQualityDims): number;

/** Exponential freshness: 2^(−ageDays / halfLifeDays). Sits beside the linear
 *  freshnessSubScore (":44-47"); the overlay keeps linear until product converges. */
export function freshnessSubScoreExp(ageDays: number, halfLifeDays: number): number;

/** Gold value weights — the sales-utility ordering (research §9.4): mobile > direct
 *  dial > email > title. Seed values; calibrate against bounce/review outcomes. */
export const GOLD_COMPLETENESS_WEIGHTS = {
  person: { phone_mobile: 0.25, phone_direct: 0.20, email: 0.20,
            title: 0.10, company: 0.10, linkedin: 0.10, location: 0.05 },
  company: { domain: 0.30, name: 0.10, industry: 0.15, size: 0.15,
             location: 0.15, linkedin: 0.15 },
} as const;
```

- **Completeness** uses the gold weight table (a present-but-invalid field earns nothing,
  same rule as `dataHealth.ts:87-99`).
- **Accuracy** is computed from `field_verifications` using the existing
  `verificationSubScore` semantics (`valid`/resolved line types = 1, `catch_all|unknown` =
  0.5, `invalid` = 0, unverified = excluded — `dataHealth.ts:62-77`), with bounce feedback
  overriding: an observed hard bounce sets the email field's status to `invalid` regardless
  of the last verifier verdict.
- **Freshness** switches gold to exponential decay with per-field half-lives. Two clocks are
  deliberately distinct: the **SLA table** (`FRESHNESS_SLA_DAYS`, `dataHealth.ts:19-25`)
  remains the *re-verification trigger* (when to act), while the **half-life** is the *trust
  curve* (how much to believe meanwhile). Seed half-lives from the decay research —
  employment and email materially shorter than firmographics, consistent with ~30%/yr job
  change; the record-level 25–30%/yr envelope implies an all-fields half-life around 1.9–2.4
  years — then calibrate per field against measured invalidation (bounce + re-verification
  outcomes). Seeds are estimates and must be marked as such in code.
- **Consistency** is the deterministic cross-field check set: email registrable domain vs
  company domain (free-mail exempted), phone country code vs location country, title
  seniority tokens vs seniority field, employment dates non-overlapping/ordered. Each
  violation applies a fixed penalty; the sub-score floors at 0.
- The overlay serving formula (0.4/0.3/0.3, `dataHealth.ts:133-144`) is **unchanged**; the
  gold dims map onto it (accuracy ≈ verification) so the two scores can be displayed side by
  side without contradiction. One file owns both — that is the anti-duplication control.

The score and dims are computed at the quality gate, recomputed at promotion (over the
promoted field set), and recomputed by the re-verification sweep — always via the same pure
function, so any historical score is reproducible from `(fields, field_verifications,
score_version)`.

### 4. Per-field verification state on gold

A new `forge.field_verifications` table (DDL below) records, per golden record and field:
status (`valid|catch_all|unknown|invalid` — the platform's existing `EmailStatus`-aligned
vocabulary), the verifier (`reacher`, `twilio_lookup`, `human_review`, `bounce_feedback`),
evidence JSON, and `verified_at`. `verified_record_events` (which today only ever receives
`("verified", 1)` — fact pack §3.2) gains `field.verified` events for history. Verification
execution **reuses the main app's ports as code** — `EmailVerifierPort`/`hybridVerifier`
(`emailVerifier.ts:9-54`) with the Reacher and Twilio adapters — which is package-level reuse,
not a data-boundary violation: `leadwolf_forge` still cannot read the public schema (fact
pack §6.4); only the TypeScript modules are shared. All verifier calls are metered spend and
must flow through the platform's budget/breaker discipline (FIXED decision 7;
`15-cost-optimization.md`).

### 5. Pipeline metrics + z-score anomaly detection (and optional Soda)

Every stage handler emits one `forge.pipeline_metrics` row per (stage, scope, window):
rows in/out/failed/quarantined, per-field null rates, invalid rate, duplicate rate, and
latency percentiles. A maintenance tick (dependent on the F1 scheduler fix for P-01.4)
computes z-scores per metric against a trailing window (default 28 windows) and raises an
alert at |z| ≥ 3 with a minimum-sample gate (n ≥ 10) — the ~200-line Elementary-style
detector. Alert routing, the `forge_*` metric names, and freshness SLOs are owned by
`12-observability.md` (this table is the DATA-plane substrate its monitors read);
payload-shape-hash drift and per-field null/enum distribution monitors on the AI side are
owned by `11-ai-assisted-processing.md`. Optionally, a **Soda Core** container
(`deploy/soda/`) runs declarative SodaCL checks against the forge schema on a schedule —
valuable for checks operators want to edit without a deploy, but strictly optional (P2) and
off by default; the TS layer is the load-bearing one.

### 6. The re-verification queue and the published cadence

A maintenance repeatable job selects golden records due for re-verification — any field past
its SLA (`reverifyCutoff` semantics, `dataHealth.ts:52-54`) or any record whose score fell
below threshold — and enqueues idempotent verify jobs (jobId
`reverify:{recordId}:{field}:{dueEpochDay}`) ordered by
**priority = (100 − quality_score) × account-value weight** (fact pack §9.4). The
account-value weight defaults to 1 and is later fed from usage/linkage signals (reference
counts in the master graph; customer-plan tier) — the signal definition is shared with
`15-cost-optimization.md`. The sweep follows the `reverifyContacts.ts` discipline exactly:
keyset-paged, verifier I/O outside transactions, ledger-recorded, flag-gated
(`FORGE_REVERIFICATION_ENABLED`, default off), safe no-op on pass-through verifiers
(`reverifyContacts.ts:1-42`). The two sweeps deliberately coexist without double-spend: the
main-app sweep re-grades *revealed workspace contacts* (the workspace paid for them); the
Forge sweep re-grades *golden records*; both share the provider result caching and budget
machinery so the same address is never paid for twice (FIXED decision 7).

From `pipeline_metrics` + `field_verifications`, a monthly job generates
`docs/trust/verification-cadence.md`: p95 age-since-verification per field, % of golden
emails verified within 90 days, hard-bounce rate on synced emails, quarantine rate. This is
the **published verification-cadence statement** — measured numbers, regenerated monthly,
reviewed before publication — the sales asset the vendor research says to build
(fact pack §9.4).

### Explicitly skipped

Great Expectations (fragmented, Python), Elementary (needs dbt), DataHub/OpenMetadata
(catalog overkill at this team size — fact pack §9.3), a schema registry (CI snapshots
suffice), a DB-driven rules engine (rules-as-code until the metadata-driven registry lands),
and ML-based quality prediction (F4 — see Future enhancements).

## Implementation details

Ordered by dependency. Steps 1–2 ride F1 (they gate correctness); 3–6 are F2; 7–8 are F2/F3.

**1. Stage contracts (F1 tail, ~1.5 wks).**
- New: `packages/forge-core/src/contracts/{index,silverRecord,extractionCandidate,qualityVerdict,promotionCandidate,syncItem}.ts`
  — zod v4 schemas + `SCHEMA_VERSION` constants; reuse `packages/forge-core/src/schemaVer.ts`
  for version comparison (its first production callers).
- New: `packages/forge-core/contracts/*.schema.json` — generated snapshots
  (`z.toJSONSchema()`).
- New: `scripts/forge-contract-check.mjs` — regenerate, diff, classify under BACKWARD rules
  (allowed: delete field, add optional field; forbidden: rename, type change, new required
  field), exit 1 on violation. Wire as a step in `.github/workflows/ci.yml` after typecheck;
  add the snapshot directory to CODEOWNERS so a regenerated snapshot always gets human
  review.
- Change: stage handlers in `apps/forge-worker/src/processors.ts` parse their inbound payload
  with the matching contract at entry (fail → terminal error class → DLQ, not retry — doc
  08's retry taxonomy).

**2. Metrics + anomaly layer (F1/F2, ~1.5 wks).**
- Migration `packages/db/src/migrations/0071_forge_quality.sql` (take the next free journal
  index at merge time — the journal already carries a duplicated 0053, P-01.30):

```sql
CREATE TABLE IF NOT EXISTS forge.pipeline_metrics (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage             text NOT NULL,            -- ingest|parse|extract|quality|resolve|verify|sync
  scope_key         text NOT NULL,            -- parser version, source, or 'all'
  window_start      timestamptz NOT NULL,
  window_end        timestamptz NOT NULL,
  rows_in           integer NOT NULL DEFAULT 0,
  rows_out          integer NOT NULL DEFAULT 0,
  rows_failed       integer NOT NULL DEFAULT 0,
  rows_quarantined  integer NOT NULL DEFAULT 0,
  null_rates        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {field: rate}
  distinct_rates    jsonb NOT NULL DEFAULT '{}'::jsonb,
  invalid_rate      numeric(6,5),
  dup_rate          numeric(6,5),
  latency_p50_ms    integer,
  latency_p95_ms    integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uniq_pipeline_metrics UNIQUE (stage, scope_key, window_start)
);
```

- New: `packages/forge-core/src/quality/metrics.ts` (accumulate/flush per window) and
  `packages/forge-core/src/quality/anomaly.ts` (z-score vs trailing 28 windows, |z| ≥ 3,
  n ≥ 10 gate). The anomaly check runs in the maintenance processor
  (`apps/forge-worker/src/processors.ts`) — which requires the F1 scheduler fix (P-01.4)
  and replaces part of today's `console.info` no-op.
- Change: `apps/forge-api` `/metrics` gains real gauges from this table (queue-depth and
  age-of-oldest metrics are doc 12's; this step only stops the gauges being static,
  P-01.27).
- Fix in passing: populate `extraction_runs.latency_ms/input_tokens/output_tokens` from the
  port result (`extraction.ts:283-303` currently drops them — fact pack §3.2); token spend
  becomes measurable (doc 15 depends on this).

**3. Quality gate + verdicts (F2, ~2 wks).**
- Same migration (or `0072`):

```sql
CREATE TABLE IF NOT EXISTS forge.quality_verdicts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parsed_record_id uuid NOT NULL REFERENCES forge.parsed_records (id) ON DELETE CASCADE,
  ruleset_version  text NOT NULL,
  verdict          text NOT NULL,             -- pass|warn|quarantine
  score            smallint,                  -- 0–100 four-dimension composite
  dims             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {completeness,accuracy,freshness,consistency}
  score_version    text NOT NULL,             -- kernel version for reproducibility
  failures         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{rule, tier, detail}]
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_verdicts_verdict CHECK (verdict IN ('pass','warn','quarantine')),
  CONSTRAINT uniq_quality_verdicts UNIQUE (parsed_record_id, ruleset_version)
);
```

- New: `packages/forge-core/src/quality/{rules,gate,score}.ts` — `RULESET_VERSION`, the
  three-tier rule set, `runQualityGate()` (pure, DI'd like the other stages), and the gold
  scorer calling the extended kernel.
- Change: `apps/forge-worker/src/processors.ts` — the extract processor enqueues
  `forge-quality` (not resolve); the new quality processor writes the verdict
  (ON CONFLICT DO NOTHING on the unique key = idempotency), routes quarantine to the
  persisted quarantine lane (doc 08's table), and enqueues resolve on pass/warn.
- Change: `apps/forge-worker/src/register.ts` — attach the quality worker (the queue,
  tuning, and retry entries already exist at `register.ts:45`, `tuning.ts:11,23`,
  `retryPolicies.ts:23`).
- Kernel: extend `packages/types/src/dataHealth.ts` with `goldQualityScore`,
  `freshnessSubScoreExp`, `GOLD_COMPLETENESS_WEIGHTS`, and the consistency penalty helper —
  additive exports only; the existing formula and its consumers are untouched.

**4. Gold score columns + per-field verifications (F2, ~1 wk).**

```sql
ALTER TABLE forge.verified_records
  ADD COLUMN IF NOT EXISTS quality_score     smallint,
  ADD COLUMN IF NOT EXISTS quality_dims      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS quality_scored_at timestamptz,
  ADD COLUMN IF NOT EXISTS score_version     text;

CREATE TABLE IF NOT EXISTS forge.field_verifications (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verified_record_id uuid NOT NULL REFERENCES forge.verified_records (id) ON DELETE CASCADE,
  field              text NOT NULL,            -- email|phone|employment|title|...
  status             text NOT NULL,
  verifier           text NOT NULL,            -- reacher|twilio_lookup|human_review|bounce_feedback
  evidence           jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_verifications_status CHECK (status IN ('valid','catch_all','unknown','invalid')),
  CONSTRAINT uniq_field_verifications UNIQUE (verified_record_id, field)
);
CREATE INDEX IF NOT EXISTS idx_field_verifications_due
  ON forge.field_verifications (field, verified_at);
```

- Change: `packages/db/src/repositories/forge/promotionRepository.ts` — promotion computes
  and stamps `quality_score`/`quality_dims` from pipeline state (never the request body —
  this lands with the P-01.10/P-01.11 server-side four-eyes fix in F1) and seeds
  `field_verifications` rows (`status = 'unknown'`) for each promoted channel; the promotion
  event set gains `field.verified` events on later updates.
- Grants: `forge.field_verifications`, `forge.quality_verdicts`, `forge.pipeline_metrics`
  get the same `leadwolf_forge`-only DML grants as the rest of the schema
  (`packages/db/src/applyMigrations.ts` grant block).

**5. Verifier integration (F2, ~1 wk).**
- Change: `apps/forge-worker/src/processors.ts` verify stage — replace the hardcoded
  `confidence: 0.5, priority: 50` insert (`processors.ts:143-147`) with: read the quality
  verdict, wire `computePriority` (its first production caller) over
  (real confidence from doc 11's fixed composite) · value · freshness · risk, and run the
  email/phone verifier ports for records carrying those channels. Verifier calls go through
  the per-tenant budget machinery (doc 11/15; the in-memory budget store is replaced in F2
  per S.1).
- Reuse imports: `packages/core/src/data-health/{emailVerifier,reacherVerifier,twilioPhoneVerifier,validatePhone}.ts`.
  No new verifier implementations in the Forge tree.

**6. Re-verification sweep (F2/F3, ~1.5 wks).**
- New: `packages/forge-core/src/quality/reverify.ts` — due-selection (SLA cutoff per field
  via `reverifyCutoff` semantics) + priority ordering (score × account-value weight,
  default 1); enqueues `forge-verify` jobs with deterministic jobIds.
- Change: maintenance processor gains the repeatable sweep tick (leader-locked; the
  TTL-vs-deadline bug — leaderLock 60 s < deadline 120 s, fact pack §4.2 — must be fixed
  first, doc 08).
- Env: `FORGE_REVERIFICATION_ENABLED` (default false) added to the **validated** config
  (`packages/config/` — Forge env moves into `appEnvSchema` in F1, P-01.29; no more bare
  `process.env` reads).

**7. BFF + console surface (F3, ~1 wk).**
- API: `GET /bff/data-quality` (staff `data:read`) on
  `apps/forge-api/src/features/dashboard-bff/routes.ts` + a
  `readRepository.getDataQuality()` returning: score histogram, per-field verification
  coverage, freshness distribution (fresh/aging/stale/expired bands), quarantine and
  invalid rates, latest anomaly alerts. Response envelope and pagination follow the
  platform API contract (RFC 9457 errors land in F1 — fact pack §4.1 notes the current
  ad-hoc envelope).
- Console: `apps/forge/src/features/data-quality/{api,types,hooks,components}` + a
  `/data-quality` route — the missing doc-13 surface (fact pack §5.5) — rendering the same
  aggregates with `@leadwolf/ui` primitives. This rides the console-v2 wave (S.1 F3) and
  must not repeat the current console's contract mismatches (P-01.25): the BFF response
  shape is defined by a shared zod contract in `@leadwolf/types` first.

**8. Cadence statement (F3, ~0.5 wk).**
- New: maintenance job renders `docs/trust/verification-cadence.md` monthly from
  `pipeline_metrics` + `field_verifications` aggregates (p95 age per field, % verified
  within SLA, hard-bounce rate, quarantine rate). Publication to the marketing site is a
  manual, reviewed step — the generated file is the internal source of truth.
- Optional (P2): `deploy/soda/checks/forge.yml` + a `soda-core` compose service (off by
  default) for operator-editable SodaCL checks.

**Tests (woven through every step; the forge itest gap is P-01.28).** Contract-compat unit
tests (fixture schemas that must pass/fail BACKWARD); gate golden fixtures (valid, warn,
quarantine cases per rule); kernel property tests (score monotonicity: adding a valid field
never lowers completeness; decay monotonicity in age); an integration test under CI Postgres
asserting verdict idempotency under duplicate delivery, quarantine persistence, and that
promotion stamps a score derived from pipeline state; an anomaly-detector test with injected
drift (a null-rate step change must alert within one window).

## Migration strategy

All changes are additive; nothing rewrites existing rows (gold is effectively empty today —
the pipeline cannot yet populate it, P-01.1/P-01.2 — so backfill cost is ~zero and this work
should land **before** real volume does).

1. **Contracts in warn mode first.** The CI compat check runs in report-only mode for one
   sprint (annotate the PR, don't fail), then flips to enforcing. Snapshots are committed
   with the schemas so the first enforced run has a baseline.
2. **Gate in shadow.** `FORGE_QUALITY_GATE_ENABLED=false` initially routes extract → resolve
   as today while the quality processor runs in shadow (verdicts + metrics written, nothing
   blocked). After a soak on staging/synthetic tenants (capture stays dark in F1 anyway, per
   S.1), flip the flag: extract → quality → resolve, quarantine enforced.
3. **Scores before gates.** `quality_score` columns populate from the first shadow run;
   nothing reads them until the BFF surface ships, so miscalibration in the seed weights is
   observable without consequence. Weight/half-life changes bump `score_version`; scores are
   recomputed lazily (next touch) or by a one-shot backfill job — both reproducible from the
   pure kernel.
4. **Verification states dual-sourced.** `field_verifications` seeds as `unknown` at
   promotion; real statuses arrive as verifier runs execute. The re-verification sweep stays
   flag-dark until verifiers are configured (the pass-through no-op guard prevents
   clock-resetting, same as `reverifyContacts.ts:13-14`).
5. **Rollback** is flags-off: the gate flag restores the old stage chain; the sweep flag
   stops re-verification; contract enforcement reverts to warn mode. Tables and columns
   remain (additive, unused) — no destructive rollback needed.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Two quality vocabularies (overlay 0.4/0.3/0.3 vs gold four-dimension) confuse product/sales | Medium | Medium | One kernel file owns both; dims map 1:1 where they overlap; side-by-side display documented; convergence decision scheduled in F3 |
| Seed half-lives/weights miscalibrated → over-spend on re-verification or false staleness | High | Medium | Shadow-mode soak; budget breaker on verifier spend; calibrate quarterly against bounce + review outcomes; `score_version` makes every recalibration auditable |
| Snapshot discipline decays (devs regenerate schemas blindly to green CI) | Medium | High | CODEOWNERS on the snapshot dir; BACKWARD violations require an explicit version bump + migration note in the PR |
| Z-score alerts noisy at low volume | High | Low | Minimum-sample gate (n ≥ 10), warm-up window, per-metric mute list; alerts route as warnings until volume stabilizes |
| Double verification spend (Forge sweep + main-app `reverifyContacts`) | Medium | Medium | Disjoint populations by design (gold vs revealed overlay); shared provider result cache + budget (FIXED decision 7); spend dashboards in doc 15 |
| Quality gate becomes a throughput bottleneck at 10× volume | Low | Medium | Rules are pure/deterministic (µs-scale); gate is horizontally scaled like any stage; metrics accumulate in-memory per window, one row per flush |
| Published cadence over-commits publicly | Medium | High | Publish measured trailing numbers only; legal/marketing review before external publication; internal doc is the default |
| Consistency rules encode wrong assumptions (e.g., legitimate free-mail executives) | Medium | Low | Warn tier only (never quarantine); rule-level false-positive tracking via `failures` JSON; rules versioned and fixture-tested |

## Success metrics

- **Contracts:** 100% of stage boundaries carry a versioned zod contract; 0 unreviewed
  BACKWARD violations merged; contract check runtime <60 s in CI.
- **Gate coverage:** 100% of records entering `verified_records` carry
  `quality_score`/`quality_dims`/`score_version`; quarantine rate and invalid rate are
  computable per parser version per day.
- **Confidence is real (with doc 11):** confidence over the golden fixture set has non-zero
  variance (vs today's ≡1.0); ≥90% precision of HIGH-confidence auto-routing measured
  against human review outcomes.
- **Verification states:** 100% of golden emails carry a status + `verified_at`; hard-bounce
  rate on synced emails <0.5% (target) with a <2% hard ceiling; catch-all share reported
  separately.
- **Freshness:** p95 age-since-verification ≤ the field's SLA (email 90 d, employment 60 d,
  phone/firmographics 180 d — `dataHealth.ts:19-25`); % of gold in the `expired` band <5%.
- **Anomaly detection:** injected drift (null-rate step change on staging) alerts within one
  metrics window; mean time-to-detect a parser regression <1 hour of pipeline activity.
- **Cadence asset:** `docs/trust/verification-cadence.md` regenerates monthly with zero
  manual data entry; re-verification spend stays within the per-month budget while the
  top account-value decile holds p95 email freshness ≤30 d.

## Effort & priority

**P1, 8–11 eng-weeks, phased F1–F3.** This is not P0 because nothing here unblocks the
pipeline's basic correctness — that is doc 01's F1 inventory — but it is squarely
"needed for enterprise readiness within the next phase": without the gate, scoring, and
verification states, Forge's golden layer is un-auditable and un-sellable the day real
volume lands, and retrofitting scores/contracts after millions of rows exist costs multiples
of doing it now, while gold is empty. Breakdown for the 2–3-engineer pod: contracts + CI
~1.5 wks and metrics + anomaly ~1.5 wks (F1 tail/F2 start — they also harden F1's own
fixes); gate + verdicts + kernel extension ~3 wks and per-field verification + verifier
wiring ~2 wks (F2, matching S.1's "quality scoring + verification states"); re-verification
sweep, BFF/console surface, and the cadence statement ~2.5 wks (F2/F3). The only new
infrastructure is two tables and (optionally) one Soda container — consistent with the
program-wide "buy nothing heavyweight" posture.

## Future enhancements

- **ML data quality (F4):** anomaly models beyond z-score (seasonality, multivariate),
  learned field-validity predictors, and decay-rate models per sector/seniority — only after
  12+ months of verification outcomes exist to train on (fact pack S.1 F4).
- **Metadata-driven rule catalog:** move rules-as-code into the metadata-driven source
  registry (fact pack §7.7) once multi-source onboarding makes config-driven validation pay;
  a DB `validation_rules` table becomes worthwhile then, not before.
- **ODCS YAML exports** per dataset for enterprise buyers' data-governance reviews, generated
  from the same zod schemas.
- **Bounce-feedback ingestion loop:** an outbox-fed feedback event from the main app
  (delivery outcomes on synced emails) flowing back into `field_verifications` — the full
  closed loop; requires the CDC/fan-out seam (`08-pipeline-architecture.md`, F3 trigger).
- **Consumer-facing quality display:** exposing golden quality dims in the customer product
  (overlay UI) once the two scoring vocabularies are converged — a product decision, not a
  platform one.
- **IAA/honeypot review-quality metrics:** the planned inter-annotator-agreement and honeypot
  machinery for the human review lane (`review_tasks.is_honeypot` exists unused — fact pack
  §3.2) belongs to the review-workflow work in `05-entity-resolution.md`/console v2.
