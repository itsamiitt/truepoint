// readThrough.ts — the typed read-through cache tier (18-scalability-performance §5). Redis serves only
// BullMQ and rate-limiting today; this is the first read cache in the system.
//
// The design is shaped by one rule above all others: a cache key without a tenant in it is a cross-tenant
// data leak. Not a performance bug — a disclosure. So the tenant is not a convention here, it is a TYPE: the
// only way to build a normal key is `tenantKey(scope, …)`, which cannot be called without a tenantId. Data
// that genuinely has no tenant (the public pricing catalog) must go through `systemKey`, which is named to be
// noticed in review rather than reached for by habit.
//
// Two things are deliberately NOT cacheable through this tier, per §5: money and permission decisions. A
// stale credit balance spends money that isn't there, and a stale role authorizes someone who was just
// revoked. Both must read through to the source every time. This module cannot enforce that — it is a
// convention the caller keeps — so it is stated at every layer that touches it.

/** The Redis-shaped operations this tier needs. A port, so core does not depend on ioredis and the logic is
 *  testable without a live Redis (adapter: `redisCacheStore` in @leadwolf/integrations). */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: string[]): Promise<void>;
}

export interface CacheScope {
  tenantId: string;
  workspaceId?: string;
}

/** Reject anything that could break the `:`-delimited key structure or smuggle a wildcard into an
 *  invalidation. Ids are uuids and part names are literals, so this only ever fires on a programming error —
 *  but a key built from unvalidated input is how one tenant's prefix becomes another's. */
const SAFE_PART = /^[A-Za-z0-9._-]+$/;

function assertSafe(part: string): string {
  if (!SAFE_PART.test(part)) {
    throw new Error(`cache: unsafe key part ${JSON.stringify(part)}`);
  }
  return part;
}

/**
 * A TENANT-SCOPED cache key: `t:{tid}:ws:{wid}:part:part…` (the `ws:` segment is omitted for tenant-wide
 * data). Every normal cache entry goes through here, and it cannot be built without a tenant — which is the
 * point.
 */
export function tenantKey(scope: CacheScope, ...parts: string[]): string {
  const head = scope.workspaceId
    ? `t:${assertSafe(scope.tenantId)}:ws:${assertSafe(scope.workspaceId)}`
    : `t:${assertSafe(scope.tenantId)}`;
  return [head, ...parts.map(assertSafe)].join(":");
}

/**
 * A key for SYSTEM-OWNED, NON-TENANT data — today only the public pricing catalog, which is identical for
 * every caller and for anonymous ones. Named this way so that using it is a visible decision: anything with a
 * tenant dimension belongs in `tenantKey`, and putting tenant data behind this prefix would serve one
 * tenant's rows to another.
 */
export function systemKey(...parts: string[]): string {
  return ["sys", ...parts.map(assertSafe)].join(":");
}

/**
 * The per-workspace SEARCH-READ cache generation counter (launch-scale Phase 7 S5). A RAW redis key —
 * writers INCR it directly and readers GET it outside the CacheStore wrapper, so it is spelled with the
 * store's "cache:" prefix to live beside the value keys it governs. The current generation is folded into
 * facet/count keys as a `v{N}` part, which makes one INCR an O(1) invalidation of every generation-N entry
 * for that workspace (no SCAN, no wildcard deletes); orphaned generations age out on their ≤TTL. Emitters:
 * bulk contact mutations, reveals, import promotion, re-verification, forge sync-out — anything that
 * changes which rows a search sees or how facets count them.
 */
export function searchVersionKey(scope: CacheScope & { workspaceId: string }): string {
  return `cache:ver:${tenantKey(scope, "search")}`;
}

export interface ReadThroughCache {
  /** Serve `key` from cache, else run `load`, store it, and return it. */
  getOrSet<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
  /** Drop specific keys — the narrowest ones a mutation actually affects. */
  invalidate(...keys: string[]): Promise<void>;
}

