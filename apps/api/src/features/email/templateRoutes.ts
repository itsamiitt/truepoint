// templateRoutes.ts — HTTP wiring for email templates (M12 P2, 01; mounted at /api/v1/templates, the path the
// Sequences ▸ Templates panel already targets). Transport only: schemas from @leadwolf/types, scope from the
// VERIFIED token, and the owner-scope (D8) + versioning + render-safe preview live in packages/core. Any
// workspace member can author their own templates; core enforces owner-only edits/restores and IDOR→404 reads.

import {
  createTemplate,
  getTemplate,
  listTemplateVersions,
  listTemplates,
  previewTemplate,
  restoreVersion,
  updateTemplate,
} from "@leadwolf/core";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createTemplateSchema,
  restoreVersionSchema,
  templateListQuerySchema,
  templatePreviewSchema,
  updateTemplateSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const templateRoutes = new Hono<{ Variables: TenancyVariables }>();

templateRoutes.use("*", authn);
templateRoutes.use("*", tenancy);

// Path-param uuid guard (the apps/api convention — see features/admin/routes.ts; the package validates path
// params with a regex, not zod).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate the `:id` path param up front. A non-uuid is treated as 404 — IDOR-indistinguishable from an
 * unknown id, and it never reaches the uuid-column query (which would otherwise surface as a 500). */
function templateIdParam(raw: string | undefined): string {
  if (!raw || !UUID_RE.test(raw)) throw new NotFoundError("Template not found in this workspace.");
  return raw;
}

templateRoutes.get("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view templates.");
  const parsed = templateListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) throw new ValidationError("Query must be { cursor?, limit?, status? }.");
  const result = await listTemplates(
    { tenantId: c.get("tenantId"), workspaceId },
    c.get("claims").sub,
    { limit: parsed.data.limit, cursor: parsed.data.cursor, status: parsed.data.status },
  );
  return c.json(result);
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

templateRoutes.get("/:id", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view templates.");
  const template = await getTemplate(
    { tenantId: c.get("tenantId"), workspaceId },
    c.get("claims").sub,
    templateIdParam(c.req.param("id")),
  );
  return c.json(template);
});

templateRoutes.get("/:id/versions", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view template history.");
  const versions = await listTemplateVersions(
    { tenantId: c.get("tenantId"), workspaceId },
    c.get("claims").sub,
    templateIdParam(c.req.param("id")),
  );
  return c.json({ versions });
});

// Render a template's current content (or an unsaved draft) with sample merge data — READ-ONLY (a POST only
// because it carries a body), no mutation. The render-safety boundary lives in core's previewTemplate.
templateRoutes.post("/:id/preview", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to preview a template.");
  const id = templateIdParam(c.req.param("id"));
  const parsed = templatePreviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new ValidationError("Body must be { subject?, body?, sample? }.");
  const result = await previewTemplate({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    templateId: id,
    draft:
      parsed.data.body !== undefined
        ? { subject: parsed.data.subject ?? null, body: parsed.data.body }
        : undefined,
    sample: parsed.data.sample,
  });
  return c.json(result);
});

// Restore version N by appending a NEW version cloning it (owner-only, D8; versions stay immutable).
templateRoutes.post("/:id/restore", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before restoring a version.");
  const id = templateIdParam(c.req.param("id"));
  const parsed = restoreVersionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { version }.");
  const result = await restoreVersion({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    templateId: id,
    version: parsed.data.version,
  });
  return c.json(result);
});

templateRoutes.patch("/:id", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before editing a template.");
  const id = templateIdParam(c.req.param("id"));
  const parsed = updateTemplateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must include at least one of { subject(+body), body, name, shared, status }.",
    );
  const result = await updateTemplate({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    userId: c.get("claims").sub,
    templateId: id,
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
