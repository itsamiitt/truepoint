// sendStep.ts — THE compliance-critical send transaction (05 §13, 08 §3/§6, ADR-0009, H5): load the
// enrollment + the next step, BLOCK unless the sequence carries the CAN-SPAM identity (truthful from +
// physical postal address — blocked at the send tx, not warned), re-run the suppression gate IN-TX so a
// row added after enrollment (bounce/unsubscribe/DNC) still stops the message, auto-append the
// postal-address + unsubscribe footer, send through the injected port, then advance the log + audit `send`.

import { env } from "@leadwolf/config";
import {
  type TenantScope,
  outreachLogRepository,
  revealRepository,
  sequenceRepository,
  withTenantTx,
} from "@leadwolf/db";
import { NotFoundError, ValidationError } from "@leadwolf/types";
import { assertNotSuppressed } from "../compliance/assertNotSuppressed.ts";
import { writeAudit } from "../compliance/writeAudit.ts";
import { decryptPii } from "../import/encryptPii.ts";
import type { EmailSenderPort } from "./senderPort.ts";

export interface SendStepInput {
  scope: TenantScope & { workspaceId: string };
  logId: string;
  sender: EmailSenderPort;
  /** Audit actor; omit for worker/automation sends (audit_log records null = system). */
  userId?: string | null;
}

export interface SendStepResult {
  sent: true;
  step: number;
  messageId: string;
  status: "active" | "completed";
}

/** CAN-SPAM footer (08 §6) — AUTO-APPENDED to every send, never left to the template author. The unsubscribe
 * target points at the configured app origin (the public one-click endpoint lands with the M12 SES pass). */
function withComplianceFooter(body: string, physicalAddress: string, logId: string): string {
  return `${body}\n\n---\n${physicalAddress}\nUnsubscribe: ${env.APP_ORIGINS[0]}/unsubscribe/${logId}`;
}

export async function sendStep(input: SendStepInput): Promise<SendStepResult> {
  return withTenantTx<SendStepResult>(input.scope, async (tx) => {
    const log = await outreachLogRepository.getWithSequence(tx, input.logId);
    if (!log) throw new NotFoundError("Enrollment not found in this workspace.");
    if (log.sequenceStatus !== "active") {
      throw new ValidationError("Sequence is not active; resume it before sending.");
    }

    const stepOrder = log.currentStep + 1;
    const step = await sequenceRepository.stepAt(tx, log.sequenceId, stepOrder);
    if (!step) throw new NotFoundError(`Sequence has no step ${stepOrder} to send.`);

    // CAN-SPAM identity (08 §6): a truthful from + a valid physical postal address, enforced HERE.
    if (!log.fromAddress || !log.physicalAddress) {
      throw new ValidationError(
        "CAN-SPAM: from address and physical postal address are required before sending.",
      );
    }

    const contact = await revealRepository.getContactForReveal(tx, log.contactId);
    if (!contact) throw new NotFoundError("Contact not found in this workspace.");
    if (!contact.isRevealed || !contact.emailEnc) {
      throw new ValidationError("Only revealed contacts with an email address can be sent to.");
    }

    // THE send gate (08 §3, H5): suppression re-checked INSIDE every send tx — a bounce, unsubscribe, or
    // DNC row added after enrollment still blocks here, and the rollback drops the log advance.
    await assertNotSuppressed(tx, {
      contactId: contact.id,
      emailBlindIndex: contact.emailBlindIndex,
      emailDomain: contact.emailDomain,
    });

    // Network inside this tx is acceptable for the M9 dev sender (console/static — no real I/O); the SES
    // adapter moves the provider call post-commit via the outbox at M12 so a hang can't hold DB locks.
    const { messageId } = await input.sender.send({
      to: decryptPii(contact.emailEnc),
      from: log.fromAddress,
      subject: step.subject ?? log.sequenceName,
      htmlBody: withComplianceFooter(step.body, log.physicalAddress, log.id),
    });

    const stepCount = await sequenceRepository.countSteps(tx, log.sequenceId);
    const status: SendStepResult["status"] = stepOrder >= stepCount ? "completed" : "active";
    await outreachLogRepository.advance(tx, log.id, { currentStep: stepOrder, status });
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.userId ?? null,
      action: "send",
      entityType: "contact",
      entityId: contact.id,
      metadata: { sequenceId: log.sequenceId, step: stepOrder, messageId },
    });
    return { sent: true, step: stepOrder, messageId, status };
  });
}
