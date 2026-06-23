// auditLog.ts — platform-admin audit-log viewer (ADR-0032 / 13 §9). Mounted under /api/v1/admin, so the
// parent router already applied authn + platformAdmin (the `pa` gate). The platform audit log is the record
// of every privileged cross-tenant action; reading it is itself a sensitive compliance action, so this
// surface additionally requires the super_admin OR compliance_officer staff role. The read runs through the
// audited withPlatformTx (cross-tenant owner visibility + its own platform_audit_log row) and is bounded by
// PLATFORM_READ_LIMIT. The response is the structured envelope only (no `metadata` jsonb) — read-only.

import { platformAuditReadRepository, withPlatformTx } from "@leadwolf/db";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireStaffRole } from "../../middleware/requireStaffRole.ts";

export const auditLogRoutes = new Hono<{ Variables: ApiVariables }>();

// Reading the platform audit log is restricted to the roles accountable for it — super_admin (all caps) and
// the compliance officer (whose job is reviewing this trail). Above the coarse `pa` gate.
auditLogRoutes.use("*", requireStaffRole("super_admin", "compliance_officer"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

/** The most recent platform audit entries (newest first, bounded). Reading the log is itself audited. */
auditLogRoutes.get("/", async (c) => {
  const rows = await withPlatformTx(actorOf(c), "admin.read_audit_log", (tx) =>
    platformAuditReadRepository.listRecent(tx),
  );
  return c.json({
    entries: rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() })),
  });
});
