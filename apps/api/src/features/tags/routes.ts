// routes.ts — HTTP wiring for the record-customization tag layer (ADR-0028, G-REV-6; mounted at
// /api/v1/tags). Transport only: scope comes from the VERIFIED token (never the body), validation is the
// @leadwolf/types zod schemas, and the duplicate-name 409 + RLS scoping live in the core/db layers. CRUD on
// tag definitions plus assign/unassign + list-records-by-tag for the prospect filter.

import { assignTag, createTag, deleteTag, unassignTag, updateTag } from "@leadwolf/core";
import { tagRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  ValidationError,
  assignTagSchema,
  createTagSchema,
  taggableEntity,
  updateTagSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const tagsRoutes = new Hono<{ Variables: TenancyVariables }>();

tagsRoutes.use("*", authn);
tagsRoutes.use("*", tenancy);

/** Resolve the verified workspace or 403 — tags are workspace-scoped, so a workspace must be selected. */
function requireWorkspace(c: { get: (k: "workspaceId") => string | undefined }): string {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to manage tags.");
  return workspaceId;
}

// ── Tag definitions ──────────────────────────────────────────────────────────────────────────────────────
tagsRoutes.get("/", async (c) => {
  const workspaceId = requireWorkspace(c);
  const tags = await tagRepository.listByWorkspace({ tenantId: c.get("tenantId"), workspaceId });
  return c.json({
    tags: tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      usageCount: t.usageCount,
      createdAt: t.createdAt.toISOString(),
    })),
  });
});

tagsRoutes.post("/", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = createTagSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { name, color? }.");
  const { id } = await createTag({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    name: parsed.data.name,
    color: parsed.data.color,
  });
  return c.json({ id }, 201);
});

tagsRoutes.patch("/:id", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = updateTagSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || (parsed.data.name === undefined && parsed.data.color === undefined)) {
    throw new ValidationError("Body must be { name?, color? } with at least one field.");
  }
  await updateTag({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    tagId: c.req.param("id"),
    name: parsed.data.name,
    color: parsed.data.color,
  });
  return c.body(null, 204);
});

tagsRoutes.delete("/:id", async (c) => {
  const workspaceId = requireWorkspace(c);
  await deleteTag({ tenantId: c.get("tenantId"), workspaceId }, c.req.param("id"));
  return c.body(null, 204);
});

// ── Records by tag (the prospect filter-by-tag) ──────────────────────────────────────────────────────────
tagsRoutes.get("/:id/records", async (c) => {
  const workspaceId = requireWorkspace(c);
  const entity = taggableEntity.safeParse(c.req.query("entity") ?? "contact");
  if (!entity.success) throw new ValidationError("entity must be 'contact' or 'account'.");
  const recordIds = await tagRepository.listRecordsByTag(
    { tenantId: c.get("tenantId"), workspaceId },
    c.req.param("id"),
    entity.data,
  );
  return c.json({ recordIds });
});

// ── Tags on a record (the RecordDetail "Tags" section) ───────────────────────────────────────────────────
tagsRoutes.get("/records/:entity/:recordId", async (c) => {
  const workspaceId = requireWorkspace(c);
  const entity = taggableEntity.safeParse(c.req.param("entity"));
  if (!entity.success) throw new ValidationError("entity must be 'contact' or 'account'.");
  const tags = await tagRepository.tagsForRecord(
    { tenantId: c.get("tenantId"), workspaceId },
    entity.data,
    c.req.param("recordId"),
  );
  return c.json({ tags });
});

// ── Assignments ──────────────────────────────────────────────────────────────────────────────────────────
tagsRoutes.post("/:id/assign", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = assignTagSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { entity, record_id }.");
  await assignTag({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    tagId: c.req.param("id"),
    entity: parsed.data.entity,
    recordId: parsed.data.record_id,
  });
  return c.body(null, 204);
});

tagsRoutes.post("/:id/unassign", async (c) => {
  const workspaceId = requireWorkspace(c);
  const parsed = assignTagSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { entity, record_id }.");
  await unassignTag({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    tagId: c.req.param("id"),
    entity: parsed.data.entity,
    recordId: parsed.data.record_id,
  });
  return c.body(null, 204);
});
