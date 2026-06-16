// routes.ts — HTTP wiring for the per-contact activity timeline (05 §10, M8): GET/POST
// /contacts/:id/activities. Mounted on the same /api/v1/contacts base as the reveal/scoring slices —
// paths do not overlap. Transport only — the contact check + insert live in core/db.

import { logActivity } from "@leadwolf/core";
import { activityRepository } from "@leadwolf/db";
import { ForbiddenError, ValidationError, logActivitySchema } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const activityRoutes = new Hono<{ Variables: TenancyVariables }>();

activityRoutes.use("*", authn);
activityRoutes.use("*", tenancy);

activityRoutes.get("/:id/activities", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view the timeline.");
  const activities = await activityRepository.timelineForContact(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("id"),
  );
  return c.json({ activities });
});

activityRoutes.post("/:id/activities", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before logging activity.");
  const parsed = logActivitySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must be { activity_type, channel, outcome?, note?, occurred_at? }.",
    );
  const id = await logActivity({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    contactId: c.req.param("id"),
    actorUserId: c.get("claims").sub,
    activityType: parsed.data.activity_type,
    channel: parsed.data.channel,
    outcome: parsed.data.outcome,
    note: parsed.data.note,
    occurredAt: parsed.data.occurred_at ? new Date(parsed.data.occurred_at) : undefined,
  });
  return c.json({ id }, 201);
});
