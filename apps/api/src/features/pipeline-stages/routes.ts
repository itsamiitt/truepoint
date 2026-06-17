// routes.ts — HTTP wiring for the workspace pipeline-stage layer (G-REV-7, ADR-0028; mounted at
// /api/v1/pipeline-stages). Transport only: request schemas come from @leadwolf/types, scope from the VERIFIED
// token (never the body), and the mapping invariant + the assign-rollup tx live in @leadwolf/core. Stages let
// a team model its own pipeline while each maps to one canonical outreach_status, so reports/automation/API
// (which consume the enum) stay intact. AUDIT: pipeline_stage.* ships audit-free for now (the 08 §5 enum is
// frozen for this unit) — a follow-up adds the audit actions.

import { assignStage, createStage, updateStage } from "@leadwolf/core";
import { pipelineStageRepository } from "@leadwolf/db";
import {
  ForbiddenError,
  ValidationError,
  assignStageSchema,
  createPipelineStageSchema,
  updatePipelineStageSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

export const pipelineStagesRoutes = new Hono<{ Variables: TenancyVariables }>();

pipelineStagesRoutes.use("*", authn);
pipelineStagesRoutes.use("*", tenancy);

/** Map a repository StageRecord to the wire DTO (PipelineStage): camelCase, timestamps as ISO strings. */
function toDto(s: {
  id: string;
  name: string;
  mapsToStatus: string;
  ordering: number;
  isDefault: boolean;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: s.id,
    name: s.name,
    mapsToStatus: s.mapsToStatus,
    ordering: s.ordering,
    isDefault: s.isDefault,
    archived: s.archived,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// GET /pipeline-stages?includeArchived=true — the workspace's stages in display order.
pipelineStagesRoutes.get("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to view stages.");
  const includeArchived = c.req.query("includeArchived") === "true";
  const stages = await pipelineStageRepository.list(
    { tenantId: c.get("tenantId"), workspaceId },
    includeArchived,
  );
  return c.json({ stages: stages.map(toDto) });
});

// POST /pipeline-stages — create a stage (maps_to_status validated to the canonical enum by the schema).
pipelineStagesRoutes.post("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before creating stages.");
  const parsed = createPipelineStageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError("Body must be { name, maps_to_status, ordering?, is_default? }.");
  const { id } = await createStage({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    name: parsed.data.name,
    mapsToStatus: parsed.data.maps_to_status,
    ordering: parsed.data.ordering,
    isDefault: parsed.data.is_default,
  });
  return c.json({ id }, 201);
});

// PATCH /pipeline-stages/:id — edit a stage (rename, re-map, reorder, set default, archive).
pipelineStagesRoutes.patch("/:id", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before editing stages.");
  const parsed = updatePipelineStageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ValidationError(
      "Body must be a subset of { name, maps_to_status, ordering, is_default, archived }.",
    );
  await updateStage({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    stageId: c.req.param("id"),
    name: parsed.data.name,
    mapsToStatus: parsed.data.maps_to_status,
    ordering: parsed.data.ordering,
    isDefault: parsed.data.is_default,
    archived: parsed.data.archived,
  });
  return c.json({ ok: true });
});

// POST /pipeline-stages/contacts/:id/stage — assign (or clear) a contact's stage; rolls outreach_status up.
pipelineStagesRoutes.post("/contacts/:id/stage", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before assigning stages.");
  const parsed = assignStageSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { stage_id } (null to clear).");
  const result = await assignStage({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    contactId: c.req.param("id"),
    stageId: parsed.data.stage_id,
  });
  return c.json(result);
});
