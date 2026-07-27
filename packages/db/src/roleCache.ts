// roleCache.ts — the seam through which a membership mutation tells the workspace-role cache to forget an
// entry (L-1.5).
//
// The INTERFACE lives here because this package owns the mutations, but the IMPLEMENTATION does not: caching
// needs Redis and `@leadwolf/db` deliberately depends on nothing but config, types, drizzle and postgres.
// `apps/api` registers the real invalidator at boot — the same shape forge-worker uses for its budget store,
// and for the same reason: a process that does not cache should not be made to carry a Redis client.
//
// The default is a no-op, so a caller that never registers anything behaves exactly as it does today.

/** Forget the cached role for one membership. Called AFTER the mutating transaction commits. */
export type RoleCacheInvalidator = (
  tenantId: string,
  workspaceId: string,
  userId: string,
) => Promise<void>;

let invalidator: RoleCacheInvalidator | null = null;

/** Register the process's role-cache invalidator. Called once at boot by whichever app caches roles. */
export function setRoleCacheInvalidator(fn: RoleCacheInvalidator | null): void {
  invalidator = fn;
}

/**
 * Forget a cached role, if this process caches at all.
 *
 * Never throws. A membership change must not fail because a cache could not be reached — the mutation is
 * already committed by this point, and the authoritative row is correct. The registered implementation is
 * responsible for making a failure LOUD, because a silently missed invalidation is the one case where a
 * demoted user keeps their old role until the TTL expires.
 */
export async function invalidateCachedRole(
  tenantId: string,
  workspaceId: string,
  userId: string,
): Promise<void> {
  if (!invalidator) return;
  try {
    await invalidator(tenantId, workspaceId, userId);
  } catch {
    // Swallowed deliberately — see above. The implementation logs.
  }
}
