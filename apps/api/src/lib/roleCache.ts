// roleCache.ts — the optional read-through cache for a caller's workspace role (L-1.5).
//
// `requireRole` reads the role on every guarded request, and each read is a full `withTenantTx`
// (BEGIN + set_config + SELECT + COMMIT) before the handler opens its own transaction. This removes the
// steady-state cost of that without loosening when a revocation takes effect: a membership mutation DELETEs
// the key after its transaction commits (packages/core/src/auth/members.ts), so the very next request
// re-reads from the database.
//
// OFF unless ROLE_CACHE_TTL_MS > 0. With it unset this module never touches Redis and `requireRole` behaves
// exactly as before — the shipped default. Turning it on is an operator decision, because of one window:
// if Redis serves reads but the invalidating DELETE fails, a demoted user keeps the old role until the TTL
// expires. Everything below is arranged to make that window small and loud rather than silent.
//
// Fail-open is safe HERE in a way it is not for the revocation deny-list: falling back on a Redis error means
// reading the authoritative database row, i.e. today's behaviour. There is no weaker path to fall back to.

import { env } from "@leadwolf/config";
import { setRoleCacheInvalidator, workspaceRepository } from "@leadwolf/db";
import type { WorkspaceRole } from "@leadwolf/types";
import Redis from "ioredis";

/** Enabled only by a positive TTL — see the header. */
export const roleCacheEnabled = (): boolean => env.ROLE_CACHE_TTL_MS > 0;

// Lazy so importing this module opens no socket: it is reachable from the API's module graph, and a build or
// a test run must not try to reach Redis.
let _redis: Redis | undefined;
// biome-ignore lint/suspicious/noAssignInExpressions: intentional lazy-singleton memoization (defer the socket).
const redis = (): Redis => (_redis ??= new Redis(env.REDIS_URL));

/** Key is scoped to all three ids: the same user holds different roles in different workspaces. */
export function roleKey(tenantId: string, workspaceId: string, userId: string): string {
  return `role:${tenantId}:${workspaceId}:${userId}`;
}

/**
 * The caller's role, from cache when present, else the database (and cached).
 *
 * A `null` role — not a member — is deliberately NOT cached. Caching absence would mean a freshly invited or
 * re-activated member kept getting 403s until the TTL expired, and the failure mode of re-reading is one
 * query rather than a locked-out user.
 */
export async function getRoleCached(
  tenantId: string,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  if (!roleCacheEnabled()) {
    return workspaceRepository.getRoleForUser(tenantId, workspaceId, userId);
  }
  const key = roleKey(tenantId, workspaceId, userId);
  try {
    const hit = await redis().get(key);
    if (hit) return hit as WorkspaceRole;
  } catch (e) {
    // Read failure ⇒ fall through to the database. Not fatal, but worth seeing: a persistent one means the
    // cache is doing nothing and every request is paying the full lookup.
    console.warn("[role-cache] read failed, falling back to the database", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const role = await workspaceRepository.getRoleForUser(tenantId, workspaceId, userId);
  if (role) {
    try {
      await redis().set(key, role, "PX", env.ROLE_CACHE_TTL_MS);
    } catch {
      // A write failure only costs the next request another lookup; the read above already logged the
      // connection problem if there is one.
    }
  }
  return role;
}

/** Register the invalidator so a membership mutation in packages/core clears this process's cache. */
export function installRoleCacheInvalidator(): void {
  if (!roleCacheEnabled()) {
    setRoleCacheInvalidator(null);
    return;
  }
  setRoleCacheInvalidator(async (tenantId, workspaceId, userId) => {
    try {
      await redis().del(roleKey(tenantId, workspaceId, userId));
    } catch (e) {
      // LOUD on purpose: this is the one failure that leaves a stale role authorizing until the TTL. It is
      // rethrown for the caller's log as well, and swallowed there — the membership row is already correct.
      console.error(
        "[role-cache] INVALIDATION FAILED — a stale role may authorize until the TTL expires",
        {
          tenantId,
          workspaceId,
          userId,
          ttlMs: env.ROLE_CACHE_TTL_MS,
          error: e instanceof Error ? e.message : String(e),
        },
      );
      throw e;
    }
  });
}
