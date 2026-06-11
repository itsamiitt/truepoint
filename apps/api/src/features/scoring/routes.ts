// routes.ts — HTTP wiring for the scoring domain (09 §2: GET /contacts/:id/scores; ADR-0008). The
// re-score runs inline (pure DB work, fast); bulk re-scores divert to the `scoring` worker queue.
// Mounted on the same /api/v1/contacts base as the reveal slice — paths do not overlap.

import { computeScore } from "@leadwolf/core";
import { scoreRepository } from "@leadwolf/db";
import { ForbiddenError } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const scoringRoutes = new Hono<{ Variables: TenancyVariables }>();

scoringRoutes.use("*", authn);
scoringRoutes.use("*", tenancy);

scoringRoutes.get("/:id/scores", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to view scores.");
  const history = await scoreRepository.historyForContact(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("id"),
  );
  return c.json({ scores: history });
});

scoringRoutes.post("/:id/rescore", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before rescoring.");
  const result = await computeScore({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    contactId: c.req.param("id"),
  });
  return c.json(result, 200);
});
