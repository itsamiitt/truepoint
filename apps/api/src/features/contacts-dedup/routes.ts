// routes.ts — within-workspace dedup REVIEW (database-management-research G09; mounted at /api/v1/contacts/
// duplicates). A workspace user lists the contacts the import dedup auto-flagged as duplicates + the canonical each
// maps to, and can OVERRIDE a wrong call ("this is not a duplicate"). The workspace is taken from the VERIFIED
// token (never the body); RLS scopes every read/write to it. NAMES ONLY — no PII. Transport only; core/db do the work.
import { listContactDuplicatePairs, unmarkContactDuplicate } from "@leadwolf/core";
import {
  ForbiddenError,
  NotFoundError,
  duplicatePairListResponse,
  unmarkDuplicateResponse,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const contactsDedupRoutes = new Hono<{ Variables: RoleVariables }>();
contactsDedupRoutes.use("*", authn);
contactsDedupRoutes.use("*", tenancy);

/** GET /contacts/duplicates — the workspace's auto-flagged duplicate pairs for review (any active role may view). */
contactsDedupRoutes.get("/", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to review duplicates.");
  const pairs = await listContactDuplicatePairs({ tenantId: c.get("tenantId"), workspaceId });
  return c.json(duplicatePairListResponse.parse({ pairs }), 200);
});

/** POST /contacts/duplicates/:id/unmark — override a wrong auto-dedup call ("this contact is NOT a duplicate"). */
contactsDedupRoutes.post("/:id/unmark", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to review duplicates.");
  const unmarked = await unmarkContactDuplicate(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("id"),
  );
  if (!unmarked) throw new NotFoundError("No flagged duplicate with that id in this workspace.");
  return c.json(unmarkDuplicateResponse.parse({ unmarked }), 200);
});
