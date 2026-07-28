// publishCrmPushIntent.ts — the TP-side change emitter (crm-sync 00 §2.2 gap 3 / §3.3 outbound, ADR-0027).
//
// Called from a write path INSIDE its tenant transaction. Writes a transactional-outbox intent, which the
// leaderless relay later fans out into one push job per connection.
//
// WHY AN OUTBOX AND NOT A DIRECT ENQUEUE: the intent must commit atomically with the write that caused it. A
// `queue.add` after the transaction can be lost to a crash in the gap, leaving TruePoint changed and the
// customer's CRM stale with nothing to reconcile it. Inside the tx, either both happen or neither does.
//
// WHY THE ENV GATE IS CHECKED HERE: with CRM_SYNC_ENABLED off this is a no-op, so a deployment with no CRM
// integration pays NOTHING — not an extra row per contact write. That is the difference between a seam that
// ships inert and one that taxes every write in the fleet for a feature nobody uses. The relay re-checks the
// per-tenant flag and the per-connection mode, so being generous here would be safe but wasteful.

import { env } from "@leadwolf/config";
import { type Tx, outboxRepository } from "@leadwolf/db";
import { CRM_PUSH_TOPIC } from "@leadwolf/types";

export interface CrmPushIntentInput {
  scope: { tenantId: string; workspaceId: string };
  tpEntityType: "contact" | "account";
  tpEntityId: string;
  changeSeq?: number;
}

/**
 * Record that a TruePoint entity changed and may need pushing.
 *
 * Returns whether an intent was written, so a caller can assert the gate in a test rather than guess. Never
 * throws on a gated call — a write path must not fail because an optional integration is switched off.
 */
export async function publishCrmPushIntent(tx: Tx, input: CrmPushIntentInput): Promise<boolean> {
  if (!env.CRM_SYNC_ENABLED) return false;

  await outboxRepository.enqueueInTx(tx, {
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    topic: CRM_PUSH_TOPIC,
    payload: {
      scope: input.scope,
      tpEntityType: input.tpEntityType,
      tpEntityId: input.tpEntityId,
      changeSeq: input.changeSeq ?? 0,
    },
  });
  return true;
}
