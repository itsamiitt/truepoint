# 23 — AI & Intelligence Layer

> The AI surface: an **assistive-first, agentic-with-guardrails** layer on **Anthropic Claude** behind a
> single `AiPort` — NL search, a conversational copilot, generative drafting, summarization, an account
> research agent, AI extraction, and signal-to-play — all **grounded** and **human-reviewed**.
> [ADR-0023](./decisions/ADR-0023-ai-provider-and-intelligence-architecture.md) locks the choice;
> code isolation per [16 §11](./16-code-organization.md).

## 1. Principles

- **Augmented human, not autonomous.** AI proposes; people approve. Any AI output that **sends** or
  **persists** is reviewed first (`H19`, `15` opp L1).
- **Grounded, never hallucinated PII.** AI reads only **revealed/owned** overlay data + the **masked**
  master graph; it cannot surface unrevealed PII, and reveal/suppression gating still apply (`H1`/`H5`).
- **Provider-swappable.** Everything is behind `AiPort`; models route per task.
- **Metered & audited.** Every call is recorded (`ai_requests`) and cost-budgeted.

## 2. `AiPort` & model routing

`core/ports/AiPort` exposes task methods; an adapter (`packages/ai`, `16 §11`) calls Claude. A **router**
picks the model per `ai_task_type`:

| `ai_task_type` | Default model | Why |
|---|---|---|
| `nl_search` | Sonnet 4.6 | structured-query compilation, fast |
| `copilot_chat` | Sonnet 4.6 (Opus 4.8 escalation) | grounded Q&A over data |
| `draft_message` | Sonnet 4.6 | personalized drafting |
| `summarize` | Haiku 4.5 / Sonnet 4.6 | account/contact briefs |
| `research_agent` | Opus 4.8 | multi-step web research + synthesis |
| `extract_fields` | Haiku 4.5 | unstructured → structured |
| `suggest_column_mapping` | Haiku 4.5 | CSV headers + sample values → canonical-field map with per-column confidence (§3, [30](./30-bulk-import-export-pipeline.md)) |
| `classify_reply` | Haiku 4.5 | reply-intent triage (Inbox/SDR — [28 §3.13](./28-enterprise-readiness-audit.md)) |
| `embed` | embedding model | semantic vectors (§4) |

Routing balances cost/latency/quality (`19 §8` FinOps); **prompt caching** + `ai_cache` dedupe repeated
work.

## 3. Capabilities

| Capability | What it does | Guardrail |
|---|---|---|
| **NL → structured search** | "VPs of Eng at 50–200-person EU fintechs with recent funding" → validated query object run under RLS + team visibility; never raw SQL | query validation; masked results until reveal |
| **Conversational copilot** | chat over your workspace data + masked universe ("who at Acme should I call?") with citations | grounded; cites records; no unrevealed PII |
| **Generative drafting** | first-touch + sequence-step drafts from a revealed contact's profile + signals | **human review before send**; suppression-checked |
| **Summarization** | account/contact briefs ("why this account matters now") | grounded in owned data + signals |
| **Agentic account research** | multi-step public-web research → brief (funding, hiring, tech, news) | findings **verified** before becoming fields/signals; isolated browsing |
| **AI extraction/cleaning** | parse unstructured text (job posts, signatures, registry docs) → structured fields | confidence-scored; low-confidence routes to review |
| **AI column auto-mapping** | suggest a CSV-header → canonical-field map (with sample values) for the import wizard ([05 §3](./05-features-modules.md), [30](./30-bulk-import-export-pipeline.md)) — see §3.1 | **suggestion only**; per-column confidence; user confirms; low-confidence flagged; never auto-applied |
| **Reply classification** | label inbound replies (positive / objection / OOO / unsubscribe / bounce) to drive Inbox triage + automation | confidence-gated; auto-actions only above a configured floor, else human triage |
| **Signal-to-play** | turn a signal into a recommended play executed by the automation engine (`27`) | runs under automation guardrails (`H21`) |

### 3.1 AI column auto-mapping (import wizard)

Column mapping is the highest-failure step of a CSV import — header-vs-canonical-field mismatch causes
the majority of import failures at scale, so the wizard should propose a map rather than make the user
build one by hand. The `suggest_column_mapping` task (§2) is an `AiPort` method that takes the upload's
**headers + a sample of values per column** and returns, **per source column**, a suggested canonical
target field (contact/account shape, incl. custom-field definitions per [29 §3](./29-settings-administration-architecture.md))
and a **confidence**. It reuses the `extract_fields` machinery (header text + sample values → structured
suggestion), narrowed to the canonical schema as the target.

