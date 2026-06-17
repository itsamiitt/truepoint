// stagesApi.ts — the prospect slice's data access for the workspace pipeline-stage layer (G-REV-7, ADR-0028):
// typed, authenticated calls to apps/api's /pipeline-stages surface. Reads the in-memory access token via
// fetchWithAuth (ADR-0016); never touches the DB or the auth origin directly. The stage list drives both the
// management panel and the record StageSelector; assigning a stage rolls the contact's outreach_status up
// server-side (the UI never computes the rollup). 404/501 → not-built, surfaced honestly like the rest of the slice.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  AssignStageResult,
  CreatePipelineStageRequest,
  PipelineStage,
  UpdatePipelineStageRequest,
} from "@leadwolf/types";
import { notBuilt, toApiError } from "./api";

/** The stage list the management panel + StageSelector render. `available:false` ⇒ the backend isn't built. */
export interface StageList {
  available: boolean;
  stages: PipelineStage[];
}

/** GET /pipeline-stages — the workspace's live stages in display order (archived excluded by default). */
export async function fetchStages(includeArchived = false): Promise<StageList> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/pipeline-stages${includeArchived ? "?includeArchived=true" : ""}`,
  );
  if (notBuilt(res.status)) return { available: false, stages: [] };
  if (!res.ok) throw await toApiError(res, "Could not load stages");
  const data = (await res.json()) as { stages: PipelineStage[] };
  return { available: true, stages: data.stages };
}

/** POST /pipeline-stages — create a stage mapping to a canonical outreach_status. */
export async function createStage(body: CreatePipelineStageRequest): Promise<{ id: string }> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/pipeline-stages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res, "Could not create stage");
  return (await res.json()) as { id: string };
}

/** PATCH /pipeline-stages/:id — rename, re-map, reorder, set default, or archive a stage. */
export async function updateStage(id: string, body: UpdatePipelineStageRequest): Promise<void> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/pipeline-stages/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res, "Could not update stage");
}

/**
 * POST /pipeline-stages/contacts/:id/stage — assign (or clear) a contact's stage. The server rolls the
 * contact's outreach_status up to the stage's maps_to_status and returns the resulting canonical status.
 */
export async function assignStage(
  contactId: string,
  stageId: string | null,
): Promise<AssignStageResult> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/pipeline-stages/contacts/${contactId}/stage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage_id: stageId }),
    },
  );
  if (!res.ok) throw await toApiError(res, "Could not assign stage");
  return (await res.json()) as AssignStageResult;
}
