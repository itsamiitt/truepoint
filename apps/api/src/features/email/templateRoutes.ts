// templateRoutes.ts — HTTP wiring for email templates (M12 P2, 01; mounted at /api/v1/templates, the path the
// Sequences ▸ Templates panel already targets). Transport only: schemas from @leadwolf/types, scope from the
// VERIFIED token, and the owner-scope (D8) + versioning live in packages/core. Any workspace member can
// author their own templates; core enforces owner-only edits (D8).

import { createTemplate, listTemplates, updateTemplate } from "@leadwolf/core";
import {
  ForbiddenError,
  ValidationError,
  createTemplateSchema,
  updateTemplateSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const templateRoutes = new Hono<{ Variables: TenancyVariables }>();

templateRoutes.use("*", authn);
templateRoutes.use("*", tenancy);

templateRoutes.get("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view templates.");
  const templates = await listTemplates(
    { tenantId: c.get("tenantId"), workspaceId },
    c.get("claims").sub,
  );
  return c.json({ templates });
});

templateRoutes.post("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before creating a template.");
  const parsed = createTemplateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { name, body, channel?, subject?, shared? }.");
  const result = await createTemplate({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    name: parsed.data.name,
    channel: parsed.data.channel,
    subject: parsed.data.subject ?? null,
    body: parsed.data.body,
    shared: parsed.data.shared,
  });
  return c.json(result, 201);
});

templateRoutes.patch("/:id", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before editing a template.");
  const parsed = updateTemplateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must include at least one of { subject, body, name, shared, status }.",
    );
  const result = await updateTemplate({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    templateId: c.req.param("id"),
    // A content edit needs the full subject+body together (it appends an immutable version).
    content:
      parsed.data.body !== undefined
        ? { subject: parsed.data.subject ?? null, body: parsed.data.body }
        : undefined,
    name: parsed.data.name,
    shared: parsed.data.shared,
    status: parsed.data.status,
  });
  return c.json(result, 200);
});
