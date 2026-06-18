// aiSearch.ts — Zod schemas + inferred types for the NL→structured-search slice (23 §3, ADR-0023, M14).
// The AI layer compiles a natural-language query into a VALIDATED structured filter and NOTHING else — it
// never produces raw SQL or free-form output (ADR-0023: NL-search "compiles to a validated structured
// query, never raw SQL"). The validated filter reuses the EXISTING `contactQuery` schema (search.ts,
// ADR-0035) verbatim, so the parsed result is run by the same engine + RLS as a hand-built filter, and is
// shown to the user to CONFIRM before it is applied (human-in-the-loop, 23 §1 `H19`). Validation lives
// here; the port + adapter logic live in @leadwolf/core/ai + @leadwolf/integrations/anthropic. Leaf package.

import { z } from "zod";
import { contactQuery } from "./search.ts";

// ── Request (NL text in) ───────────────────────────────────────────────────────────────────────────────
/**
 * The natural-language search request. `text` is UNTRUSTED user input — it is treated as data, never as
 * instructions (prompt-injection guard lives in core). Bounded length keeps the per-request token/cost
 * envelope predictable (per-tenant budget guard, 23 §7); the engine's own `contactQuery.text` is capped at
 * 200, so a generous-but-bounded NL ceiling here is intentional.
 */
export const aiSearchRequest = z.object({
  text: z.string().trim().min(1, "Describe what you're looking for.").max(1000),
});
export type AiSearchRequest = z.infer<typeof aiSearchRequest>;

// ── Parsed query (the model's structured output) ───────────────────────────────────────────────────────
/**
 * What the AI is allowed to emit: ONLY a `contactQuery`. The model's structured output is parsed and then
 * validated against THIS schema; anything that doesn't conform (extra keys, raw SQL, prose, malformed
 * filters) is rejected by the adapter, which repairs/retries once and otherwise fails closed. Reusing
 * `contactQuery` (not a parallel shape) guarantees the parsed result is interchangeable with a hand-built
 * filter — same engine, same RLS, same masking (ADR-0035).
 */
export const aiParsedQuery = contactQuery;
export type AiParsedQuery = z.infer<typeof aiParsedQuery>;

// ── Response (validated filter out, for confirmation) ──────────────────────────────────────────────────
/**
 * The endpoint returns the VALIDATED filter (not results) so the UI can preview it and the user can confirm
 * before applying (23 §1/§3 human-in-the-loop). `query` is the validated `contactQuery`; `notes` is an
 * OPTIONAL short, model-supplied human summary of what it understood (display-only, never executed);
 * `usedRepair` records that the first model output failed validation and a single repair pass was used
 * (observability — surfaced nowhere security-sensitive).
 */
export const aiSearchResponse = z.object({
  query: aiParsedQuery,
  notes: z.string().max(400).optional(),
  usedRepair: z.boolean().default(false),
});
export type AiSearchResponse = z.infer<typeof aiSearchResponse>;
