// revealContact.ts — THE monetized path (07 §3, H1/H2/H13): verify → gate → claim → charge → audit, the
// sequence documented identically in 07 §3 / 08 §3 / 09 §3.2. M4 adds ADR-0013 charge-by-verified-result:
// email/phone are verified BEFORE the charging transaction (verification is network I/O and must never
// lengthen the FOR UPDATE window — 14 §3.5), then the verified status sets the cost (`valid` charges,
// `invalid`/`catch_all`/`unknown` charge 0, `risky` is charged-but-flagged per config). Costs are
// config-injected placeholders (07 §1); keep the charging tx TINY.

import { env } from "@leadwolf/config";
import {
  type ContactForReveal,
  type TenantScope,
  contactRepository,
  creditRepository,
  revealRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  type EmailStatus,
  InsufficientCreditsError,
  NotFoundError,
  type PhoneStatus,
  type RevealResponse,
  type RevealType,
  SuppressedError,
} from "@leadwolf/types";
import { assertNotSuppressed } from "../compliance/assertNotSuppressed.ts";
import { writeAudit } from "../compliance/writeAudit.ts";
import { chargeFor } from "../data-health/chargeFor.ts";
import { type EmailVerifierPort, passThroughVerifier } from "../data-health/emailVerifier.ts";
import { validatePhone } from "../data-health/validatePhone.ts";
import { decryptPii } from "../import/encryptPii.ts";

export interface RevealInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  contactId: string;
  revealType: RevealType;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The dedicated, provider-independent verifier (06 §9). Default keeps the stored status (no vendor yet). */
  verifier?: EmailVerifierPort;
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

const wantsEmail = (t: RevealType): boolean => t === "email" || t === "full_profile";
const wantsPhone = (t: RevealType): boolean => t === "phone" || t === "full_profile";

function revealedFieldsFor(revealType: RevealType, contact: ContactForReveal): string[] {
  const fields: string[] = [];
  if (wantsEmail(revealType) && contact.emailEnc) fields.push("email");
  if (wantsPhone(revealType) && contact.phoneEnc) fields.push("phone");
  return fields;
}

interface VerifiedState {
  email: string | null;
  phone: string | null;
  emailStatus: EmailStatus;
  phoneStatus: PhoneStatus | null;
}

/** Decrypt + verify OUTSIDE any transaction — never inside the FOR UPDATE window (14 §3.5). */
async function verifyForReveal(
  contact: ContactForReveal,
  revealType: RevealType,
  verifier: EmailVerifierPort,
): Promise<VerifiedState> {
  const email = wantsEmail(revealType) && contact.emailEnc ? decryptPii(contact.emailEnc) : null;
  const phone = wantsPhone(revealType) && contact.phoneEnc ? decryptPii(contact.phoneEnc) : null;
  const emailStatus = email
    ? await verifier.verify(email, contact.emailStatus as EmailStatus)
    : (contact.emailStatus as EmailStatus);
  const phoneStatus = phone ? validatePhone(phone) : null;
  return { email, phone, emailStatus, phoneStatus };
}

export async function revealContact(input: RevealInput): Promise<RevealResponse> {
  const verifier = input.verifier ?? passThroughVerifier;
  const baseCost = revealCostFor(input.revealType);

  // Pre-read the contact (fast scoped tx), then verify with no transaction open.
  const contact = await withTenantTx(input.scope, (tx) =>
    revealRepository.getContactForReveal(tx, input.contactId),
  );
  if (!contact) throw new NotFoundError("Contact not found in this workspace.");
  const verified = await verifyForReveal(contact, input.revealType, verifier);

  // ADR-0013: the verified result sets the charge; an unusable result still returns (cost 0).
  const cost = chargeFor({
    revealType: input.revealType,
    baseCost,
    emailStatus: verified.emailStatus,
    phoneStatus: verified.phoneStatus,
    chargeRisky: env.REVEAL_CHARGE_RISKY,
  });

  const buildResponse = (
    creditsCharged: number,
    balanceAfter: number,
    alreadyOwned: boolean,
  ): RevealResponse => ({
    contactId: contact.id,
    reveal_type: input.revealType,
    email: verified.email,
    phone: verified.phone,
    emailStatus: verified.emailStatus,
    creditsCharged,
    balanceAfter,
    alreadyOwned,
  });

  try {
    return await withTenantTx(input.scope, async (tx) => {
      // 0) compliance gate INSIDE the tx — unbypassable (08 §3).
      await assertNotSuppressed(tx, {
        contactId: contact.id,
        emailBlindIndex: contact.emailBlindIndex,
        emailDomain: contact.emailDomain,
      });

      // Persist the verification outcome on the workspace copy (06 §9) whatever the charge turns out to be.
      // Stamp `last_verified_at` so the Data Health freshness clock resets (list-plan/06 §3.3) — a reveal
      // verifies the field(s), so the record is now freshly graded.
      await contactRepository.update(tx, contact.id, {
        emailStatus: verified.emailStatus,
        ...(verified.phoneStatus ? { phoneStatus: verified.phoneStatus } : {}),
        lastVerifiedAt: new Date(),
      });

      // 1) idempotent reveal claim (per workspace copy, per reveal_type) — records the charged amount.
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
        return buildResponse(0, balance, true);
      }

      // 2) charge against the TENANT counter under FOR UPDATE — skipped entirely when the verified
      // result is unusable (cost 0): the claim row stays, recording the 0-credit outcome (07 §3).
      let balanceAfter: number;
      if (cost > 0) {
        const balance = await creditRepository.lockBalance(tx, input.scope.tenantId);
        if (balance < cost) throw new InsufficientCreditsError(balance, cost);
        await creditRepository.decrement(tx, input.scope.tenantId, cost);
        balanceAfter = balance - cost;
      } else {
        balanceAfter = await creditRepository.currentBalance(tx, input.scope.tenantId);
      }

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
          emailStatus: verified.emailStatus,
          verifier: verifier.name,
          fields: revealedFieldsFor(input.revealType, contact),
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });

      return buildResponse(cost, balanceAfter, false);
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