/** Spread expiries so a burst of entries created together does not expire together and stampede the database
 *  in one tick. Up to +20% on top of the requested TTL — only ever longer, so a caller's freshness bound is
 *  never silently shortened. */
function jitter(ttlSeconds: number): number {
  return Math.max(1, Math.round(ttlSeconds * (1 + Math.random() * 0.2)));
}

export function createReadThroughCache(store: CacheStore): ReadThroughCache {
  // Single-flight: concurrent callers for the same key share ONE load. Without it, a cold or just-expired hot
  // key lets every in-flight request run the same expensive query at once — the cache makes the stampede
  // worse than no cache, because they all miss simultaneously.
  const inflight = new Map<string, Promise<unknown>>();

  // The stale-write-back guard. A reader that misses, then loads, can have a MUTATION land in between — and
  // when its loader finishes it would write the pre-mutation value into the cache AFTER the invalidation,
  // silently undoing the write for a full TTL. Marking the in-flight record is not sufficient, because the
  // race also covers the window before the load is even registered (a reader is still awaiting its cache
  // lookup when the mutation arrives).
  //
  // So each key gets an epoch, captured SYNCHRONOUSLY when a reader enters — before any await — and compared
  // just before the write. Any invalidation in between bumps the epoch and the write is dropped.
  //
  // Both maps are bounded by the number of keys with readers in flight: `readers` is reference-counted, and
  // when the last reader for a key leaves, its epoch is dropped with it. An invalidation for a key nobody is
  // reading needs no epoch at all — there is no write to guard against.
  const epochs = new Map<string, number>();
  const readers = new Map<string, number>();

  return {
    async getOrSet<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
      // Synchronous, before the first await — this is what makes the guard cover the lookup window too.
      const startEpoch = epochs.get(key) ?? 0;
      readers.set(key, (readers.get(key) ?? 0) + 1);
      try {
        // FAIL OPEN on a cache read: an unreachable Redis must degrade to the uncached path, never fail the
        // request. A cache outage is not a data outage.
        try {
          const hit = await store.get(key);
          if (hit !== null) return JSON.parse(hit) as T;
        } catch {
          // fall through to load
        }

        const existing = inflight.get(key);
        if (existing) return (await existing) as T;

        const run = (async () => {
          const value = await load();
          // Only a SUCCESSFUL load is stored — a rejected loader throws out of this promise and nothing is
          // written, so a transient failure cannot be cached and served for the whole TTL. And only if no
          // invalidation landed since this reader entered.
          if ((epochs.get(key) ?? 0) === startEpoch) {
            try {
              await store.set(key, JSON.stringify(value), jitter(ttlSeconds));
            } catch {
              // a write failure is not a request failure
            }
          }
          return value;
        })();

        inflight.set(key, run);
        try {
          return (await run) as T;
        } finally {
          if (inflight.get(key) === run) inflight.delete(key);
        }
      } finally {
        const left = (readers.get(key) ?? 1) - 1;
        if (left <= 0) {
          readers.delete(key);
          epochs.delete(key);
        } else {
          readers.set(key, left);
        }
      }
    },

    async invalidate(...keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      for (const k of keys) {
        // Unlink any in-flight load so new callers do not join a result read before this mutation...
        inflight.delete(k);
        // ...and bump the epoch so that load cannot write its result back. Only tracked while someone is
        // actually reading — otherwise there is nothing to guard and no entry to keep.
        if (readers.has(k)) epochs.set(k, (epochs.get(k) ?? 0) + 1);
      }
      try {
        await store.del(keys);
      } catch {
        // An invalidation that cannot reach Redis leaves a stale entry for at most its TTL. That is why this
        // tier is short-TTL-plus-explicit-invalidation rather than long-TTL-and-hope, and why money and
        // permission decisions are not served from it at all.
      }
    },
  };
}
