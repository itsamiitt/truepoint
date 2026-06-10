// revealContact.ts — THE monetized path (07 §3, H1/H2): one transaction that gates on suppression, claims
// the reveal idempotently, serializes the tenant counter with FOR UPDATE, and audits — exactly the sequence
// documented identically in 07 §3 / 08 §3 / 09 §3.2. Costs are config-injected placeholders (07 §1, 14 §5.7);
// the verified-result charge policy (ADR-0013) refines them at M4. Keep this tx TINY: no provider calls, no
// network inside the lock window (14 §5.3).

import { env } from "@leadwolf/config";
import {
  type ContactForReveal,
  type TenantScope,
  creditRepository,
  revealRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  InsufficientCreditsError,
  NotFoundError,
  type RevealResponse,
  type RevealType,
  SuppressedError,
} from "@leadwolf/types";
import { assertNotSuppressed } from "../compliance/assertNotSuppressed.ts";
import { writeAudit } from "../compliance/writeAudit.ts";
import { decryptPii } from "../import/encryptPii.ts";

export interface RevealInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  contactId: string;
  revealType: RevealType;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Per-type credit cost — read from config so pricing is never hardcoded in a code path (07 §1). */
export function revealCostFor(revealType: RevealType): number {
  switch (revealType) {
    case "email":
      return env.REVEAL_COST_EMAIL;
    case "phone":
      return env.REVEAL_COST_PHONE;
    case "full_profile":
      return env.REVEAL_COST_FULL_PROFILE;
  }
}

function revealedFieldsFor(revealType: RevealType, contact: ContactForReveal): string[] {
  const fields: string[] = [];
  if ((revealType === "email" || revealType === "full_profile") && contact.emailEnc)
    fields.push("email");
  if ((revealType === "phone" || revealType === "full_profile") && contact.phoneEnc)
    fields.push("phone");
  return fields;
}

function buildResponse(
  contact: ContactForReveal,
  revealType: RevealType,
  creditsCharged: number,
  balanceAfter: number,
  alreadyOwned: boolean,
): RevealResponse {
  const wantEmail = revealType === "email" || revealType === "full_profile";
  const wantPhone = revealType === "phone" || revealType === "full_profile";
  return {
    contactId: contact.id,
    reveal_type: revealType,
    email: wantEmail && contact.emailEnc ? decryptPii(contact.emailEnc) : null,
    phone: wantPhone && contact.phoneEnc ? decryptPii(contact.phoneEnc) : null,
    emailStatus: contact.emailStatus,
    creditsCharged,
    balanceAfter,
    alreadyOwned,
  };
}

export async function revealContact(input: RevealInput): Promise<RevealResponse> {
  const cost = revealCostFor(input.revealType);
  try {
    return await withTenantTx(input.scope, async (tx) => {
      const contact = await revealRepository.getContactForReveal(tx, input.contactId);
      if (!contact) throw new NotFoundError("Contact not found in this workspace.");

      // 0) compliance gate INSIDE the tx — unbypassable (08 §3).
      await assertNotSuppressed(tx, {
        contactId: contact.id,
        emailBlindIndex: contact.emailBlindIndex,
        emailDomain: contact.emailDomain,
      });

      // 1) idempotent reveal claim (per workspace copy, per reveal_type).
      const claimed = await revealRepository.claimReveal(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        contactId: contact.id,
        revealedByUserId: input.userId,
        revealType: input.revealType,
        dataSource: "internal",
        creditsConsumed: cost,
        revealedFields: revealedFieldsFor(input.revealType, contact),
      });

      // Already owned by this workspace copy → return the owned fields, charge 0 (free forever).
      if (!claimed) {
        const balance = await creditRepository.currentBalance(tx, input.scope.tenantId);
        return buildResponse(contact, input.revealType, 0, balance, true);
      }

      // 2) charge against the TENANT counter under FOR UPDATE; ROLLBACK leaves no reveal row behind.
      const balance = await creditRepository.lockBalance(tx, input.scope.tenantId);
      if (balance < cost) throw new InsufficientCreditsError(balance, cost);
      await creditRepository.decrement(tx, input.scope.tenantId, cost);

      await writeAudit(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        actorUserId: input.userId,
        action: "reveal",
        entityType: "contact",
        entityId: contact.id,
        metadata: {
          revealType: input.revealType,
          cost,
          fields: revealedFieldsFor(input.revealType, contact),
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });

      return buildResponse(contact, input.revealType, cost, balance - cost, false);
    });
  } catch (err) {
    // The suppression throw rolled the reveal tx back — record the blocked attempt in its OWN tx so the
    // audit survives (08 §3: attempts are audit-logged; M3 DoD).
    if (err instanceof SuppressedError) {
      await withTenantTx(input.scope, (tx) =>
        writeAudit(tx, {
          tenantId: input.scope.tenantId,
          workspaceId: input.scope.workspaceId,
          actorUserId: input.userId,
          action: "reveal.blocked",
          entityType: "contact",
          entityId: input.contactId,
          metadata: { revealType: input.revealType, reason: err.message },
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        }),
      );
    }
    throw err;
  }
}
