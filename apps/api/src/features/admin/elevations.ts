// elevations.ts — JIT elevation request/list endpoints (13a F1, ADR-0011 / 13 §2). Mounted under
// /api/v1/admin/elevations, so the parent router already applied authn + platformAdmin. Requesting an
// elevation is gated to the roles that can perform a gated action (super_admin|billing_ops); the gated ACTION
// re-checks the precise role AND consumes the elevation in its own tx, so this endpoint is a secondary gate,
// never the authority. Every grant writes an "elevation.grant" platform_audit_log row via withPlatformTx. v1
// is self-service (no peer approval — the record's approved_by column is the seam for that, 13a open Q #2).

import { JIT_ELEVATION_TTL_SECONDS, jitElevationRepository, withPlatformTx } from "@leadwolf/db";
import { type ElevationView, ValidationError, requestElevationSchema } from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireStaffRole } from "../../middleware/requireStaffRole.ts";

export const elevationRoutes = new Hono<{ Variables: ApiVariables }>();

// Only roles that can perform a JIT-gated action may mint an elevation (super_admin: suspend + credit;
// billing_ops: credit). The action endpoint still enforces the precise per-action role.
elevationRoutes.use("*", requireStaffRole("super_admin", "billing_ops"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

/** Map a repo row to the wire view (no token material; ISO dates). */
function toView(r: {
  id: string;
  action: string;
  reason: string;
  targetTenantId: string | null;
  status: string;
  grantedAt: Date;
  expiresAt: Date;
}): ElevationView {
  return {
    id: r.id,
    action: r.action as ElevationView["action"],
    reason: r.reason,
    targetTenantId: r.targetTenantId,
    status: r.status,
    grantedAt: r.grantedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  };
}

/** Mint a time-boxed, tenant-scoped elevation for a sensitive action. Body = requestElevationSchema.
 *  Audited "elevation.grant". The action it gates consumes it in a separate, audited request. */
elevationRoutes.post("/", async (c) => {
  const parsed = requestElevationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { action, reason, targetTenantId } = parsed.data;
  const actor = actorOf(c);
  const elevation = await withPlatformTx(
    actor,
    "elevation.grant",
    (tx) =>
      jitElevationRepository.grant(tx, {
        staffUserId: actor.userId,
        action,
        reason,
        targetTenantId,
        ttlSeconds: JIT_ELEVATION_TTL_SECONDS,
        ip: actor.ip,
      }),
    {
      targetType: "tenant",
      targetId: targetTenantId,
      tenantId: targetTenantId,
      metadata: { action, reason },
    },
  );
  return c.json({ elevation: toView(elevation) });
});

/** The caller's currently-live elevations — lets the console reflect step-up state. */
elevationRoutes.get("/active", async (c) => {
  const actor = actorOf(c);
  const elevations = await withPlatformTx(actor, "admin.list_elevations", async (tx) => {
    const rows = await jitElevationRepository.listActive(tx, actor.userId);
    return rows.map(toView);
  });
  return c.json({ elevations });
});