- **Assistive, not autonomous (`H19`, §1).** The map is a **suggestion surfaced for confirmation** in the
  import wizard ([05 §3](./05-features-modules.md)) — it is **never auto-applied**. Low-confidence and
  unmapped columns are **flagged** so the user reviews them before the import proceeds; high-confidence
  columns are pre-filled but still editable.
- **Propose / store / replay split.** AI **proposes** the map; **settings stores and replays** it. Once
  the user confirms, persistence is owned by the saved **mapping templates** in
  [29 §14](./29-settings-administration-architecture.md) (per-source column maps + AI suggestions, `G-IMP-3`)
  — the AI suggestion seeds a template; subsequent imports of the same source prefill from the saved
  template and only re-invoke the model for unrecognized headers.
- **Where it sits in the pipeline.** Mapping is the confirm step before staging/validation in the bulk
  import/export pipeline — see [30](./30-bulk-import-export-pipeline.md) and
  [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md).
- **Grounded & metered like every other call.** Runs on headers + sampled values only (no full-file scan),
  cached/budgeted per §7, audited in `ai_requests` per §8.

This closes the AI auto-map gap in `G-IMP-3` ([28 §3](./28-enterprise-readiness-audit.md)); the saved-template
half of `G-IMP-3` is owned by [29 §14](./29-settings-administration-architecture.md).

## 4. Grounding & semantic search

- **`embeddings`** (pgvector, [03 §2/§14](./03-database-design.md)) index revealed overlay records +
  masked master entities for **semantic retrieval** (similar accounts/contacts, RAG context).
- **RAG contract:** retrieve → ground → generate with **citations**; the model is told its sources and
  must answer only from them. Retrieval runs under the caller's RLS + `record_visibility` (`H18`).
- Semantic search complements lexical search (Typesense/OpenSearch, `20 §7`) via the `SearchPort` family.

## 5. Scoring: rules → ML

- Lead scoring (`ADR-0008`) starts **rule-based** (transparent weights over ICP fit + intent +
  engagement, explained in `score_breakdown`).
- It evolves to an **ML model** (gradient-boosted on firmographic/technographic/intent features) with a
  **model card**, closed-won labels as ground truth, and A/B evaluation — versioned in `scores` so old and
  new coexist. AI assists feature extraction, not opaque end-to-end scoring.

## 6. Guardrails, safety & eval

- **Content safety** filter on all generation; **prompt-injection / jailbreak** mitigations on agentic
  browsing (treat fetched web text as untrusted, never as instructions).
- **Eval/safety harness** (`ai_evals`): golden test sets for each task gate prompt/model changes in CI
  (quality + safety regressions block release, `19 §2`).
- **Human-in-the-loop** review states (`pending|approved|edited|rejected`) on drafts and agent findings.

## 7. Cost, caching & metering

- Per-tenant/workspace **AI budgets** + rate limits; circuit-break on overrun (`18 §9`).
- **Prompt caching** + `ai_cache` (prompt+grounding-hash keyed) cut repeat cost; Haiku for cheap paths.
- Usage metered in `ai_requests` (tokens, model, cost) → FinOps (`19 §8`) and optional **AI credits**
  (`07`).

## 8. Audit & compliance

- Every call → `ai_requests` (task, model, tokens, cost, grounded sources, review status); material
  actions (sent message, persisted field) → `audit_log` (`08 §5`).
- AI processing is covered by the DPA/sub-processor framework (`08 §10`, `21 §4`); AI logs are in DSAR
  scope (`08 §4`); no training on customer data without explicit terms.

## Links
- **Links to:** [05 §3/§16](./05-features-modules.md), [06 §9](./06-enrichment-engine.md), [03 §2/§6/§14](./03-database-design.md),
  [08 §4/§5/§10](./08-compliance.md), [09](./09-api-design.md), [16 §11](./16-code-organization.md),
  [20](./20-event-driven-realtime-backbone.md), [27](./27-workflow-automation-engine.md), [10](./10-roadmap.md),
  [29 §3/§14](./29-settings-administration-architecture.md), [30](./30-bulk-import-export-pipeline.md),
  [28 §3](./28-enterprise-readiness-audit.md),
  [ADR-0023](./decisions/ADR-0023-ai-provider-and-intelligence-architecture.md), [ADR-0008](./decisions/ADR-0008-lead-scoring-model.md),
  [ADR-0036](./decisions/ADR-0036-bulk-async-job-and-staging-pipeline.md)
- **Linked from:** [00 §7](./00-overview.md#7-decision-log), [05 §16](./05-features-modules.md), [16 §11](./16-code-organization.md), README

## Open questions
1. AI-credit pricing vs. flat plan inclusion (`07`) — placeholder until `07 §1`.
2. Agentic research depth/cost ceiling per run + caching of public findings.
3. ML scoring go-live criteria (label volume, lift over rules) — `ADR-0008` follow-up.
