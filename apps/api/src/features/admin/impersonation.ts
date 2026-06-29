// impersonation.ts — staff impersonation-with-consent endpoints (ADR-0011, 13 §11). Mounted under
// /api/v1/admin/impersonation, so the parent router already applied authn + platformAdmin (the `pa` gate).
// Impersonation is a support/escalation action, so it requires the super_admin OR support staff role.
// Every start/end goes through withPlatformTx (cross-tenant owner visibility + a platform_audit_log row),
// the session is TIME-BOXED (expires_at, default 30 min in the repo), and a consent/justification `reason`
// (min 5 chars) is mandatory and recorded. The session record holds NO secret/token material.
//
// WIRE-deferred: this surface creates the session record + returns the banner info; it does NOT mint a
// "login-as" token. The scoped, time-boxed impersonation access token is a separate, deferred step.

import { impersonationRepository, withPlatformTx } from "@leadwolf/db";
import {
  type ImpersonationSessionView,
  NotFoundError,
  ValidationError,
  impersonationStartSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

export const impersonationRoutes = new Hono<{ Variables: ApiVariables }>();

// Impersonation: impersonate:start = super_admin + support (13a F3). billing_ops / compliance / read_only
// cannot enter a tenant's context. Above the coarse `pa` gate.
impersonationRoutes.use("*", requireCapability("impersonate:start"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

/** Map a repo row to the wire view (no token material, ISO dates). */
function toView(r: {
  id: string;
  staffUserId: string;
  targetTenantId: string;
  targetUserId: string | null;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
}): ImpersonationSessionView {
  return {
    id: r.id,
    staffUserId: r.staffUserId,
    targetTenantId: r.targetTenantId,
    targetUserId: r.targetUserId,
    reason: r.reason,
    startedAt: r.startedAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
  };
}

/** Start a time-boxed impersonation session. Body = impersonationStartSchema (a tenant + a consent reason;
 *  optional workspace/user scope). Audited "admin.impersonate.start". Returns the session view (the banner). */
impersonationRoutes.post("/", async (c) => {
  const parsed = impersonationStartSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const input = parsed.data;
  const actor = actorOf(c);
  const session = await withPlatformTx(
    actor,
    "admin.impersonate.start",
    (tx) =>
      impersonationRepository.start(tx, {
        staffUserId: actor.userId,
        targetTenantId: input.targetTenantId,
        targetWorkspaceId: input.targetWorkspaceId ?? null,
        targetUserId: input.targetUserId ?? null,
        reason: input.reason,
        ip: actor.ip,
      }),
    {
      targetType: "tenant",
      targetId: input.targetTenantId,
      tenantId: input.targetTenantId,
      workspaceId: input.targetWorkspaceId,
      metadata: { targetUserId: input.targetUserId ?? null, reason: input.reason },
    },
  );
  // WIRE: mint a scoped, time-boxed impersonation access token (audience = target tenant/workspace/user,
  // exp = session.expiresAt, carrying the impersonation session id) and return it here. Until that lands,
  // the console only renders the consent banner from this session record — no actual "login-as" occurs.
  return c.json({ session: toView(session) });
});

/** End an impersonation session early. Audited "admin.impersonate.end". 404 on an unknown id. The target
 *  tenant is resolved FIRST (un-audited owner read) so the audit row carries tenant_id — symmetrically with
 *  "admin.impersonate.start" — and the end therefore surfaces in the customer's staff-access log. A bogus id
 *  resolves to null → 404 BEFORE the audited tx, so no ".end" trace is written for a session that never
 *  existed. */
impersonationRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const targetTenantId = await impersonationRepository.getTargetTenant(id);
  if (!targetTenantId) throw new NotFoundError("Impersonation session not found.");
  await withPlatformTx(
    actorOf(c),
    "admin.impersonate.end",
    async (tx) => {
      const touched = await impersonationRepository.end(tx, id);
      // Re-check inside the tx (a concurrent delete between the lookup and here): a no-op end rolls back the
      // audit row so there is no ".end" trace for a session that was already gone.
      if (touched === 0) throw new NotFoundError("Impersonation session not found.");
    },
    { targetType: "impersonation_session", targetId: id, tenantId: targetTenantId },
  );
  return c.json({ ok: true, id });
});

/** List currently-active impersonation sessions (not ended, not expired) — the banner's source of truth. */
impersonationRoutes.get("/active", async (c) => {
  const sessions = await withPlatformTx(actorOf(c), "admin.list_impersonations", async (tx) => {
    const rows = await impersonationRepository.listActive(tx);
    return rows.map(toView);
  });
  return c.json({ sessions });
});
