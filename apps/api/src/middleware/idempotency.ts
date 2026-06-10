// idempotency.ts — replay the stored first response for a seen (tenant, Idempotency-Key) on money
// endpoints (07 §3, 09 §5). Convenience layer only: the DB uniques (reveal claim, stripe_event_id) remain
// the real double-charge guards, so a racing duplicate that slips past the store is still harmless.

import { idempotencyRepository } from "@leadwolf/db";
import type { Context, Next } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { TenancyVariables } from "./tenancy.ts";

export async function idempotency(
  c: Context<{ Variables: TenancyVariables }>,
  next: Next,
): Promise<Response | undefined> {
  const key = c.req.header("idempotency-key");
  if (!key) {
    await next();
    return undefined;
  }

  const scope = { tenantId: c.get("tenantId"), workspaceId: c.get("workspaceId") };
  const stored = await idempotencyRepository.find(scope, key);
  if (stored) {
    c.header("idempotency-replayed", "true");
    return c.json(
      stored.responseBody as Record<string, unknown>,
      stored.responseStatus as StatusCode,
    );
  }

  await next();

  // Persist only successful JSON responses; failures re-execute on retry (DB constraints keep that safe).
  const res = c.res;
  if (res && res.status < 400) {
    try {
      const body = (await res.clone().json()) as unknown;
      await idempotencyRepository.store(scope, key, {
        responseStatus: res.status,
        responseBody: body,
      });
    } catch {
      // Non-JSON or unreadable body — skip storing; the endpoint stays idempotent via its DB constraints.
    }
  }
}
