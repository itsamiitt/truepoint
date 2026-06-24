// expandTitleFilters.ts — expand title term-filter values through the canonical taxonomy so a stored/typed
// title clause matches the SAME contacts the user saw in the results grid (e.g. "CEO" also matches "Chief
// Executive Officer"). This is the search-time synonym expansion the apps/api SearchPort provider applies at
// the edge; the same expansion must run anywhere a ContactQuery is re-executed server-side WITHOUT going
// through that provider — bulk select-all-across-search (bulkActions) and Phase-4 dynamic-list resolution
// (prospect/lists) — so all three resolve an identical match set. Non-title clauses pass through untouched.

import type { ContactQuery } from "@leadwolf/types";
import { planTitleFilter } from "./planTitleFilter.ts";

/** Return a query whose `title` term clauses are augmented with their canonical synonyms (idempotent — values
 *  are de-duped). The input is never mutated; if no title clause expands, the original object is returned. */
export function expandTitleFilters(query: ContactQuery): ContactQuery {
  let changed = false;
  const filters = query.filters.map((clause) => {
    if (clause.kind !== "term" || clause.field !== "title") return clause;
    const synonyms = planTitleFilter(clause.values).synonyms;
    if (synonyms.length === 0) return clause;
    changed = true;
    return { ...clause, values: Array.from(new Set([...clause.values, ...synonyms])) };
  });
  return changed ? { ...query, filters } : query;
}
