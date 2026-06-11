// routes.ts — HTTP wiring for on-demand enrichment (09 §2: POST /enrichment/:entity/:id). Like the M1
// import route, M4 runs the call inline with the configured adapters injected; bulk/background work
// diverts to the `enrichment` worker queue (same core fn). Transport only — cache, budget breaker,
// waterfall, and persistence live in core/db.

import { enrichContact } from "@leadwolf/core";
import { defaultProviders } from "@leadwolf/integrations";
import { ForbiddenError, ValidationError, enrichmentRequestSchema } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const enrichmentRoutes = new Hono<{ Variables: TenancyVariables }>();

enrichmentRoutes.use("*", authn);
enrichmentRoutes.use("*", tenancy);

enrichmentRoutes.post("/:entity/:id", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before enriching.");
  if (c.req.param("entity") !== "contact") {
    throw new ValidationError("Only entity 'contact' is enrichable at M4 (accounts land later).");
  }

  const parsed = enrichmentRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { fields: EnrichField[] }.");

  const result = await enrichContact({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    contactId: c.req.param("id"),
    fields: parsed.data.fields,
    providers: defaultProviders(),
    requestedByUserId: c.get("claims").sub,
  });
  return c.json(result, 200);
});
