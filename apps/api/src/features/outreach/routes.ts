// routes.ts — HTTP wiring for the outreach feature (05 §13, ADR-0009; mounted at /api/v1/outreach).
// Transport only: request schemas come from @leadwolf/types, scope from the VERIFIED token (never the
// body), and every compliance decision — revealed-only enrollment, the in-tx suppression gates, the
// CAN-SPAM footer — lives in packages/core's enroll/send transactions. POST /log/:id/bounce is a
// dev/testing stand-in: the SES SNS→SQS feedback worker replaces it at M12 (08 §6).

import {
  addStep,
  consoleSender,
  createSequence,
  enrollContact,
  handleBounce,
  sendStep,
} from "@leadwolf/core";
import { outreachLogRepository, sequenceRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  ValidationError,
  addStepSchema,
  createSequenceSchema,
  enrollSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const outreachRoutes = new Hono<{ Variables: TenancyVariables }>();

outreachRoutes.use("*", authn);
outreachRoutes.use("*", tenancy);

outreachRoutes.get("/sequences", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view sequences.");
  const sequences = await sequenceRepository.listSummaries({
    tenantId: c.get("tenantId"),
    workspaceId,
  });
  return c.json({ sequences });
});

outreachRoutes.post("/sequences", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before creating sequences.");
  const parsed = createSequenceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { name, from_address?, physical_address? }.");
  const result = await createSequence({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    name: parsed.data.name,
    fromAddress: parsed.data.from_address ?? null,
    physicalAddress: parsed.data.physical_address ?? null,
  });
  return c.json(result, 201);
});

outreachRoutes.post("/sequences/:id/steps", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before editing sequences.");
  const parsed = addStepSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { body, channel?, delay_hours?, subject? }.");
  const result = await addStep({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    sequenceId: c.req.param("id"),
    channel: parsed.data.channel,
    delayHours: parsed.data.delay_hours,
    subject: parsed.data.subject ?? null,
    body: parsed.data.body,
  });
  return c.json(result, 201);
});

// 201 on a new membership; 200 + alreadyEnrolled when the (sequence, contact) row already existed.
outreachRoutes.post("/sequences/:id/enroll", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before enrolling.");
  const parsed = enrollSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { contact_id }.");
  const result = await enrollContact({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    sequenceId: c.req.param("id"),
    contactId: parsed.data.contact_id,
  });
  if (result.alreadyEnrolled) {
    return c.json({ logId: result.logId, status: result.status, alreadyEnrolled: true }, 200);
  }
  return c.json({ logId: result.logId, status: result.status }, 201);
});

outreachRoutes.get("/sequences/:id/log", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view the enrollment log.");
  const entries = await outreachLogRepository.listBySequence(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("id"),
  );
  return c.json({ entries });
});

// Inline dev send (M9: consoleSender, no real network); scheduled delivery runs on the outreach queue.
outreachRoutes.post("/log/:id/send", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace before sending.");
  const result = await sendStep({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    logId: c.req.param("id"),
    sender: consoleSender,
    userId: c.get("claims").sub,
  });
  return c.json(result, 200);
});

// Dev/testing bounce injection — simulates the SES SNS→SQS hard-bounce feedback (08 §6, ADR-0013).
outreachRoutes.post("/log/:id/bounce", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before recording a bounce.");
  const result = await handleBounce({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    logId: c.req.param("id"),
  });
  return c.json(result, 200);
});
