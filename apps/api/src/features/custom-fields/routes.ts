// routes.ts — HTTP wiring for the record-customization layer (ADR-0028, gap G-REV-5), mounted at
// /api/v1/custom-fields. Definitions: GET (by entity) · POST (create) · PATCH /:id (edit/archive). Values:
// GET/PATCH /values/:entity/:recordId — set values shallow-merged into the record's custom_fields jsonb,
// validated by type in core. Values live under this router's own /values/* prefix to stay self-contained and
// avoid colliding with the three existing /api/v1/contacts routers (reveal/scoring/activity). Thin: validate
// at the edge (@leadwolf/types) + call core; no business logic here. custom_field.* is audit-free for now
// (sales_nav_links precedent; the audit-action enum is owned elsewhere).

import {
  createDefinition,
  getCustomFieldValues,
  listDefinitions,
  setCustomFieldValues,
  updateDefinition,
} from "@leadwolf/core";
import {
  type CustomFieldDefinitionDto,
  ForbiddenError,
  ValidationError,
  createCustomFieldSchema,
  customFieldEntity,
  setCustomFieldValuesSchema,
  updateCustomFieldSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const customFieldsRoutes = new Hono<{ Variables: TenancyVariables }>();

customFieldsRoutes.use("*", authn);
customFieldsRoutes.use("*", tenancy);

/** Map a repository definition record to the camelCased API DTO. */
function toDefinitionDto(d: {
  id: string;
  entity: string;
  key: string;
  label: string;
  fieldType: string;
  options: string[] | null;
  required: boolean;
  archived: boolean;
  ordering: number;
}): CustomFieldDefinitionDto {
  return {
    id: d.id,
    entity: d.entity as CustomFieldDefinitionDto["entity"],
    key: d.key,
    label: d.label,
    fieldType: d.fieldType as CustomFieldDefinitionDto["fieldType"],
    options: d.options,
    required: d.required,
    archived: d.archived,
    ordering: d.ordering,
  };
}

function requireWorkspace(workspaceId: string | undefined): string {
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to manage custom fields.");
  return workspaceId;
}

// ── Definitions ────────────────────────────────────────────────────────────────────────────────────────

/** GET /custom-fields?entity=contact|account&includeArchived=true — list the workspace's field definitions. */
customFieldsRoutes.get("/", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const parsedEntity = customFieldEntity.safeParse(c.req.query("entity"));
  if (!parsedEntity.success)
    throw new ValidationError("Query 'entity' must be 'contact' or 'account'.");
  const includeArchived = c.req.query("includeArchived") === "true";
  const defs = await listDefinitions(
    { tenantId: c.get("tenantId"), workspaceId },
    parsedEntity.data,
    includeArchived,
  );
  return c.json({ definitions: defs.map(toDefinitionDto) });
});

/** POST /custom-fields — create a definition. 422 on a duplicate key or bad shape. */
customFieldsRoutes.post("/", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const parsed = createCustomFieldSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must be { entity, key, label, field_type, options?, required?, ordering? }.",
    );
  const def = await createDefinition({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    entity: parsed.data.entity,
    key: parsed.data.key,
    label: parsed.data.label,
    fieldType: parsed.data.field_type,
    options: parsed.data.options ?? null,
    required: parsed.data.required,
    ordering: parsed.data.ordering,
  });
  return c.json(toDefinitionDto(def), 201);
});

/** PATCH /custom-fields/:id — edit a definition's editorial surface (label/options/required/ordering/archived). */
customFieldsRoutes.patch("/:id", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const parsed = updateCustomFieldSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must include at least one of label/options/required/ordering/archived.",
    );
  const def = await updateDefinition({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    id: c.req.param("id"),
    patch: {
      label: parsed.data.label,
      options: parsed.data.options,
      required: parsed.data.required,
      ordering: parsed.data.ordering,
      archived: parsed.data.archived,
    },
  });
  return c.json(toDefinitionDto(def), 200);
});

// ── Values (typed jsonb on a contact/account) ────────────────────────────────────────────────────────────

/** GET /custom-fields/values/:entity/:recordId — a record's values joined to its live definitions. */
customFieldsRoutes.get("/values/:entity/:recordId", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const parsedEntity = customFieldEntity.safeParse(c.req.param("entity"));
  if (!parsedEntity.success)
    throw new ValidationError("Path 'entity' must be 'contact' or 'account'.");
  const values = await getCustomFieldValues(
    { tenantId: c.get("tenantId"), workspaceId },
    parsedEntity.data,
    c.req.param("recordId"),
  );
  return c.json({ values });
});

/** PATCH /custom-fields/values/:entity/:recordId — set values (shallow-merged, validated by type). */
customFieldsRoutes.patch("/values/:entity/:recordId", async (c) => {
  const workspaceId = requireWorkspace(c.get("workspaceId"));
  const parsedEntity = customFieldEntity.safeParse(c.req.param("entity"));
  if (!parsedEntity.success)
    throw new ValidationError("Path 'entity' must be 'contact' or 'account'.");
  const parsed = setCustomFieldValuesSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { values: { key: value, … } }.");
  const values = await setCustomFieldValues({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    entity: parsedEntity.data,
    recordId: c.req.param("recordId"),
    values: parsed.data.values,
  });
  return c.json({ values }, 200);
});
