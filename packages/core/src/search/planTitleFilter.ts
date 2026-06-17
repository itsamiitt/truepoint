// planTitleFilter.ts — turn the title values a user selected/typed into an engine-agnostic match plan
// (24 §4, ADR-0035). Each value is expanded through the taxonomy; the plan an adapter consumes is:
// "match canonical_title_id IN canonicalIds, OR title text matches any of synonyms". This keeps the
// synonym/abbreviation logic in core (business logic) and out of the engine adapters (packages/search).

import type { ExpandedTerm } from "@leadwolf/types";
import { expandTitleTerm } from "./expandQuery.ts";

/** The engine-agnostic plan for a title facet filter. */
export interface TitleFilterPlan {
  /** Canonical occupation ids the filter resolved to (exact match on the indexed canonical id). */
  canonicalIds: string[];
  /** Normalized surface forms to match as text for inputs with no canonical (or to widen recall). */
  synonyms: string[];
  /** Per-input expansion detail (for debugging / UI echo). */
  terms: ExpandedTerm[];
}

/** Expand a set of title filter values into a deduplicated, engine-agnostic match plan. */
export function planTitleFilter(values: string[]): TitleFilterPlan {
  const terms = values.map(expandTitleTerm);
  const canonicalIds = new Set<string>();
  const synonyms = new Set<string>();

  for (const term of terms) {
    if (term.canonicalId) {
      canonicalIds.add(term.canonicalId);
      for (const syn of term.synonyms) synonyms.add(syn);
    } else if (term.normalized) {
      synonyms.add(term.normalized);
    }
  }

  return { canonicalIds: [...canonicalIds], synonyms: [...synonyms], terms };
}
