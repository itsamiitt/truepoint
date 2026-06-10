# ADR-0023 — AI provider & assistive/agentic intelligence architecture

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context doc:** [23-ai-intelligence-layer.md](../23-ai-intelligence-layer.md), [05-features-modules.md](../05-features-modules.md)
- **Resolves:** `00 §8` open question 8 (AI provider).

## Context

Modern sales-intelligence buyers expect AI as **table-stakes**, not a post-MVP novelty: natural-language
search, a conversational copilot over their data, generative outreach drafting, account/contact
summarization, and agentic research. Today this is a stub (`05 §16`) with no provider, no guardrails, no
evaluation, and no grounding design, and `16 §11` only mandates *isolation* of LLM code. We must choose a
provider and an architecture that is fast, safe, compliant (the product is a regulated data broker,
`08 §15`), and honest ("augmented-human, not autonomous", `15` opp L1).

## Decision

Adopt **Anthropic Claude** as the LLM provider, behind a single **`AiPort`** abstraction
([16 §11](../16-code-organization.md)), with an assistive-first, agentic-with-guardrails architecture.

- **Models:** the Claude family — **Opus 4.8** (hard reasoning / agentic research), **Sonnet 4.6**
  (default for drafting/summarize/NL-search), **Haiku 4.5** (cheap/low-latency classification, extraction,
  embeddings-adjacent tasks). A **model router** picks per `ai_task_type`
  (`nl_search|copilot_chat|draft_message|summarize|research_agent|extract_fields|embed`) by
  cost/latency/quality; provider stays swappable behind `AiPort`.
- **Grounding / RAG:** AI is grounded in (a) the workspace's **revealed/owned** overlay data and (b) the
  **masked** master graph — never unrevealed PII. Semantic retrieval uses **pgvector** `embeddings`
  (`03`); NL-search compiles to a **validated structured query** (never raw SQL), run under the caller's
  RLS + team visibility.
- **Human-in-the-loop (`H19`):** any AI output that becomes an outbound action (a sent message) or a
  stored field/signal is **reviewed before** it takes effect. Drafts are suggestions; agent findings are
  verified before they become fields/signals. Suppression (`H5`) and reveal gating still apply.
- **Safety & eval:** a content-safety filter on generation, jailbreak/prompt-injection mitigations on
  agentic browsing, and an **eval/safety harness** (`ai_evals`) gating prompt/model changes in CI.
- **Cost, caching, metering:** **prompt caching** + the `ai_cache` table for idempotent results; per-tenant
  **AI usage metering** (tokens → optional credits, `07`); per-workspace/tenant rate limits and budgets.
- **Auditability:** every AI call is recorded in `ai_requests` (task, model, tokens, cost, grounded
  sources, review status) and material actions hit the `audit_log` (`08 §5`).

## Rationale

Claude leads on reasoning, long-context grounding, tool-use/agentic reliability, and safety — the exact
axes that matter for compliant, grounded GTM intelligence — and was already the recommended provider
(`00 §8 Q8`). A single `AiPort` + model router keeps the monolith clean (`16 §11`), controls cost, and
preserves swappability. Assistive-first with mandatory review matches the honest-AI positioning and the
regulated-data-broker compliance posture.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Anthropic Claude behind `AiPort` (this ADR)** | Chosen | Best reasoning/grounding/safety for compliant GTM AI; already recommended; swappable. |
| Single fixed model, no router | Rejected | Either too costly (always-Opus) or too weak (always-Haiku); no per-task fit. |
| Fully-autonomous agents (no human review) | Rejected | Violates honest-AI positioning + compliance (suppression/PII/hallucination risk). |
| Defer AI to "Beyond" | Rejected | AI is market table-stakes; deferring is a GTM risk (`15`). |

## Consequences

- **Positive:** a coherent, safe, swappable AI layer; grounded results; metered cost; auditable;
  differentiating copilot + research agent (`15`).
- **Negative:** LLM cost + latency to manage; eval/guardrail maintenance; prompt-injection surface on
  agentic browsing.
- **Mitigation:** model router + prompt caching + Haiku for cheap paths; eval harness in CI; isolated
  browsing with output verification; per-tenant budgets.

## Revisit if

A materially better/cheaper provider emerges, or a regulated segment forbids third-party LLM processing
(then a self-hosted/open model behind the same `AiPort`).
