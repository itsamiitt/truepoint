# 11 — AI-Assisted Processing

> **Priority:** P0 · **Effort:** 12–16 eng-weeks (staged: ~4–5 in F1, ~5–6 in F2, ~3–5 in F3) ·
> **Phase:** F1 (persist output, real confidence, real budget, PII minimization) → F2 (batch +
> caching + golden set + drift) → F3 (AI for data quality)
> (phases are defined in 17-phased-implementation-roadmap.md)

## Executive summary

Forge's AI layer is the strangest artifact in the whole build: a genuinely well-designed
extraction port — structured JSON output, an injection guard, a one-repair-pass policy, and a
grounded-confidence composite mirroring the main app's proven `nlSearchAdapter` seam — wired
into a worker that **calls Anthropic, pays for the tokens, and throws the result away**
(P-01.2, `apps/forge-worker/src/processors.ts:112-127`). Every capture that reaches stage S2
today produces spend and zero data. The safety story is equally hollow in practice: the
"grounded confidence" evaluates to a constant 1.0 because the validator is `value !==
undefined` and the judge defaults to 1; grounding is a loose substring `includes()`; the
budget is an in-memory, per-process, per-capture counter that resets on restart (P-01.21); the
full verbatim LinkedIn payload — raw PII — is sent to the model with no minimization; and
token spend is never recorded anywhere, so the cost is not even observable. There is no golden
set, no eval gate, and no drift detection, and the deterministic-first cost gate the planning
suite mandated (`isAiEligible`) exists in `forge-core` with zero production callers — as
built, 100% of captures pay for AI regardless of parser success.

