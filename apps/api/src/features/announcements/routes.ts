// routes.ts — the CUSTOMER-facing announcements read (13a Area 10). GET /api/v1/announcements returns the
// active announcements applicable to the caller's tenant, for the in-app banner. authn + tenancy resolve the
// tenant from the VERIFIED claims (never the request); the repo reads on the owner connection with that
// server-controlled filter (announcements are platform broadcasts, deny-all to the app role). The projection
// carries no authoring metadata — just what the banner renders.

import { announcementRepository } from "@leadwolf/db";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const announcementsRoutes = new Hono<{ Variables: TenancyVariables }>();

announcementsRoutes.use("*", authn);
announcementsRoutes.use("*", tenancy);

/** The active announcements for the caller's tenant (banner feed). */
announcementsRoutes.get("/", async (c) => {
  const announcements = await announcementRepository.listActiveForTenant(c.get("tenantId"));
  return c.json({ announcements });
});
