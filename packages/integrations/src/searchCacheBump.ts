// searchCacheBump.ts — the write side of the S5 generation-keyed search cache, shared by every process
// that lands rows in `contacts` (apps/api mutations, apps/workers job completions). One INCR of the
// workspace's `cache:ver:…:search` counter retires every cached facet/count aggregate for that workspace
// in O(1) — readers fold the generation into their keys (apps/api searchReadCache).
//
// FAIL-OPEN, deliberately: a bump that cannot reach Redis is swallowed — the entries it would have retired
// expire on their ≤60s TTL backstop (exactly the §4 consistency-table bound), and a cache blip must never
// fail a mutation or a job that already committed.

import { searchVersionKey } from "@leadwolf/core";

export interface SearchBumpRedis {
  incr(key: string): Promise<number>;
}

export async function bumpSearchVersion(
  redis: SearchBumpRedis,
  scope: { tenantId: string; workspaceId: string },
): Promise<void> {
  try {
    await redis.incr(searchVersionKey(scope));
  } catch {
    // swallowed: TTL backstop covers it (see header)
  }
}

/** Best-effort scope extraction from a queue job's data — the two shapes the search-mutating queues use:
 *  a nested `{ scope: { tenantId, workspaceId } }` (imports v2, bulk-reveal) or flat ids (reverification).
 *  Returns undefined when the job carries no workspace identity (then there is nothing to bump). */
export function scopeFromJobData(
  data: unknown,
): { tenantId: string; workspaceId: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const d = data as Record<string, unknown>;
  const nested = d.scope as Record<string, unknown> | undefined;
  const tenantId = (nested?.tenantId ?? d.tenantId) as string | undefined;
  const workspaceId = (nested?.workspaceId ?? d.workspaceId) as string | undefined;
  return tenantId && workspaceId ? { tenantId, workspaceId } : undefined;
}
