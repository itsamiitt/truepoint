// searchReadCache.ts — the S5 read-through wrappers for the three scan-class search reads (launch-scale
// arch doc §2; consistency table §4 operator-confirmed): facet counts (eventual ≤60s), the capped count
// (eventual ≤30s), suggest (TTL-only ≤120s). These are the ONLY search reads served from cache — page reads
// stay uncached (29ms-class measured; correctness cost outweighs), and money/permission never enter this
// tier (readThrough contract).
//
// Invalidation is generation-keyed, not key-enumerated: every facet/count key folds in the workspace's
// current `v{N}` from `searchVersionKey` (INCR'd by contact mutations — see lib/searchVersion.ts), so one
// O(1) INCR retires every cached aggregate for the workspace; orphaned generations age out on their ≤TTL.
// Suggest deliberately skips the generation (its values drift slowly and surviving a bulk edit is the
// point). Everything fails OPEN: version read failure ⇒ generation "0", cache failure ⇒ loader — Redis
// down degrades to exactly the uncached behaviour Phase 2 measured, never an error.
//
// Deps are injected (createSearchReadCache) so the contract is unit-testable against in-memory fakes; the
// process singleton (searchReadCache()) binds the api's cache tier + env TTLs.

import { createHash } from "node:crypto";
import { env } from "@leadwolf/config";
import { type ReadThroughCache, searchVersionKey, tenantKey } from "@leadwolf/core";
import type { ContactQuery, FacetKey, SuggestQuery } from "@leadwolf/types";
import { cache, cacheRedis } from "../../cache.ts";

export interface SearchReadCacheDeps {
  cache: ReadThroughCache;
  /** Raw GET for the generation counter — the cache tier's own connection in production. */
  redis: { get(key: string): Promise<string | null> };
  ttls: { facets: number; count: number; suggest: number };
}

export interface SearchScope {
  tenantId: string;
  workspaceId: string;
}

/** Stable content hash for a key part. JSON.stringify is deterministic for these payloads: query/fields
 *  arrive in the client's canonical order and pass through Zod (no key reordering happens between requests
 *  from the same surface); a differently-ordered but semantically-equal query costs a duplicate cache
 *  entry, never a wrong hit. 24 hex chars ≈ 96 bits — collision-safe at this cardinality. */
function hashPart(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

export function createSearchReadCache(deps: SearchReadCacheDeps) {
  const generation = async (scope: SearchScope): Promise<string> => {
    try {
      return (await deps.redis.get(searchVersionKey(scope))) ?? "0";
    } catch {
      return "0"; // fail open — with Redis down the getOrSet below also falls through to the loader
    }
  };

  return {
    /** Facet counts for a (query, fields) pair. `channelsFromChild` is part of the identity: the S-CH4
     *  gate changes what the loader computes, so gate-on/off must never share an entry. */
    async facetCounts<T>(
      scope: SearchScope,
      query: ContactQuery,
      fields: FacetKey[],
      channelsFromChild: boolean,
      load: () => Promise<T>,
    ): Promise<T> {
      if (deps.ttls.facets <= 0) return load();
      const key = tenantKey(
        scope,
        `v${await generation(scope)}`,
        "facets",
        hashPart({ q: query, f: fields, cf: channelsFromChild }),
      );
      return deps.cache.getOrSet(key, deps.ttls.facets, load);
    },

    /** The capped select-all count for a query. */
    async count<T>(scope: SearchScope, query: ContactQuery, load: () => Promise<T>): Promise<T> {
      if (deps.ttls.count <= 0) return load();
      const key = tenantKey(scope, `v${await generation(scope)}`, "count", hashPart({ q: query }));
      return deps.cache.getOrSet(key, deps.ttls.count, load);
    },

    /** Typeahead suggestions. No generation part (TTL-only, §4) — and the prefix is USER TEXT, so it is
     *  hashed rather than embedded (tenantKey's SAFE_PART would rightly reject raw input). */
    async suggest<T>(scope: SearchScope, req: SuggestQuery, load: () => Promise<T>): Promise<T> {
      if (deps.ttls.suggest <= 0) return load();
      const key = tenantKey(
        scope,
        "suggest",
        req.field,
        hashPart({ p: req.prefix, l: req.limit, s: req.scope }),
      );
      return deps.cache.getOrSet(key, deps.ttls.suggest, load);
    },
  };
}

export type SearchReadCache = ReturnType<typeof createSearchReadCache>;

let instance: SearchReadCache | undefined;

/** The api's process singleton, bound to the shared cache tier + env TTLs (0 = that class disabled). */
export function searchReadCache(): SearchReadCache {
  if (!instance) {
    instance = createSearchReadCache({
      cache: cache(),
      redis: cacheRedis(),
      ttls: {
        facets: env.SEARCH_FACETS_CACHE_TTL_S,
        count: env.SEARCH_COUNT_CACHE_TTL_S,
        suggest: env.SEARCH_SUGGEST_CACHE_TTL_S,
      },
    });
  }
  return instance;
}
