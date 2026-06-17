// expandQuery.ts — expand a typed title term into the set of surface forms the search engine should match
// (24 §4, ADR-0035). This is the app-side equivalent of an Elasticsearch query-time `synonym_graph`: it
// turns "CEO" into { canonicalId: "chief_executive_officer", synonyms: ["ceo", "chief executive officer",
// ...] } so the query matches every record whose stored title resolved to that canonical, regardless of how
// it was originally written. When the term isn't in the taxonomy, it passes through normalized (no synonyms).

import type { ExpandedTerm } from "@leadwolf/types";
import { findCanonicalTitle } from "./canonicalizeTitle.ts";
import { normalizeTitle } from "./normalizeTitle.ts";

/** Expand a typed title term through the canonical taxonomy into matchable synonyms (24 §4.3). */
export function expandTitleTerm(input: string): ExpandedTerm {
  const normalized = normalizeTitle(input);
  const hit = findCanonicalTitle(input);

  if (!hit) {
    return {
      input,
      normalized,
      canonicalId: null,
      canonicalLabel: null,
      synonyms: normalized ? [normalized] : [],
    };
  }

  const synonyms = uniq(
    [hit.label, ...hit.aliases].map(normalizeTitle).filter((s): s is string => s.length > 0),
  );

  return { input, normalized, canonicalId: hit.id, canonicalLabel: hit.label, synonyms };
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}
