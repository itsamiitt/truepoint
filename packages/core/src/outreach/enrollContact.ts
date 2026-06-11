// enrollContact.ts — the enrollment gate of the M9 send engine (05 §13, 08 §3, ADR-0009): ONE transaction
// that (a) requires a REVEALED contact — you can only sequence a copy you own, (b) runs the unbypassable
// in-tx suppression gate, (c) inserts the idempotent (sequence, contact) membership, (d) rolls the
// contact's outreach_status up to in_sequence, and (e) audits `enroll`. A suppressed contact propagates
// SuppressedError and the whole tx rolls back — the gate refusing IS the behavior (08 §3).

import {
  type TenantScope,
  outreachLogRepository,
  revealRepository,
  sequenceRepository,
  withTenantTx,
} from "@leadwolf/db";
import { NotFoundError, type OutreachLogStatus, ValidationError } from "@leadwolf/types";
import { assertNotSuppressed } from "../compliance/assertNotSuppressed.ts";
import { writeAudit } from "../compliance/writeAudit.ts";

export interface EnrollContactInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  sequenceId: string;
  contactId: string;
}

export interface EnrollContactResult {
  logId: string;
  status: OutreachLogStatus;
  alreadyEnrolled: boolean;
}

export async function enrollContact(input: EnrollContactInput): Promise<EnrollContactResult> {
  return withTenantTx<EnrollContactResult>(input.scope, async (tx) => {
    const sequence = await sequenceRepository.getById(tx, input.sequenceId);
    if (!sequence) throw new NotFoundError("Sequence not found in this workspace.");

    const contact = await revealRepository.getContactForReveal(tx, input.contactId);
    if (!contact) throw new NotFoundError("Contact not found in this workspace.");
    if (!contact.isRevealed) throw new ValidationError("Only revealed contacts can be enrolled.");

    // The unbypassable suppression/DNC gate, IN-TX (08 §3): a suppressed contact is never enrolled.
    await assertNotSuppressed(tx, {
      contactId: contact.id,
      emailBlindIndex: contact.emailBlindIndex,
      emailDomain: contact.emailDomain,
    });

    const logId = await outreachLogRepository.enroll(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      sequenceId: input.sequenceId,
      contactId: contact.id,
    });
    if (!logId) {
      // (sequence, contact) membership already exists — idempotent re-enroll returns it unchanged.
      const existing = await outreachLogRepository.findBySequenceAndContact(
        tx,
        input.sequenceId,
        contact.id,
      );
      if (!existing) throw new NotFoundError("Enrollment not found."); // unreachable: the conflict implies the row
      return {
        logId: existing.id,
        status: existing.status as OutreachLogStatus,
        alreadyEnrolled: true,
      };
    }

    await outreachLogRepository.markContactInSequence(tx, contact.id);
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.userId,
      action: "enroll",
      entityType: "contact",
      entityId: contact.id,
      metadata: { sequenceId: input.sequenceId, logId },
    });
    return { logId, status: "enrolled", alreadyEnrolled: false };
  });
}
