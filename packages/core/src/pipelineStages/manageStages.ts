// manageStages.ts — domain logic for the workspace pipeline-stage layer (G-REV-7, ADR-0028). Authoring +
// editing of stages, each mapping to EXACTLY ONE canonical outreach_status. The mapping invariant lives here:
// `mapsToStatus` is the canonical OutreachStatus (validated at the API edge by the Zod enum, mirrored by the
// DB CHECK), and "at most one default per workspace" is enforced by clearing other defaults in the SAME tx as
// the write. AUDIT: pipeline_stage.* mutations ship audit-free for now — the closed 08 §5 audit-action enum is
// frozen for this unit; a follow-up adds pipeline_stage.create/update audit actions (noted in the unit report).

import { type TenantScope, pipelineStageRepository, withTenantTx } from "@leadwolf/db";
import { NotFoundError, type OutreachStatus, ValidationError } from "@leadwolf/types";

export interface CreateStageInput {
  scope: TenantScope & { workspaceId: string };
  name: string;
  mapsToStatus: OutreachStatus;
  ordering?: number;
  isDefault?: boolean;
}

/**
 * Create a stage. The mapping invariant — `mapsToStatus` is a canonical OutreachStatus — is enforced by the
 * type (the API edge rejects anything else via the Zod enum; the DB CHECK is the backstop). When `ordering`
 * is omitted the stage appends at the end (max+1, computed in-tx). Setting it default clears the prior default
 * in the SAME tx so a workspace never has two defaults.
 */
export async function createStage(input: CreateStageInput): Promise<{ id: string }> {
  return withTenantTx<{ id: string }>(input.scope, async (tx) => {
    const ordering =
      input.ordering ?? (await pipelineStageRepository.nextOrdering(tx, input.scope.workspaceId));
    const id = await pipelineStageRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      name: input.name,
      mapsToStatus: input.mapsToStatus,
      ordering,
      isDefault: input.isDefault ?? false,
    });
    if (input.isDefault) {
      await pipelineStageRepository.clearDefaultsExcept(tx, input.scope.workspaceId, id);
    }
    return { id };
  });
}

export interface UpdateStageInput {
  scope: TenantScope & { workspaceId: string };
  stageId: string;
  name?: string;
  mapsToStatus?: OutreachStatus;
  ordering?: number;
  isDefault?: boolean;
  archived?: boolean;
}

/**
 * Edit a stage. `mapsToStatus`, when supplied, stays a canonical OutreachStatus (the mapping invariant is
 * preserved across edits). Promoting a stage to default clears the prior default in the same tx. NotFound when
 * the stage isn't visible in the caller's workspace (RLS-scoped). NOTE: changing `mapsToStatus` does NOT
 * retroactively re-roll already-assigned contacts — the rollup happens on assignment (assignStage); this keeps
 * a settings edit from silently mutating contact statuses behind the user's back.
 */
export async function updateStage(input: UpdateStageInput): Promise<void> {
  return withTenantTx(input.scope, async (tx) => {
    const existing = await pipelineStageRepository.getById(tx, input.stageId);
    if (!existing) throw new NotFoundError("Pipeline stage not found in this workspace.");
    await pipelineStageRepository.update(tx, input.stageId, {
      name: input.name,
      mapsToStatus: input.mapsToStatus,
      ordering: input.ordering,
      isDefault: input.isDefault,
      archived: input.archived,
    });
    if (input.isDefault) {
      await pipelineStageRepository.clearDefaultsExcept(tx, input.scope.workspaceId, input.stageId);
    }
  });
}

export interface AssignStageInput {
  scope: TenantScope & { workspaceId: string };
  contactId: string;
  /** The stage to assign, or null to clear the assignment (clearing leaves outreach_status untouched). */
  stageId: string | null;
}

export interface AssignStageResult {
  contactId: string;
  stageId: string | null;
  /** The canonical status the contact now carries — the assigned stage's `maps_to_status`, or unchanged on clear. */
  outreachStatus: OutreachStatus;
}

/**
 * Assign a contact to a stage and roll its `outreach_status` up to the stage's `maps_to_status` in ONE tx, so
 * the mapping invariant can never be observed half-applied. The status is taken from the STAGE (never the
 * caller) — that is the whole point of the layer. Clearing (stageId null) drops the assignment but leaves the
 * canonical status as-is (the rollup is one-way; we never silently reset a contact to "new"). Throws NotFound
 * when the stage or contact isn't visible in the caller's workspace (both reads/writes are RLS-scoped).
 */
export async function assignStage(input: AssignStageInput): Promise<AssignStageResult> {
  return withTenantTx<AssignStageResult>(input.scope, async (tx) => {
    let mapsToStatus: OutreachStatus | undefined;
    if (input.stageId !== null) {
      const stage = await pipelineStageRepository.getById(tx, input.stageId);
      if (!stage) throw new NotFoundError("Pipeline stage not found in this workspace.");
      if (stage.archived) {
        throw new ValidationError("Cannot assign a contact to an archived stage.");
      }
      // The stage's stored mapping is the canonical status (enforced by the DB CHECK on write). Narrow it.
      mapsToStatus = stage.mapsToStatus as OutreachStatus;
    }
    const resultingStatus = await pipelineStageRepository.assignContactStage(
      tx,
      input.contactId,
      input.stageId,
      mapsToStatus,
    );
    if (resultingStatus === null) throw new NotFoundError("Contact not found in this workspace.");
    return {
      contactId: input.contactId,
      stageId: input.stageId,
      // The contact's REAL post-write status (RETURNING): the stage's maps_to_status on assign, or the
      // unchanged prior status on clear (the rollup is one-way — we never silently reset to "new").
      outreachStatus: resultingStatus as OutreachStatus,
    };
  });
}
