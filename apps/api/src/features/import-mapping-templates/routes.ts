// routes.ts — HTTP wiring for saved import mapping templates (G-IMP-3, 30 §8), mounted at
// /api/v1/imports/mapping-templates. CRUD over named, workspace-scoped, replayable column mappings:
//   GET    /                 list the workspace's templates (the picker's data)
//   POST   /                 save (UPSERT by case-insensitive name) a template
//   GET    /:id              read one template (its mapping pre-fills the wizard column-mapper = "apply")
//   DELETE /:id              delete one template
// The workspace is taken from the VERIFIED token via the tenancy middleware, never the request body (16 §7).
// Transport only — validation lives in @leadwolf/types, persistence + isolation in packages/core → db (RLS).

import {
  deleteMappingTemplate,
  getMappingTemplate,
  listMappingTemplates,
  saveMappingTemplate,
} from "@leadwolf/core";
import {
  ForbiddenError,
  type ImportMappingTemplate,
  type ImportMappingTemplateList,
  NotFoundError,
  ValidationError,
  saveImportMappingTemplateSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { rateLimit } from "../../middleware/rateLimit.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const importMappingTemplatesRoutes = new Hono<{ Variables: TenancyVariables }>();

importMappingTemplatesRoutes.use("*", authn);
importMappingTemplatesRoutes.use("*", tenancy);
importMappingTemplatesRoutes.use("*", rateLimit);

/** Resolve the verified workspace scope or fail closed — no body-supplied scope is ever trusted (16 §7). */
function requireScope(c: Context<{ Variables: TenancyVariables }>): {
  tenantId: string;
  workspaceId: string;
} {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before using mapping templates.");
  return { tenantId: c.get("tenantId"), workspaceId };
}

// List the workspace's saved templates (newest-updated first).
importMappingTemplatesRoutes.get("/", async (c) => {
  const scope = requireScope(c);
  const templates = await listMappingTemplates(scope);
  const body: ImportMappingTemplateList = { templates };
  return c.json(body, 200);
});

// Save (UPSERT by case-insensitive name) a template.
importMappingTemplatesRoutes.post("/", async (c) => {
  const scope = requireScope(c);
  const parsed = saveImportMappingTemplateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { name, mapping } with at least one mapped field.");

  const template = await saveMappingTemplate({
    scope,
    createdByUserId: c.get("claims").sub,
    template: parsed.data,
  });
  const body: ImportMappingTemplate = template;
  return c.json(body, 201);
});

// Read one template — its `mapping` is what the wizard applies (pre-fills the column-mapper). A
// foreign/absent id is a 404 (RLS scopes the lookup to this workspace; never leak existence).
importMappingTemplatesRoutes.get("/:id", async (c) => {
  const scope = requireScope(c);
  const template = await getMappingTemplate(scope, c.req.param("id"));
  if (!template) throw new NotFoundError("Mapping template not found.");
  const body: ImportMappingTemplate = template;
  return c.json(body, 200);
});

// Delete one template.
importMappingTemplatesRoutes.delete("/:id", async (c) => {
  const scope = requireScope(c);
  const deleted = await deleteMappingTemplate(scope, c.req.param("id"));
  if (!deleted) throw new NotFoundError("Mapping template not found.");
  return c.body(null, 204);
});