The recommendation (S.2 #6, argued in full below) is a **deterministic-first cascade**:
versioned JSONPath+Zod mappers handle the structured LinkedIn payloads for ~$0 (they are JSON,
not free text), `claude-haiku-4-5` via the Batch API (flat 50% off) with a prompt-cached
instruction prefix handles the unrecognized/free-text residue, `claude-sonnet-5` takes
escalations on validation failure or low confidence, and `claude-opus-4-8` is reserved for
offline evals and ER adjudication. Combined with a content-hash result cache (re-captures cost
$0, honoring the platform's never-pay-twice rule) this lands blended extraction cost at
**$500–1,500 per million records** versus ~$27,500/M for a naive online Opus-only path (Opus batch halves that to ~$13,750/M) —
roughly a 10–25× reduction — while a durable per-tenant/day budget, persisted candidates, a
real confidence composite, PII minimization, a golden set with a CI gate, and payload-drift
monitors make the layer correct, safe, and governable. F3 then points the same machinery at
data quality itself: LLM adjudication of the uncertain ER band (see `05-entity-resolution.md`),
title/industry normalization, intent classification, and cheap statistical anomaly detection.

## Current state

### What is built (and works, in isolation)

`packages/forge-core/src/extraction.ts` implements `runExtraction` as a pure, DI'd stage
(fact-pack §3.1): a six-phrase injection-guard regex, payload sanitization with an 8K-char
cap, a budget gate, the port call, a grounding check, and a composite confidence of
`0.4·grounding + 0.3·validator + 0.3·judge − 0.15·repairPenalty` with a HIGH threshold
constant of 0.8. The unit tests are behavioral and adversarial — no-spend-on-injection and
budget-refund cases are covered against fakes (fact-pack §3.4). The Anthropic adapter lives in
`packages/integrations` (landed in the P2 wave, its barrel exports restored in commit
`c77edfc5`) and mirrors the main app's `nlSearchAdapter` pattern: structured JSON via
`output_config`, adaptive thinking, one repair pass, prompt-injection defense (fact-pack §2.3,
ADR-0023). The `forge.extraction_runs` metering table exists in migration
`packages/db/src/migrations/0070_forge_schema.sql`, and `extraction_runs.target_tenant_id` is
the one place tenant attribution survives past bronze, expressly for cost accounting
(fact-pack §6.7).

### What actually happens on the S2 path

- **The output is discarded.** The worker invokes the port, meters the run, ignores the
  returned candidate fields entirely, and enqueues resolve regardless of outcome
  (`processors.ts:112-127`, verified; P-01.2). No candidate store exists. Nothing downstream
  ever sees an extracted field — the verify stage inserts a hardcoded
  `taskType: "ai_low_confidence"`, `confidence: 0.5`, `priority: 50` review task
  (`processors.ts:143-147`) untouched by any real extraction result.
- **The full raw payload is the prompt.** `processors.ts:108` passes the verbatim capture
  payload — raw LinkedIn PII — to the model as "residue". The 8K sanitization cap then slices
  that JSON arbitrarily mid-structure. `sensitiveFields` is never set, so the always-review
  posture the core supports is inert (P-01.21).
- **Confidence is a constant.** `validatorOk = (value !== undefined)` and the judge defaults
  to 1, so any field that clears the loose grounding check scores exactly 1.0 (fact-pack
  §3.3). Grounding itself is substring `includes()` in either direction — a one-word value
  "grounds" anywhere in a 120KB payload.
- **The budget is not a control.** Production uses `inMemoryBudgetStore`
  (`processors.ts:103`): per worker process, reset on restart, keyed
  `rawCaptureId:tenantId` — i.e. per-capture, not per-tenant/day — with a limit of 1,000
  abstract units (P-01.21). The worker runs `forge-ai-extract` at concurrency 4 (fact-pack
  §4.2) although the planning suite pinned it at 1 "until an atomic budget lease" exists
  (fact-pack §2.1). There is no global cap, and the forge services carry no CPU/memory limits
  on the shared single VM (fact-pack §4.4, P-01.29) — the one process authorized to spend
  money externally is the least constrained.
- **Spend is invisible.** The metering row never populates `latencyMs`, `inputTokens`, or
  `outputTokens` even though the port returns them (`extraction.ts:283-303`, fact-pack §3.2).
  There is no `cost_micros`, no per-model attribution, no `/metrics` counter (fact-pack §4.4).
- **Retries re-bill.** The extract handler is non-idempotent on an at-least-once queue: every
  redelivery re-calls Anthropic and duplicates the metering row (P-01.16).
- **The cost gate is dead code.** `isAiEligible` — the deterministic-first router — has zero
  production callers (fact-pack §3.1). Because the only parser (`voyager-profile-1-0-0`)
  cannot successfully upsert silver anyway (P-01.1, `parsers/index.ts:18` vs `0070:75`), every
  capture flows to S2 and pays.
- **No evals, no drift detection.** There are no golden-fixture files despite a
  `golden_fixture_ref` column, the Anthropic adapter is untested, and no forge integration
  test exists in CI (fact-pack §3.4, P-01.28). Nothing detects a LinkedIn payload-shape change
  or a prompt regression; a silent upstream change would burn spend indefinitely.
- **Config bypasses validation.** `packages/config/src/forge.ts` reads bare `process.env`
  outside the validated `appEnvSchema` (P-01.29), so a missing or malformed AI config is not
  caught at boot.

### What the planning suite specifies (intent, not reality)

The S2 design in `docs/planning/forge/` (fact-pack §2.1) prescribes exactly the discipline the
build skipped: deterministic-first routing with AI only on unstructured residue (~10% of
parsed records), three hallucination guardrails (schema validation, grounding via **char
offsets**, refuse-on-uncertain), a grounded-confidence composite that never trusts model
self-report alone, a re-keyed per-job/per-tenant `budgetGuard`, `extraction_runs` metering
with token counts, a 24h prompt cache, and a tiered model ladder with fallback. Its scale
model (doc 17, uncalibrated) projects 0.5M AI calls/day at baseline and 5M/day under stress,
and names **ai-extract spend as one of the two hard ceilings of the whole system** (the other
is human review). The testing plan (doc 18) requires an AI-eval harness with a synthetic-PII
golden set. None of this is contradicted by the target architecture below — the plan is
largely right; the build simply does not implement it.

## Problems identified

Ordered by severity. Re-cites of doc 01 problems keep their P-01.x IDs per fact-pack §S.3.

- **P-11.1 — BUG · Extraction output is discarded while spend is incurred** (re-cite
  P-01.2). Every S2 execution is pure cost: the API is called, tokens are billed, and the
  candidate fields are dropped (`processors.ts:112-127`). At the planning baseline of 0.5M
  calls/day this is four to five figures of daily spend producing nothing. This is the single
  highest-leverage fix in the AI layer.
- **P-11.2 — BUG · The confidence composite is degenerate.** `validatorOk = (value !==
  undefined)` and a judge that defaults to 1 collapse the 0.4/0.3/0.3 composite to ≡1.0 for
  any grounded field (fact-pack §3.3). The 0.8 promotion threshold in
  `verification.ts` therefore gates nothing; "refuse-on-uncertain" can never trigger. Combined
  with promotion trusting a *client-supplied* confidence (P-01.11), confidence as a control
  does not exist anywhere in the write path.
- **P-11.3 — BUG · Grounding is substring `includes()` in either direction.** A short value
  grounds against any payload; a hallucinated two-word title fails only if neither word-run
  appears verbatim. The char-offset plumbing exists (`ExtractedField.offset`; `isGrounded` slices the
  residue at `extraction.ts:115-117`), but grounding is not *strict*: it uses substring `includes()` and
  falls back to a whole-residue match when the offset is null, so a short or hallucinated value can still
  pass. The fix is offset-anchored equality, not adding a guardrail that is absent.
- **P-11.4 — RISK · Verbatim raw PII is sent to a third-party processor with no
  minimization.** The full LinkedIn payload goes out (`processors.ts:108`); `sensitiveFields`
  is never set; nothing prunes identifiers, contact channels, or free-text the extractor does
  not need. This conflates the bronze "raw PII stays inside Forge" posture (suite invariant 1,
  fact-pack §2.6) with an external egress, and it does so before any lawful-basis/consent
  gate exists (P-01.23; compliance treatment is doc 12's).
- **P-11.5 — RISK · The AI budget is not a real control** (re-cite P-01.21). In-memory,
  per-process, per-capture, reset on restart, no per-tenant/day dimension, no global cap, no
  durable ledger — while the worker runs at concurrency 4 against the plan's
  concurrency-1-until-atomic-lease rule, with no container resource limits (fact-pack §4.2,
  §4.4). A retry storm or poisoned queue can spend unboundedly.
- **P-11.6 — GAP · Token spend is never recorded.** `extraction_runs` omits latency and token
  counts (`extraction.ts:283-303`); there is no `cost_micros`, no per-tenant/day rollup, no
  metric. FinOps for the system's named #1 cost ceiling is impossible (feeds doc 12's metrics
  catalog and `15-cost-optimization.md`).
- **P-11.7 — DEBT · Every capture pays for AI.** `isAiEligible` is unused; the deterministic
  layer routes nothing; the plan's "~10% of parsed" becomes 100% as built. This inverts the
  intended cost structure by ~10×.
- **P-11.8 — BUG · The extract handler re-bills on retry** (re-cite P-01.16). At-least-once
  delivery plus a non-idempotent handler means transient failures multiply spend and metering
  rows; there is no result cache and no run-key check before the port call.
- **P-11.9 — GAP · No golden set, no eval harness, no CI gate.** Prompt, schema, or model
  changes ship blind; the adapter itself is untested (fact-pack §3.4). Doc 18's mandated
  AI-eval harness with synthetic PII is unbuilt.
- **P-11.10 — GAP · No drift detection.** No payload-shape fingerprinting per adapter
  version, no per-field null/enum distribution monitors. A LinkedIn DOM/API change silently
  degrades extraction while continuing to spend (quarantine routing exists as an enum but the
  lane is a `console.warn`, P-01.8).
- **P-11.11 — GAP · No batching, no prompt caching, no result caching.** Every call is
  online at full price; identical re-captures pay again, violating the platform's
  enrichment-is-metered-and-cached / never-pay-twice decision (template FIXED decision 7).
  Batch (−50%) and cache-read (0.1×) discounts stack and are simply left on the table.
- **P-11.12 — RISK · The injection guard is a six-phrase regex.** Better than nothing, and
  the refund-on-block behavior is right, but as the only defense in front of
  attacker-influenced payloads it is trivially bypassed; defense must not depend on it
  (mitigated structurally by schema-constrained output + offset grounding, below).
- **P-11.13 — GAP · No model tiering or fallback.** One static model path; no
  cheap-first/escalate-on-fail ladder, no eval-gated model upgrades, no re-baselining for the
  ~30% tokenizer shift on current-generation models (research below). The adapter's default model ID is
  `claude-haiku-4-5-20251001` (`packages/config/src/forge.ts:57`) — a reasonable cheap default; the audit
  treats the tiering absence, not the specific choice, as the defect.

## Research findings

### Anthropic pricing and platform mechanics (verified 2026-07-22, platform.claude.com)

Prices in $/MTok input/output ([pricing](https://platform.claude.com/docs/en/pricing),
[models overview](https://platform.claude.com/docs/en/about-claude/models/overview)):

| Model | Model ID | Input | Output | Batch (−50%) input/output |
|---|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | $10 | $50 | $5 / $25 |
| Claude Opus 4.8 | `claude-opus-4-8` | $5 | $25 | $2.50 / $12.50 |
| Claude Sonnet 5 | `claude-sonnet-5` | $2 intro → $3 after 2026-08-31 | $10 intro → $15 | $1 / $5 (intro) |
| Claude Sonnet 4.6 / 4.5 | `claude-sonnet-4-6` / `-4-5` | $3 | $15 | $1.50 / $7.50 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1 | $5 | $0.50 / $2.50 |

- **Batch API** ([batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing)):
  flat 50% off all token usage; up to 100K requests or 256MB per batch; most batches complete
  within 1 hour (24h max); results retrievable for 29 days; results arrive in any order — key
  by `custom_id`. All Messages features are supported inside batches, including structured
  outputs and prompt caching.
- **Prompt caching** ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)):
  cache reads bill at 0.1× input price; writes at 1.25× (5-minute TTL) or 2× (1-hour TTL);
  caching **stacks with batch** — a cached instruction prefix inside a batch reads at
  effectively 0.05× the base input rate. Caveat that matters for the Haiku tier: the minimum
  cacheable prefix on `claude-haiku-4-5` is 4,096 tokens (per Anthropic's caching docs; verify against
  current limits) — shorter prefixes silently do not
  cache — so the instruction+schema+few-shot prefix must be consolidated above that line, and
  the hit must be verified via `usage.cache_read_input_tokens` in metering.
- **Structured outputs** ([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)):
  `output_config.format` with a JSON schema (or strict tools) is GA on Fable 5, Opus 4.8,
  Sonnet 5, and Haiku 4.5. No recursive schemas; `additionalProperties: false` is required on
  every object; numeric/string range constraints are unsupported (validate those client-side —
  which Zod does anyway). New schemas pay a one-time compile cost, then hit a 24-hour
  schema cache — version schemas deliberately, don't churn them per request.
- **Tokenizer caveat:** Opus 4.7+, Sonnet 5, and Fable 5 tokenize the same text to roughly
  ~30% more tokens (1×–1.35×) than the previous generation; Haiku 4.5 is on the older
  tokenizer. Cost models must be re-baselined per model with
  [`count_tokens`](https://platform.claude.com/docs/en/build-with-claude/token-counting),
  never with a blanket multiplier — and budgets must be denominated in currency (micros), not
  tokens.
- **Haiku 4.5 limits:** 200K context, 64K max output — comfortably above the payload p99 of
  120KB/cap 1MB in the scale model once payloads are pruned (fact-pack §2.1).

### Extraction cost math (fact-pack §11.2, arithmetic re-checked)

At 3K input / 500 output tokens per record, batched, with a cached prefix:

| Path | $/record | $/1M records |
|---|---|---|
| `claude-haiku-4-5`, batch | $0.00275 | ≈ $2,750 |
| `claude-sonnet-5`, batch (intro) | $0.0055 | ≈ $5,500 |
| `claude-opus-4-8`, batch | $0.01375 | ≈ $13,750 |
| **Blended cascade** (deterministic 60–80% at $0 → Haiku batch → ~5% Sonnet escalation) | — | **≈ $500–1,500** |

Content-hash result caching (`sha256(payload ‖ prompt_version ‖ schema_version)`) makes
re-captures of identical content **$0** — directly the platform's never-pay-twice rule. At the
planning baseline of 0.5M AI-eligible calls/day, the difference between a naive online
Opus-class path (~$13.7K/day) and the cascade (≲$0.7–1.4K/day, shrinking further as the
deterministic tier absorbs share) is the difference between AI being the system's #1 cost
ceiling and a rounding error next to enrichment spend (`15-cost-optimization.md`).

### Production patterns for LLM-in-the-pipeline

- **Deterministic mapper first.** LinkedIn Voyager payloads are structured JSON; versioned
  JSONPath+Zod mappers extract the head of the distribution at ~$0 and cannot hallucinate.
  LLMs are reserved for free-text and unrecognized shapes (fact-pack §11.2). This is also the
  metadata-driven-pipeline pattern research flags as the single highest-leverage internal
  investment for a many-sources product (fact-pack §7.7).
- **Two-phase prompting, one repair.** Reason-then-format (think, then emit the schema'd
  JSON), at most one repair re-prompt on schema failure, then route to review — never repair
  loops. Forge's core already encodes the one-repair policy; keep it.
- **Confidence without logprobs.** The Claude API does not expose logprobs; production
  confidence is a composite of (a) per-field **self-report enums** (ordinal
  `certain|likely|unsure|absent`, calibrated against audited samples — never used raw), (b)
  **agreement sampling** (k independent samples; field-level agreement rate), and (c)
  **deterministic validators** (schema, regex, cross-field checks). Forge's composite shape is
  right; its inputs are stubs (P-11.2).
- **Golden sets and CI gates.** Start with ~50 fixtures, grow to 200–500 JSONL cases in git
  (synthetic PII only, per doc 18's no-live-PII rule); gate CI on field-level accuracy vs a
  pinned baseline; every prompt/schema/model change runs the gate.
- **Drift monitors.** Hash the set of payload key-paths per adapter version (shape
  fingerprint), and track per-field null-rate/enum distributions with a trailing-window
  z-score (|z| ≥ 3 alerts) — the cheap reproduction of commercial data-observability tools at
  this size (fact-pack §9.1, §11.2). A DOM/API change then pages within a day instead of
  burning spend silently.
- **HITL economics.** Confidence-route review: auto-accept at ≥85–90% to start and calibrate
  on audited samples; 0.5–2% stratified random QA with oversampling of new-adapter and
  low-confidence strata; every reviewed item feeds the golden set and few-shot pool.

### AI for data quality (F3 targets)

- **ER adjudication:** GPT-4-class zero-shot beats transferred fine-tuned PLM matchers by
  8–40 F1 on unseen domains (Peeters & Bizer, [arXiv:2310.11244](https://arxiv.org/abs/2310.11244));
  Ditto-style trained matchers win only in-domain. The production architecture is blocking →
  cheap scorer → **LLM adjudication only on the uncertain band** (<5% of pairs; ≈$0.5–1 per
  1K pairs on Haiku batch). This slots directly into `05-entity-resolution.md`'s Tier-B
  review band.
- **Title normalization:** embed the raw title → top-k candidates from
  [ESCO](https://esco.ec.europa.eu/en/classification/occupation_main) (~3,000 occupations) or
  [O*NET-SOC](https://www.onetcenter.org/taxonomy.html) (~1,000) → Haiku picks; cache by
  normalized title string. Titles are Zipf-distributed — a few hundred thousand distinct
  strings cover 100M records, so the steady-state cost is near zero.
- **Industry classification:** two-stage NAICS RAG (retrieve candidate codes, then constrain
  the model to choose among them), per Ramp's engineering account
  ([builders.ramp.com](https://builders.ramp.com)).
- **Intent:** rules + LLM text-signal classification for v1; learned propensity models only
  after real outcome labels exist.
- **Anomaly detection:** per-batch stats (null %, distinct %, length quantiles, enum
  histograms) in Postgres with z-score alerts — no ML needed at this size (shared with doc
  04's quality framework).

## Enterprise best practices

A ZoomInfo/Apollo/Clearbit-class platform treats the LLM as a **fallback stage inside a
governed pipeline, never as the pipeline**: structured sources are parsed deterministically;
models see the minimum necessary payload (data-processor agreements plus minimization, because
the vendor's own compliance posture depends on it); every model output lands as a *candidate*
with per-field provenance, confidence, and grounding evidence — never directly as truth;
promotion is gated by calibrated thresholds and human review of the uncertain band only;
every reviewed item becomes eval/training data; prompt, schema, and model versions are pinned,
eval-gated, and rolled out like code; and spend is metered per tenant per day with hard
budgets, because metered inference is a COGS line, not an experiment. The bar, concretely: no
unmetered call, no unpersisted output, no uncalibrated confidence, no unevaluated prompt
change, no unminimized payload. Forge's core has the right *shapes* for most of this; the
work is making the shapes load-bearing.

## Recommended architecture

### The deterministic-first cascade (S.2 #6) — and why

```text
bronze raw_capture (immutable; replayable from R2 per 02-enterprise-data-platform.md)
  │
  ├── Tier 0 — deterministic mappers ····································· ~$0
  │     versioned JSONPath + Zod per (source, endpoint, schema_version)
  │     LinkedIn Voyager payloads are structured JSON → 60–80%+ terminate here
  │     output: parsed_records fields with confidence 1.0, provenance "parser"
  │
  ├── Tier 1 — claude-haiku-4-5 · Batch API · cached instruction prefix ·· $0.00275/rec
  │     unrecognized shapes + free-text residue only (headline, about, position blurbs)
  │     structured outputs (output_config json_schema) + offset grounding
  │
  ├── Tier 2 — claude-sonnet-5 · online, low volume ······················ escalation only
  │     triggers: schema validation fails after 1 repair, OR composite < accept threshold
  │
  └── Tier 3 — claude-opus-4-8 ··········································· offline only
        golden-set evals, eval-time judge, ER adjudication batches (05-entity-resolution.md)

every tier → forge.extraction_candidates (+ extraction_runs with tokens & cost_micros)
result cache: sha256(content_hash ‖ prompt_ver ‖ schema_ver ‖ model) → re-captures $0
```

The argument for S.2 #6, made explicit:

1. **The payloads are already structured.** Voyager responses are JSON; paying a language
   model to re-derive `firstName` from a JSON document is paying for entropy that does not
   exist. Mappers are exact, auditable, and drift-detectable (a shape-hash change is a
   deterministic signal, not a quality regression to be discovered statistically).
2. **The economics are decisive.** 60–80% deterministic coverage turns $13,750/M (online
   Opus-class) into $500–1,500/M blended — and the planning suite itself names ai-extract
   spend as one of two system-wide hard ceilings. The cascade is the only architecture in
   which AI spend scales with *residual entropy* instead of raw volume.
3. **Quality routes correctly.** Mappers cannot hallucinate; the LLM tier carries the
   hallucination controls (schema + offsets + composite); the escalation tier concentrates
   expensive capability exactly where the cheap tier demonstrably failed; humans see only the
   uncertain band. Each tier's failure mode is caught by the next.
4. **The counterarguments are weak here.** "Mappers are maintenance burden" — the parser
   registry (fact-pack §2.1) is already designed for versioned, golden-fixture-gated mappers,
   and the metadata-driven registry pattern cuts schema-evolution cost (~35%, fact-pack §7.7).
   "One model is simpler" — simpler until the first silent format change, the first spend
   spike, and the first compliance question about why full profiles were egressed to score
   1.0 confidence nobody computed.

### Component 1 — persist candidates (fixes P-11.1)

A new `forge.extraction_candidates` table stores every per-field output with grounding
offsets, validator/judge/repair evidence, model + prompt + schema versions, and the composite
confidence. Resolve (S3) and verify (S4) read candidates instead of hardcoding
`confidence: 0.5`; promotion derives confidence from pipeline state, never from the request
body (closing the P-01.11 seam together with doc 03's server-side recompute work).

### Component 2 — a real confidence composite (fixes P-11.2, P-11.3)

Keep the composite shape `0.4·grounding + 0.3·validator + 0.3·judge − 0.15·repair`; replace
its inputs:

- **Grounding → char offsets.** The schema requires each extracted field to carry
  `source_span: {start, end}` into the sanitized residue; the server verifies
  `normalize(residue.slice(start, end)) === normalize(value)`. A field without a verifiable
  span gets grounding 0 and can never auto-accept. This is the planned guardrail (fact-pack
  §2.1) and the structural defense that makes the regex injection guard (P-11.12)
  non-load-bearing: an injected instruction cannot fabricate a span that isn't in the payload.
- **Validator → actual schema validation.** Per-field Zod validation (type, enum, format,
  cross-field rules) — the same schemas that define the structured-output contract, so the
  contract and the validator cannot drift apart.
- **Judge → self-report enum + agreement sampling.** Fields carry an ordinal self-report
  (`certain|likely|unsure|absent`) mapped to a calibrated scalar; for a configurable sample
  (start 10%, plus all escalations) run k=2 Haiku samples and use field agreement as the judge
  signal. A separate Opus 4.8 judge runs offline over golden-set evals only — never in the
  hot path.
- **Calibration.** Thresholds (auto-accept, escalate, review) are fit on the golden set +
  audited review outcomes, reported as calibration error in CI, and stored as versioned
  config — not constants in code.

### Component 3 — cost plane (fixes P-11.7, P-11.8, P-11.11)

- **Batch by default.** Extraction is pipeline work with no interactive consumer; the backfill
  and steady-state lanes submit accumulated requests as batches (≤10K per batch to start,
  `custom_id` = cache key), polled by a repeatable job. A small online lane (priority 1, per
  the queue design) serves live captures with online Haiku when a sub-minute SLO applies.
- **Prompt-cache the prefix.** One consolidated instruction+schema+few-shot prefix > 4,096
  tokens (the Haiku 4.5 minimum), 1h TTL during batch windows; verify
  `cache_read_input_tokens > 0` in metering and alert when the read rate drops (a silent
  prefix invalidator is a cost regression).
- **Result cache.** `forge.extraction_cache` keyed
  `sha256(content_hash ‖ prompt_version ‖ schema_version ‖ model)`; checked before any lease;
  re-captures and retries cost $0. This plus a run-key uniqueness check before the port call
  makes the handler idempotent (P-11.8) — a redelivery finds the cache/run row and completes
  without spending.

### Component 4 — budget plane (fixes P-11.5, P-11.6)

A durable `AiBudgetStore` replaces `inMemoryBudgetStore`: Redis `INCRBY` on
`forge:ai:{tenantId}:{yyyy-mm-dd}` for the atomic hot ledger, mirrored to `forge.ai_budgets`
in Postgres (the floor after a Redis loss), with an **atomic lease → call → settle** protocol
(estimate leased before the call, actual settled after, delta refunded — preserving the
existing refund-on-injection-block behavior). Per-tenant/day caps plus a global daily cap and
a `FORGE_AI_EXTRACT_ENABLED` kill switch. This deliberately reuses the main app's
enrichment daily-budget-breaker + `provider_calls.cost_micros` pattern (fact-pack §2.3) —
same semantics, same `cost_micros` denomination — rather than inventing a fifteenth duplicate
stack (S.2 #2); tenant attribution rides `extraction_runs.target_tenant_id` (fact-pack §6.7).
Every run row now records `input_tokens`, `output_tokens`, `cache_read_tokens`, `latency_ms`,
`cost_micros`, `batch_id`, `cache_hit` — closing P-11.6 and feeding doc 12's `forge_ai_*`
metrics and `15-cost-optimization.md`'s ledgers.

### Component 5 — PII minimization (fixes P-11.4)

The model never sees the full payload again. Tier 0 mappers consume the structured fields;
only the *unmapped residue* (specific free-text values, individually selected) is assembled
into the prompt — pruned of URLs, tracking IDs, images, and contact channels the extractor
does not need. `sensitiveFields` is set for any residue field classified sensitive, which
activates the core's existing always-review posture. Retention/DPA posture (Anthropic API
data-retention configuration, regional inference options) is recorded as an explicit ops
checklist item for counsel — the org's current retention configuration is not established by
this audit (unverified) — with the compliance treatment owned by doc 12.

### Component 6 — eval + drift plane (fixes P-11.9, P-11.10)

Golden set in git (`packages/forge-core/test/fixtures/extraction/*.jsonl`, synthetic PII, 50 →
200–500 cases spanning payload shapes and adversarial cases), an eval runner that scores
field-level exact-match/normalized-match per tier, and a CI gate that fails on regression
against the pinned baseline. Drift monitors: per-adapter payload key-path shape hash (change →
quarantine lane + alert, closing the loop with P-01.8's persisted quarantine from
`03-data-ingestion-architecture.md`), and per-field null/enum distribution z-scores wired to
the worker's `/metrics` (doc 12; `forge-core`'s unused `observability.ts` SLO/alert helpers
finally earn their keep). Reviewed HITL items append to the golden set.

### Component 7 — AI for data quality (F3)

The same governed port serves four DQ consumers, each behind its own flag and budget line:
ER adjudication of the uncertain Fellegi-Sunter band (<5% of pairs, Haiku batch, evidence
persisted as `match_edges` features — architecture and ownership in
`05-entity-resolution.md`); title normalization (embed → top-k ESCO/O*NET → Haiku pick,
cached by normalized title); industry NAICS two-stage RAG; intent rules+LLM. Statistical
anomaly detection (doc 04) stays deliberately non-LLM.

### Port and routing sketch

```ts
// packages/forge-core/src/extraction.ts (revised contract)
export interface ExtractedField {
  name: string;
  value: unknown;
  sourceSpan: { start: number; end: number } | null; // offsets into sanitized residue
  selfReport: "certain" | "likely" | "unsure" | "absent";
}
export interface ExtractionResult {
  fields: ExtractedField[];
  model: string; promptVersion: string; schemaVersion: string; repairCount: 0 | 1;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number;
           latencyMs: number; costMicros: number };
}
export interface AiBudgetStore { // durable + atomic; replaces inMemoryBudgetStore
  tryLease(tenantId: string, day: string, estimateMicros: number): Promise<Lease | "exhausted">;
  settle(lease: Lease, actualMicros: number): Promise<void>;
}
export type CascadeRoute =
  | { tier: "deterministic"; parserVersionId: string }
  | { tier: "haiku-batch" }
  | { tier: "sonnet-escalate"; reason: "schema_fail" | "low_confidence" }
  | { tier: "quarantine"; reason: "no_parser" | "shape_drift" | "budget_exhausted" };
```

## Implementation details

Steps in dependency order. All migrations are hand-authored (drizzle-kit generate is unsafe in
this repo, fact-pack §2.3); pick the next free migration index against the journal, which
already carries a duplicate-0053 quirk (fact-pack §6.4).

**F1-a — Persist output + full metering (unblocks everything).**
- `packages/db/src/migrations/00NN_forge_extraction_candidates.sql`:

```sql
CREATE TABLE forge.extraction_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_capture_id uuid NOT NULL REFERENCES forge.raw_captures(id),
  extraction_run_id uuid NOT NULL REFERENCES forge.extraction_runs(id),
  field text NOT NULL,
  value jsonb NOT NULL,
  grounding_start integer, grounding_end integer,
  validator_ok boolean NOT NULL,
  judge_score numeric(4,3),
  repair_count smallint NOT NULL DEFAULT 0,
  confidence numeric(4,3) NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  sensitive boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_capture_id, field, prompt_version, schema_version)
);
ALTER TABLE forge.extraction_runs
  ADD COLUMN cost_micros bigint,
  ADD COLUMN cache_read_tokens integer,
  ADD COLUMN batch_id text,
  ADD COLUMN cache_hit boolean NOT NULL DEFAULT false;
-- input_tokens / output_tokens / latency_ms columns exist; the writer must populate them.
```

- `packages/db/src/repositories/forge/extractionRepository.ts`: candidate upserts (idempotent
  on the unique key) + run-row writes that actually carry `usage` (fix at
  `packages/forge-core/src/extraction.ts:283-303`).
- `apps/forge-worker/src/processors.ts:112-127`: persist the result; enqueue resolve **with**
  the candidate ids; stop enqueueing on failure paths (route to quarantine instead).

**F1-b — Real confidence.**
- `packages/forge-core/src/extraction.ts`: validator = per-field Zod; grounding = offset
  verification (schema gains `sourceSpan`); judge = calibrated self-report + optional
  agreement sample; expose the composite inputs in the candidate row. Unit tests extend the
  existing adversarial suite (hallucinated span, span/value mismatch, ungrounded field).

**F1-c — Durable budget + resource limits.**
- `packages/forge-core/src/budget.ts` (new `AiBudgetStore`),
  `apps/forge-worker/src/processors.ts:103` swaps the in-memory store; Redis lease keys +
  `forge.ai_budgets` mirror table (same migration file). Keep `forge-ai-extract` at
  concurrency 1 until the lease is proven atomic under an itest, then restore 4 (fact-pack
  §2.1's rule). Add CPU/memory limits for forge-worker in the compose file (with doc 01's
  F1 ops items).
- `packages/config/src/forge.ts` → fold `FORGE_AI_*` (budget caps, model ids, flags) into the
  validated `appEnvSchema` (P-01.29 fix path), hard-failing on malformed caps.

**F1-d — PII minimization.**
- `apps/forge-worker/src/processors.ts:108`: build the prompt from selected residue fields,
  not the raw payload; set `sensitiveFields`; delete the blind 8K mid-JSON truncation (the
  residue selector bounds size semantically).

**F1-e — Idempotency + itests.**
- Cache/run-key check before the port call; failure-injection itest proving a redelivery
  spends $0; first forge AI itests join the CI suite (P-01.28 workstream).

**F2-a — Tier 0 mappers + routing.**
- `packages/forge-core/src/parsers/`: add mappers per (source, endpoint, schema_version) as
  shapes are catalogued (`voyagerProfile.ts` exists; search/company/activity follow); wire
  `isAiEligible` into a new `packages/forge-core/src/cascade.ts` router invoked by the parse →
  extract seam. Depends on the F1 parser-registry persistence fix (P-01.1) landing first.

**F2-b — Batch + cache adapters.**
- The forge Anthropic adapter in `packages/integrations` (re-exported via the barrel fixed in
  commit `c77edfc5`) gains: a batch submitter (`messages.batches.create`, ≤10K requests,
  `custom_id` = cache key), a `forge-ai-batch-poll` repeatable job (the F1 scheduler work per
  S.1 makes repeatables exist at all), structured outputs via `output_config` json_schema on
  `claude-haiku-4-5`, escalation calls on `claude-sonnet-5`, and the consolidated cached
  prefix (verify ≥4,096 tokens). Model IDs live in validated config, never inline.
- `forge.extraction_cache` table + lookup (same repository).

**F2-c — Golden set + CI gate.**
- `packages/forge-core/test/fixtures/extraction/*.jsonl`; `bun run eval:extraction` runner;
  CI job in the single workflow (fact-pack §6.5) gating on field accuracy vs baseline;
  offline Opus 4.8 judge for eval scoring only.

**F2-d — Drift monitors.**
- Shape-hash per adapter version computed at parse time; per-field distribution stats job
  (repeatable) writing to a small metrics table; `forge_ai_*` gauges/counters exported from
  the worker `/metrics` (doc 12 owns the catalog; `observability.ts` helpers get wired).

**F3 — AI DQ services.**
- `packages/forge-core/src/dq/` (titleNorm, industryNaics, intent) + an adjudication port
  consumed by the ER engine (`05-entity-resolution.md`); each with its own budget line,
  cache, and golden set. Embedding infra for title/industry piggybacks on the search
  workstream's pgvector adoption (fact-pack §11.1).

**API changes:** none public. **UI/UX:** minimal in this doc's scope — the console's Overview
gains AI spend/day and cache-hit tiles via `/bff/overview` when the console contract is
repaired (doc 13's work); the review queue consumes real candidate confidence instead of the
hardcoded 0.5.

## Migration strategy

1. **Stop the bleeding (immediate, zero risk).** Gate S2 behind `FORGE_AI_EXTRACT_ENABLED`
   (default off). Nothing consumes extraction output today (S3 is a pass-through, P-01.2), so
   disabling spend changes no behavior — capture is dark anyway (suite invariant 6). This can
   ship the day the audit is accepted.
2. **F1 rebuild behind the flag.** Land candidates table, metering, confidence, budget, PII
   pruning, idempotency with unit + integration tests; re-enable only on staging/synthetic
   tenants. No data backfill exists to migrate — the discarded history was never persisted;
   bronze rows remain replayable later once raw lands in object storage
   (`02-enterprise-data-platform.md`).
3. **F2 dual-run.** Run the cascade in shadow against the F1 single-model path over the
   golden set and a staging replay window; compare field accuracy, cost/record, and
   confidence calibration; cut over by bumping `prompt_version` (the result-cache key makes
   the rollout side-effect-free). Rollback = flip the router flag back to the single-model
   online path, which stays callable.
4. **F3 flags per DQ service.** Each consumer (adjudication, title, industry, intent) ships
   dark, validates on its own golden set, and enables per tenant cohort. ER adjudication waits
   for ER v1 (`05-entity-resolution.md`) to produce an uncertain band at all.
5. **Re-baselining checkpoints.** Before each model-version change (including the Sonnet 5
   intro-price expiry on 2026-08-31): `count_tokens` re-baseline, golden-set eval, budget-cap
   review — treated as a release, not a config tweak.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Batch turnaround (typically <1h, worst 24h) breaches a freshness SLO | Medium | Medium | Two lanes: online Haiku priority lane for live captures; batch for steady-state/backfill; age-of-oldest alerting (doc 12) |
| Prompt-cache silently not hitting (prefix <4,096 tokens on Haiku, or a byte-level invalidator) | Medium | Medium (cost) | Consolidated versioned prefix; assert `cache_read_input_tokens > 0` in metering; alert on read-rate drop |
| Sonnet 5 intro pricing ends 2026-08-31 (+50% list) | Certain | Low–Medium | Costs modeled at list price; escalation volume capped by design (~5%); budget caps in micros absorb the step |
| ~30% tokenizer inflation on Sonnet 5 / Opus 4.8 skews cost models | High | Low | Per-model `count_tokens` re-baseline; budgets denominated in cost_micros, never tokens |
| Model deprecation/upgrade shifts extraction behavior | Medium | Medium | Model IDs pinned in validated config; eval-gated upgrades via golden set; canary batch before fleet cutover |
| Prompt/schema regression ships unnoticed | Medium | High | CI golden-set gate blocks merge; prompt_version bump forces cache miss + shadow comparison |
| LLM hallucination reaches gold | Low (post-fix) | High | Offset grounding hard-fails ungrounded fields; schema validation; calibrated auto-accept; four-eyes promotion (server-side per doc 01 F1) |
| Prompt injection via captured payload | Medium | Medium | Structured outputs + span verification make injected instructions non-actionable; regex guard retained as tripwire with no-spend refund; injected-content fixtures in the golden set |
| Redis loss wipes hot budget counters | Low | Medium | PG `ai_budgets` mirror is the floor on restart; reconciliation sweep re-syncs; global cap as backstop |
| Budget lease bugs under concurrency overspend | Medium | Medium | Concurrency pinned to 1 until the atomic lease passes failure-injection itests (plan's own rule) |
| PII egress posture challenged (GDPR/DPDP) | Medium | High | Minimized residue only; sensitiveFields always-review; retention/DPA checklist with counsel (doc 12); kill switch |
| Mapper sprawl as sources grow | Medium | Low | Registry-driven mappers with golden fixtures per version (parser framework already specifies this); LLM tier is the managed fallback, so a missing mapper degrades to cost, not to loss |

## Success metrics

- **Zero waste:** 100% of extraction runs persist candidates; `extraction_runs` rows carry
  tokens + `cost_micros` for ≥99.9% of calls; a redelivered job provably spends $0
  (failure-injection test in CI).
- **Cascade efficiency:** deterministic tier terminates ≥60% of captures at launch, ≥80% by
  F2 exit; escalation tier ≤5% of AI calls; result-cache hit rate ≥95% on duplicate content.
- **Cost ceiling:** blended AI cost ≤ $1,500 per 1M records processed (target $750), tracked
  daily per tenant in `15-cost-optimization.md`'s ledger; batch share of AI tokens ≥90%;
  cache-read share of input tokens ≥50%.
- **Budget enforcement:** zero spend beyond per-tenant/day or global caps across worker
  restarts (chaos test kills the worker mid-lease); overspend alarm at 80% of cap.
- **Trustworthy confidence:** every auto-accepted field has a verified char-offset span
  (grounding rate ≥95%, exported per doc 12); auto-accept precision ≥98% on the audited QA
  sample; calibration error ≤0.1 on the golden set.
- **Eval discipline:** golden set ≥200 cases by F2 exit; CI gate blocks any field-accuracy
  regression >1% absolute vs baseline; 100% of prompt/schema/model changes ride a version
  bump.
- **Drift:** payload shape change detected and quarantined within 24h; per-field null-rate
  |z| ≥ 3 alerts wired to on-call.
- **Latency:** batch lane p95 turnaround <2h; online lane p95 <30s end-to-end per record.

## Effort & priority

**P0** because two of the defects are live financial and privacy exposures, not future-scale
concerns: the pipeline pays a metered external vendor for output it discards (P-11.1), and it
egresses verbatim raw PII with no minimization, budget, or ledger while the planning suite
itself names this spend a system-wide hard ceiling (P-11.4/P-11.5/P-11.6). The F1 slice
(persist + confidence + budget + PII, ~4–5 eng-weeks for the 2–3-engineer pod) is
correctness work that must precede any capture-flag flip; the F2 slice (~5–6 weeks) is where
the 10–25× economics land and is prerequisite to any real ingestion volume; F3 (~3–5 weeks)
is deliberately last because AI-for-DQ consumes the governed port F1/F2 create and, for
adjudication, an ER engine that exists (`05-entity-resolution.md`). Total 12–16 eng-weeks
staged across `17-phased-implementation-roadmap.md`.

## Future enhancements

- **Fine-tuned small matcher/extractor** once LLM adjudication spend exceeds ~$1–2K/month
  *and* ≥10K human-reviewed labels exist (fact-pack §11.2's trigger) — not before; the labels
  fall out of the HITL loop for free.
- **Active-learning ER** (doc 20 E3 / F4): review outcomes retrain Fellegi-Sunter weights and
  adjudication few-shots on a cadence.
- **Parser auto-generation** (doc 20 E9): LLM-proposed JSONPath mappers for new payload
  shapes, admitted only through the golden-fixture gate and human review — turning Tier 1
  volume into new Tier 0 coverage over time.
- **Learned intent/propensity models** once outcome labels (replies, bookings) accumulate;
  v1 stays rules+LLM.
- **Embedding-served similarity** for title/company matching at scale on
  pgvector/pgvectorscale (with the search workstream, fact-pack §11.1), replacing per-call
  top-k retrieval for the normalization services.
- **Residency/retention options for inference** (regional inference, retention
  configuration) as enterprise/DPDP requirements firm up — evaluated with counsel alongside
  doc 12's compliance spine; current org configuration unverified in this audit.
- **Extraction-quality feedback into survivorship:** candidate confidence and grounding
  evidence as survivorship inputs for golden records (doc 04 / `05-entity-resolution.md`),
  once both layers are live.
