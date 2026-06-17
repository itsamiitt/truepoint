// pipelineStages.ts — shared vocabulary for the workspace pipeline-stage layer (G-REV-7, ADR-0028). Teams
// define their own ordered stages; each stage maps to EXACTLY ONE canonical `outreachStatus` value, so the
// load-bearing enum (reports/automation/API) stays intact while boards/views operate on stages. This file is
// the source of truth for the request schemas + DTOs; the `maps_to_status` CHECK in packages/db mirrors the
// `outreachStatus` enum re-used here. Validation lives here; logic does not.

import { z } from "zod";
import { outreachStatus } from "./contacts.ts";

// ── Request schemas (09 §3 body naming: snake_case) ────────────────────────────────────────────────────
/**
 * Create a stage. `maps_to_status` MUST be a canonical `outreachStatus` value (the mapping invariant) — the
 * Zod enum rejects anything else at the edge before the DB CHECK ever runs. `ordering` is optional; the core
 * layer appends at the end (max+1) when omitted. `is_default` marks the stage new contacts land on.
 */
export const createPipelineStageSchema = z.object({
  name: z.string().min(1).max(120),
  maps_to_status: outreachStatus,
  ordering: z.number().int().min(0).optional(),
  is_default: z.boolean().optional(),
});
export type CreatePipelineStageRequest = z.infer<typeof createPipelineStageSchema>;

/** Sparse stage patch — every field optional; `maps_to_status` is still constrained to the canonical enum. */
export const updatePipelineStageSchema = z
  .object({
    name: z.string().min(1).max(120),
    maps_to_status: outreachStatus,
    ordering: z.number().int().min(0),
    is_default: z.boolean(),
    archived: z.boolean(),
  })
  .partial();
export type UpdatePipelineStageRequest = z.infer<typeof updatePipelineStageSchema>;

/** Assign a contact to a stage (POST /pipeline-stages/contacts/:id/stage). Null clears the assignment. */
export const assignStageSchema = z.object({
  stage_id: z.string().uuid().nullable(),
});
export type AssignStageRequest = z.infer<typeof assignStageSchema>;

// ── DTOs (the stage-management panel + the record StageSelector render these) ──────────────────────────
export const pipelineStageSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** The canonical `outreachStatus` a contact rolls up to when assigned to this stage. */
  mapsToStatus: outreachStatus,
  ordering: z.number().int().nonnegative(),
  isDefault: z.boolean(),
  archived: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type PipelineStage = z.infer<typeof pipelineStageSchema>;

/** The result of assigning a stage: the new stage id (null when cleared) + the canonical status it rolled up to. */
export const assignStageResultSchema = z.object({
  contactId: z.string().uuid(),
  stageId: z.string().uuid().nullable(),
  outreachStatus: outreachStatus,
});
export type AssignStageResult = z.infer<typeof assignStageResultSchema>;
