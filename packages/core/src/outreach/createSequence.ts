// createSequence.ts — author the send-engine definitions (05 §13, ADR-0009): create a sequence and append
// ordered steps. The CAN-SPAM identity (from + physical postal address) is OPTIONAL here and enforced at
// the send transaction (08 §6) — authoring is never blocked, sending is. Both mutations audit in-tx
// (`sequence.create` / `sequence.update` — the closed 08 §5 enum).

import { type TenantScope, sequenceRepository, withTenantTx } from "@leadwolf/db";
import { NotFoundError, type OutreachStepChannel } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";

export interface CreateSequenceInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  name: string;
  fromAddress?: string | null;
  physicalAddress?: string | null;
}

export async function createSequence(input: CreateSequenceInput): Promise<{ id: string }> {
  return withTenantTx<{ id: string }>(input.scope, async (tx) => {
    const id = await sequenceRepository.insert(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      name: input.name,
      fromAddress: input.fromAddress ?? null,
      physicalAddress: input.physicalAddress ?? null,
      createdByUserId: input.userId,
    });
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.userId,
      action: "sequence.create",
      entityType: "sequence",
      entityId: id,
      metadata: { name: input.name },
    });
    return { id };
  });
}

export interface AddStepInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  sequenceId: string;
  channel?: OutreachStepChannel;
  delayHours?: number;
  subject?: string | null;
  body: string;
}

export interface AddStepResult {
  id: string;
  stepOrder: number;
}

/** Append a step at the next position — max(step_order)+1 is computed inside the same tx, so concurrent
 * appends collide on the (sequence_id, step_order) unique key instead of silently interleaving. */
export async function addStep(input: AddStepInput): Promise<AddStepResult> {
  return withTenantTx<AddStepResult>(input.scope, async (tx) => {
    const sequence = await sequenceRepository.getById(tx, input.sequenceId);
    if (!sequence) throw new NotFoundError("Sequence not found in this workspace.");

    const stepOrder = (await sequenceRepository.maxStepOrder(tx, input.sequenceId)) + 1;
    const id = await sequenceRepository.insertStep(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      sequenceId: input.sequenceId,
      stepOrder,
      channel: input.channel ?? "email",
      delayHours: input.delayHours ?? 0,
      subject: input.subject ?? null,
      body: input.body,
    });
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.userId,
      action: "sequence.update",
      entityType: "sequence",
      entityId: input.sequenceId,
      metadata: { stepId: id, stepOrder, channel: input.channel ?? "email" },
    });
    return { id, stepOrder };
  });
}
