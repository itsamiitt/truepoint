// compliance.ts — platform-admin compliance-ops endpoints (13a Area 8, 13 §3.8). Mounted under
// /api/v1/admin/compliance, so the parent router already applied authn + platformAdmin. Compliance oversight
// is the compliance officer's surface → the compliance:read capability (compliance_officer; super_admin
// implies). The DSAR queue read runs through the audited withPlatformTx and returns a PII-free envelope only
// (never the encrypted subject email). DSAR requests are global, not per-tenant.

import { platformComplianceReadRepository, withPlatformTx } from "@leadwolf/db";
import { type DsarOversightRow, ValidationError, platformDsarQuerySchema } from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

export const complianceRoutes = new Hono<{ Variables: ApiVariables }>();

complianceRoutes.use("*", requireCapability("compliance:read"));

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

function toRow(r: {
  id: string;
  requestType: string;
  status: string;
  requestedAt: Date;
  verifiedAt: Date | null;
  completedAt: Date | null;
}): DsarOversightRow {
  return {
    id: r.id,
    requestType: r.requestType as DsarOversightRow["requestType"],
    status: r.status as DsarOversightRow["status"],
    requestedAt: r.requestedAt.toISOString(),
    verifiedAt: r.verifiedAt ? r.verifiedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

/** The DSAR request queue (newest first), optionally filtered by status. Audited read; PII-free. */
complianceRoutes.get("/dsars", async (c) => {
  const parsed = platformDsarQuerySchema.safeParse({
    status: c.req.query("status"),
    limit: c.req.query("limit"),
  });
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const dsars = await withPlatformTx(actorOf(c), "admin.list_dsars", async (tx) =>
    (await platformComplianceReadRepository.listDsarRequests(tx, parsed.data)).map(toRow),
  );
  return c.json({ dsars });
});
