// handleBounce.ts — the M9-dev stand-in for the SES SNS→SQS bounce-feedback worker (08 §6, ADR-0013/H13):
// ONE transaction that marks the enrollment bounced, auto-adds the workspace-scope suppression row (a hard
// bounce gates every future send/reveal of that address), and honors the published credit-back guarantee —
// a CHARGED email reveal whose address hard-bounced is refunded onto the tenant counter, audited as
// `credit.adjust`. Replays are no-ops (SNS delivers at-least-once).

import {
  type TenantScope,
  creditRepository,
  outreachLogRepository,
  revealRepository,
  suppressionRepository,
  withTenantTx,
} from "@leadwolf/db";
import { NotFoundError } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";

export interface HandleBounceInput {
  scope: TenantScope & { workspaceId: string };
  logId: string;
}

export interface HandleBounceResult {
  bounced: true;
  creditedBack: number;
}

export async function handleBounce(input: HandleBounceInput): Promise<HandleBounceResult> {
  return withTenantTx<HandleBounceResult>(input.scope, async (tx) => {
    const log = await outreachLogRepository.getWithSequence(tx, input.logId);
    if (!log) throw new NotFoundError("Enrollment not found in this workspace.");
    // Idempotent replay: an already-bounced log adds no second suppression row and no second refund.
    if (log.status === "bounced") return { bounced: true, creditedBack: 0 };

    const contact = await revealRepository.getContactForReveal(tx, log.contactId);
    if (!contact) throw new NotFoundError("Contact not found in this workspace.");

    await outreachLogRepository.setStatus(tx, log.id, "bounced");

    // Auto-suppression on hard bounce (08 §3/§6): workspace scope, keyed by the email blind index — the
    // same key the reveal AND send gates match on. Contact-id fallback when the copy carries no email key.
    await suppressionRepository.insert(tx, {
      scope: "workspace",
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      ...(contact.emailBlindIndex
        ? { matchType: "email" as const, emailBlindIndex: contact.emailBlindIndex }
        : { matchType: "contact_id" as const, contactId: contact.id }),
      reason: "bounce",
    });
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: null, // system: the bounce-feedback pipeline
      action: "suppression.add",
      entityType: "contact",
      entityId: contact.id,
      metadata: { reason: "bounce", sequenceId: log.sequenceId, logId: log.id },
    });

    // ADR-0013/H13: the credit-back guarantee — refund the charged email reveal, audited.
    const creditedBack = await outreachLogRepository.creditBackForBounce(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      contactId: contact.id,
    });
    if (creditedBack > 0) {
      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: null,
        action: "credit.adjust",
        entityType: "tenant",
        entityId: input.scope.tenantId,
        metadata: { reason: "bounce_credit_back", amount: creditedBack, contactId: contact.id },
      });
      // M11 ledger (ADR-0029): the credit-back is a `credit_back` entry, atomic with the counter refund +
      // audit, inside handleBounce's withTenantTx (tenant GUC set → WITH CHECK passes). Idempotent on
      // (tenant, credit_back:<logId>) — the already-bounced early-return guarantees one credit-back per log.
      await creditRepository.insertLedger(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        entryType: "credit_back",
        delta: creditedBack,
        idempotencyKey: `credit_back:${log.id}`,
        reason: "bounce",
        metadata: { logId: log.id, contactId: contact.id },
      });
    }
    return { bounced: true, creditedBack };
  });
}
