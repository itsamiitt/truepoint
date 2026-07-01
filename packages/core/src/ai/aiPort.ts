// aiPort.ts — the provider-agnostic AI contract for NL→structured search (23 §2, ADR-0023). core OWNS this
// port; the Anthropic adapter in packages/integrations IMPLEMENTS it (16 §5 direction: integrations → core,
// core NEVER imports integrations). The engine never knows which model answered — only the contract.
//
// The single security invariant of this port: `parseSearchQuery` returns ONLY a VALIDATED `contactQuery`
// (or fails). The adapter is responsible for getting structured output from the model and validating it
// against the `contactQuery` schema before returning — never raw SQL, never free-form text, never direct DB
// access (ADR-0023). core's compileSearchQuery (compileSearchQuery.ts) wraps a port with the prompt-injection
// guard + the per-tenant budget guard so those run regardless of which adapter is injected.

import type { AiParsedQuery } from "@leadwolf/types";

/** Schema context handed to the model so it emits the right shape (the allowed facets, ops, enums). */
export interface SearchSchemaContext {
  /** Facet keys the model may use in term filters (24 §3.1). */
  facetKeys: readonly string[];
  /** Sort modes the model may choose. */
  sorts: readonly string[];
  /** A compact, model-readable description of the target `contactQuery` shape + a worked example. */
  instructions: string;
}

/** Model token usage for one compile (M14 metering). Summed across the initial + any repair call. */
export interface AiCallUsage {
  inputTokens: number;
  outputTokens: number;
}

/** The outcome of asking the model to parse one NL query into a structured filter. */
export interface ParseSearchResult {
  /** The VALIDATED filter — guaranteed to satisfy the `contactQuery` schema. */
  query: AiParsedQuery;
  /** Optional short, human-readable summary of what the model understood (display-only; never executed). */
  notes?: string;
  /** True when the first model output failed validation and a single repair pass produced this result. */
  usedRepair: boolean;
  /** Token usage for metering (M14) — optional; adapters that can't report it omit it (logged as null). */
  usage?: AiCallUsage;
}

/**
 * Raised by an adapter when it cannot produce a valid `contactQuery` (model unreachable, no API key, or the
 * output stayed invalid after the repair pass). core/app maps this to a 502/503 — it is never a raw model
 * error and never leaks model internals or the prompt.
 */
export class AiParseError extends Error {
  readonly reason: "ai_unavailable" | "ai_invalid_output";
  constructor(reason: "ai_unavailable" | "ai_invalid_output", message: string) {
    super(message);
    this.name = "AiParseError";
    this.reason = reason;
  }
}

/**
 * The AI seam (ADR-0023). Callers inject an adapter; they never embed provider calls. `parseSearchQuery`
 * takes UNTRUSTED natural-language text + the schema context and returns a validated structured filter.
 * Adapters MUST validate the model output against `contactQuery` and reject/repair anything else.
 */
export interface AiPort {
  parseSearchQuery(nl: string, schema: SearchSchemaContext): Promise<ParseSearchResult>;
}
