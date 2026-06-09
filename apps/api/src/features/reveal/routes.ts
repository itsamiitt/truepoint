// routes.ts — HTTP wiring for the reveal domain (05 §6/§7; "Record Detail + Reveal"). M1 exposes the
// masked contact list that backs search/results + the post-import view; the reveal transaction itself lands
// in M3 in this same slice. PII stays masked (the repository never returns plaintext). Workspace scope comes
// from the verified token via the tenancy middleware — transport only; masking + RLS live in the db layer.

import { Hono } from "hono";
import { contactRepository } from "@leadwolf/db";
import { ForbiddenError } from "@leadwolf/types";
import { authn } from "../../middleware/authn.ts";
import { tenancy, type TenancyVariables } from "../../middleware/tenancy.ts";

export const revealRoutes = new Hono<{ Variables: TenancyVariables }>();

revealRoutes.use("*", authn);
revealRoutes.use("*", tenancy);

revealRoutes.get("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to view contacts.");
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const contacts = await contactRepository.listByWorkspace({ tenantId: c.get("tenantId"), workspaceId }, limit);
  return c.json({ contacts });
});
