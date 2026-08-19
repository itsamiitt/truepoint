// searchPortProvider.ts — wire the workspace SearchPort to the Postgres search adapter (24, ADR-0035). The
// adapter lives in @leadwolf/db (searchRepository) because the dependency graph forbids search→db; this
// provider (apps/api, which may import core + db) builds a SearchPort that delegates to it and adds the one
// thing the repo can't: title canonical expansion (the core taxonomy), so a "CEO" filter still matches a
// row stored as "Chief Executive Officer". Workspace isolation is enforced in the repo via withTenantTx (RLS).
// This replaces the bounded in-memory candidate set (the 500-row cap) with a real, index-backed query path.

import { channelReadFromChildEnabledForScope, planTitleFilter } from "@leadwolf/core";
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
import { flagGateCached } from "../../lib/gateMemo.ts";
import { searchReadCache } from "./searchReadCache.ts";

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
  // S-CH4 composed read gate, evaluated ONCE per port build (env-off ⇒ zero queries; fail-closed on error).
  // Gate-on the masked hits gain `channels` summaries + has_email/has_phone/company resolve from live child
  // rows; gate-off every read is byte-identical to the pre-S-CH4 flat-column path. Memoized 30s (perf-audit
  // P2.4): a port is built per search/suggest/facet REQUEST — the busiest surface in the product — and each
  // build paid the gate's transaction to re-read a rollout boolean. Key is a synthetic label because the
  // composed core evaluator owns the real flag key + env layering; the admin flag write clears all gates.
  const channelsFromChild = await flagGateCached(scope.tenantId, "channel_read_from_child", () =>
    channelReadFromChildEnabledForScope(scope),
  );
  return {
    async searchContacts(query: ContactQuery): Promise<SearchPage<ContactHit>> {
      const page = await searchRepository.searchContacts(scope, expandTitleFilters(query), {
        channelsFromChild,
      });
      return { hits: page.hits, nextCursor: page.nextCursor };
    },
    async suggest(req: SuggestQuery): Promise<Suggestion[]> {
      // S5: TTL-only cache (§4 consistency table) — Phase 2 measured 27s/keystroke-class scans on a 500k
      // workspace; post-S1 ~1.2s, still worth one shared entry per (field, prefix) for its 120s.
      return searchReadCache().suggest(scope, req, () => searchRepository.suggest(scope, req));
    },
    async facetCounts(query: ContactQuery, fields: FacetKey[]): Promise<FacetCount[]> {
      // S5: generation-keyed cache (§2/§3) — the most expensive read in the product (Phase 2: 139.6s
      // baseline, 8.6s post-S1 on the whale). Key includes the EXPANDED query + the S-CH4 gate, so
      // gate-on/off and differently-expanded titles never share an entry.
      const expanded = expandTitleFilters(query);
      return searchReadCache().facetCounts(scope, expanded, fields, channelsFromChild, () =>
        searchRepository.facetCounts(scope, expanded, fields),
      );
    },
    async index(): Promise<void> {
      // No-op: Postgres IS the store. (A dedicated search engine would apply CDC changes here — ADR-0035.)
    },
  };
}
