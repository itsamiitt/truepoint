// staff.ts — platform STAFF RBAC endpoints (ADR-0011, 13 §11). Mounted under /api/v1/admin/staff, so the
// parent router already applied authn + platformAdmin (the coarse `pa` gate). Granting / revoking a staff
// role hands out platform-wide, cross-tenant authority, so these additionally require the super_admin staff
// role — only a super_admin manages staff. All reads/writes go through withPlatformTx (cross-tenant owner
// visibility + a platform_audit_log row). The role lookup is resolved per-request (requireCapability), so a
// revoke takes effect on the next request — no stale-JWT window.

import { revokeAllSessionsForUser } from "@leadwolf/auth";
import { staffRepository, withPlatformTx } from "@leadwolf/db";
import { type StaffMemberView, ValidationError, grantStaffSchema } from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

export const staffRoutes = new Hono<{ Variables: ApiVariables }>();

// Managing staff grants is the most privileged platform action → staff:manage = super_admin only (13a F3
// capability gate, above the coarse `pa` gate).
staffRoutes.use("*", requireCapability("staff:manage"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

/** List the platform-staff directory (active + revoked), joined to users for email/name. */
staffRoutes.get("/", async (c) => {
  const staff = await withPlatformTx(actorOf(c), "admin.list_staff", async (tx) => {
    const rows = await staffRepository.list(tx);
    return rows.map(
      (r): StaffMemberView => ({
        userId: r.userId,
        email: r.email,
        fullName: r.fullName,
        staffRole: r.staffRole as StaffMemberView["staffRole"],
        status: r.status,
        grantedAt: r.grantedAt.toISOString(),
      }),
    );
  });
  return c.json({ staff });
});

/** Grant (or re-grant) a staff role to a user. Body = grantStaffSchema. Audited "admin.grant_staff".
 *  The granted_by actor is the authenticated super_admin (the `sub` claim), never client-supplied. */
staffRoutes.post("/", async (c) => {
  const parsed = grantStaffSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const { userId, staffRole } = parsed.data;
  await withPlatformTx(
    actorOf(c),
    "admin.grant_staff",
    (tx) => staffRepository.grant(tx, userId, staffRole, c.get("claims").sub),
    { targetType: "user", targetId: userId, metadata: { staffRole } },
  );
  return c.json({ ok: true, userId, staffRole });
});

/** Revoke a user's staff role (sets status=revoked + revoked_at). Audited "admin.revoke_staff". */
staffRoutes.delete("/:userId", async (c) => {
  const userId = c.req.param("userId");
  await withPlatformTx(
    actorOf(c),
    "admin.revoke_staff",
    (tx) => staffRepository.revoke(tx, userId),
    { targetType: "user", targetId: userId },
  );
  // AUTH-072 — close the in-token `pa` residual. The staff-role lookup is per-request (so specific
  // capabilities deny immediately), but the coarse `pa: true` CLAIM baked into the demoted user's LIVE access
  // token still passes the platformAdmin gate until it expires (≤15 min). Force a global logout so that residual
  // closes now: revoke every session (DB) + deny-list each access token. Runs AFTER the role revoke commits, and
  // is resilient (the deny-list writes swallow a Redis outage), so it never rolls back the revoke.
  await revokeAllSessionsForUser(userId);
  return c.json({ ok: true, userId });
});
