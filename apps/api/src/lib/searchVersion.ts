// searchVersion.ts — the write side of the S5 generation-keyed search cache (arch doc §3). One INCR of the
// workspace's `cache:ver:…:search` counter retires every cached facet/count aggregate for that workspace in
// O(1) (the readers fold the generation into their keys — see features/search/searchReadCache.ts). Emitters
// are the mutations that change which rows a search sees or how facets count them.
//
// FAIL-OPEN, deliberately: a bump that cannot reach Redis is swallowed — the entries it would have retired
// expire on their ≤60s TTL backstop (that bound is exactly what the §4 consistency table promises), and a
// cache blip must never fail a mutation that already committed.

import { bumpSearchVersion as bump } from "@leadwolf/integrations";
import type { MiddlewareHandler } from "hono";
import { cacheRedis } from "../cache.ts";

/** The api-process binding of the shared fail-open bump (@leadwolf/integrations owns the semantics; the
 *  workers bind the same helper to their BullMQ connection in register.ts). */
export async function bumpSearchVersion(scope: {
  tenantId: string;
  workspaceId: string;
}): Promise<void> {
  await bump(cacheRedis(), scope);
}

/**
 * Router middleware: after a SUCCESSFUL mutating request whose path ends with one of `paths`, bump the
 * workspace's search generation. One registration covers a router's mutation surface without threading a
 * call through every handler; read-only routes on the same router (estimate/export) are simply not listed.
 */
export function bumpSearchVersionAfter(paths: ReadonlySet<string>): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.req.method === "GET" || c.res.status >= 400) return;
    const path = c.req.path;
    let matched = false;
    for (const p of paths) {
      if (path.endsWith(p)) {
        matched = true;
        break;
      }
    }
    if (!matched) return;
    const tenantId = c.get("tenantId") as string | undefined;
    const workspaceId = c.get("workspaceId") as string | undefined;
    if (tenantId && workspaceId) await bumpSearchVersion({ tenantId, workspaceId });
  };
}
