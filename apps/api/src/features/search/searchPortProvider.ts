// searchPortProvider.ts — wire the workspace SearchPort to the Postgres search adapter (24, ADR-0035). The
// adapter lives in @leadwolf/db (searchRepository) because the dependency graph forbids search→db; this
// provider (apps/api, which may import core + db) builds a SearchPort that delegates to it and adds the one
// thing the repo can't: title canonical expansion (the core taxonomy), so a "CEO" filter still matches a
// row stored as "Chief Executive Officer". Workspace isolation is enforced in the repo via withTenantTx (RLS).
// This replaces the bounded in-memory candidate set (the 500-row cap) with a real, index-backed query path.

import { planTitleFilter } from "@leadwolf/core";
import { searchRepository } from "@leadwolf/db";
import type {
  ContactHit,
  ContactQuery,
  FacetCount,
  FacetKey,
  SearchPage,
  SearchPort,
  SuggestQuery,
  Suggestion,
} from "@leadwolf/types";

/** Expand title term-filter values through the canonical taxonomy → surface forms the repo ILIKEs, so an
 *  abbreviation ("CEO") matches the spelled-out title. Non-title clauses pass through untouched. */
function expandTitleFilters(query: ContactQuery): ContactQuery {
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

/** Build a workspace-scoped SearchPort backed by Postgres (RLS-enforced). */
export async function buildWorkspaceSearchPort(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<SearchPort> {
  return {
    async searchContacts(query: ContactQuery): Promise<SearchPage<ContactHit>> {
      const page = await searchRepository.searchContacts(scope, expandTitleFilters(query));
      return { hits: page.hits, nextCursor: page.nextCursor };
    },
    async suggest(req: SuggestQuery): Promise<Suggestion[]> {
      return searchRepository.suggest(scope, req);
    },
    async facetCounts(query: ContactQuery, fields: FacetKey[]): Promise<FacetCount[]> {
      return searchRepository.facetCounts(scope, expandTitleFilters(query), fields);
    },
    async index(): Promise<void> {
      // No-op: Postgres IS the store. (A dedicated search engine would apply CDC changes here — ADR-0035.)
    },
  };
}
