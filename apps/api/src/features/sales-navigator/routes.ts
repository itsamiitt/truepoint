// routes.ts — HTTP wiring for Sales Navigator link capture (05 §5, M7): POST/GET /sales-navigator/links.
// HITL by design (ADR-0009): a human pastes the link — assisted capture only, the api never automates
// against LinkedIn/Sales Nav. Plain insert/list, no audit action exists for link capture (08 §5).

import { salesNavLinkRepository, withTenantTx } from "@leadwolf/db";
import { ForbiddenError, ValidationError, salesNavLinkSchema } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const salesNavRoutes = new Hono<{ Variables: TenancyVariables }>();

salesNavRoutes.use("*", authn);
salesNavRoutes.use("*", tenancy);

salesNavRoutes.post("/links", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before capturing links.");
  const parsed = salesNavLinkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { link_type, url, external_id?, contact_id? }.");
  const tenantId = c.get("tenantId");
  const id = await withTenantTx({ tenantId, workspaceId }, (tx) =>
    salesNavLinkRepository.insert(tx, {
      tenantId,
      workspaceId,
      linkType: parsed.data.link_type,
      url: parsed.data.url,
      externalId: parsed.data.external_id ?? null,
      contactId: parsed.data.contact_id ?? null,
      createdByUserId: c.get("claims").sub,
    }),
  );
  return c.json({ id }, 201);
});

salesNavRoutes.get("/links", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to list captured links.");
  const links = await salesNavLinkRepository.listByWorkspace({
    tenantId: c.get("tenantId"),
    workspaceId,
  });
  return c.json({ links });
});
