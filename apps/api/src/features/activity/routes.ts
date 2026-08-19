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
  // Keyset cursor (perf-audit P2.6 tail): the timeline was a hard 50 with no way to reach older entries.
  // ADDITIVE — `nextCursor` joins the response; the existing panel keeps ignoring it. A malformed cursor
  // degrades to the first page, never a 500.
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 100);
  const rawCursor = c.req.query("cursor");
  let cursor: { occurredAt: Date; id: string } | null = null;
  if (rawCursor) {
    try {
      const [iso, id] = Buffer.from(rawCursor, "base64url").toString("utf8").split("|");
      const occurredAt = iso ? new Date(iso) : null;
      if (occurredAt && !Number.isNaN(occurredAt.getTime()) && id) cursor = { occurredAt, id };
    } catch {
      /* malformed cursor → first page */
    }
  }
  const page = await activityRepository.timelineForContact(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("id"),
    limit,
    cursor,
  );
  return c.json({
    activities: page.activities,
    nextCursor: page.nextCursor
      ? Buffer.from(
          `${page.nextCursor.occurredAt.toISOString()}|${page.nextCursor.id}`,
          "utf8",
        ).toString("base64url")
      : null,
  });
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
