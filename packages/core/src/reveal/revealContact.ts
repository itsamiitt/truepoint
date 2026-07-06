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
  contactChannelRepository,
  contactRepository,
  creditRepository,
  eventOutboxRepository,
  revealRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  EVENT_REVEAL_COMPLETED,
  type EmailStatus,
  InsufficientCreditsError,
  NotFoundError,
  type PhoneLineType,
  type PhoneStatus,
  type RevealResponse,
  type RevealType,
  SuppressedError,
} from "@leadwolf/types";
import { isChannelDualWriteEnabled } from "../channels/channelDualWrite.ts";
import { assertNotSuppressed } from "../compliance/assertNotSuppressed.ts";
import { writeAudit } from "../compliance/writeAudit.ts";
import { type EmailVerifierPort, passThroughVerifier } from "../data-health/emailVerifier.ts";
import type { PhoneVerifierPort } from "../data-health/phoneVerifier.ts";
import { defaultPhoneVerifier } from "../data-health/twilioPhoneVerifier.ts";
import { decryptPii } from "../import/encryptPii.ts";
import { revealCharge } from "./revealCharge.ts";

export interface RevealInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  contactId: string;
  revealType: RevealType;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The dedicated, provider-independent verifier (06 §9). Default keeps the stored status (no vendor yet). */
  verifier?: EmailVerifierPort;
  /** The phone verifier (06 §9). Default = config-gated Twilio Lookup, else the E.164 format check. */
  phoneVerifier?: PhoneVerifierPort;
  /**
   * How the credit charge is settled (07 §3, ADR-0029). `counter` (default, the single-reveal path): charge the
   * tenant counter now under FOR UPDATE + write the paired `spend` ledger entry — byte-identical to before.
   * `lease` (the async bulk-reveal job): the job has ALREADY reserved the worst-case ceiling off the counter
   * (one lease, not a per-row hot-lock), so this reveal only claims + records `credits_consumed` on the claim
   * (and returns the cost so the job can settle/release the aggregate) — it does NOT touch the counter here.
   */
  settleMode?: "counter" | "lease";
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
  phoneLineType: PhoneLineType | null;
}

/** Decrypt + verify OUTSIDE any transaction — never inside the FOR UPDATE window (14 §3.5). */
async function verifyForReveal(
  contact: ContactForReveal,
  revealType: RevealType,
  verifier: EmailVerifierPort,
  phoneVerifier: PhoneVerifierPort,
): Promise<VerifiedState> {
  const email = wantsEmail(revealType) && contact.emailEnc ? decryptPii(contact.emailEnc) : null;
  const phone = wantsPhone(revealType) && contact.phoneEnc ? decryptPii(contact.phoneEnc) : null;
  const emailStatus = email
    ? await verifier.verify(email, contact.emailStatus as EmailStatus)
    : (contact.emailStatus as EmailStatus);
  const phoneResult = phone ? await phoneVerifier.verify(phone, null) : null;
  return {
    email,
    phone,
    emailStatus,
    phoneStatus: phoneResult?.status ?? null,
    phoneLineType: phoneResult?.lineType ?? null,
  };
}

export async function revealContact(input: RevealInput): Promise<RevealResponse> {
  const verifier = input.verifier ?? passThroughVerifier;
  const phoneVerifier = input.phoneVerifier ?? defaultPhoneVerifier();

  // Pre-read the contact (fast scoped tx), then verify with no transaction open.
  const contact = await withTenantTx(input.scope, (tx) =>
    revealRepository.getContactForReveal(tx, input.contactId),
  );
  if (!contact) throw new NotFoundError("Contact not found in this workspace.");
  const verified = await verifyForReveal(contact, input.revealType, verifier, phoneVerifier);

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
      const verifiedAt = new Date();
      await contactRepository.update(tx, contact.id, {
        emailStatus: verified.emailStatus,
        ...(verified.phoneStatus ? { phoneStatus: verified.phoneStatus } : {}),
        ...(verified.phoneLineType ? { phoneLineType: verified.phoneLineType } : {}),
        lastVerifiedAt: verifiedAt,
      });

      // S-CH2 channel dual-write (05 §5): mirror the SAME grades just written flat onto the live PRIMARY
      // child row(s), in this same tx — the verify-update op keeps CH-INV-1's status half in step. Mirrors
      // the flat writes' own conditionality: email only when this reveal actually verified an email value;
      // phone only when the verifier graded one. No-op pre-backfill (no child rows yet — S-CH3's tail).
      // Gate-off: zero flag reads, zero child writes (T-CH parity). The row lock the update above took
      // already serializes concurrent same-contact reveals over these rows too.
      if (await isChannelDualWriteEnabled(tx, input.scope.tenantId)) {
        if (verified.email) {
          await contactChannelRepository.applyChannelWrite(tx, input.scope, {
            kind: "email_verify",
            contactId: contact.id,
            status: verified.emailStatus,
            lastVerifiedAt: verifiedAt,
          });
        }
        if (verified.phoneStatus || verified.phoneLineType) {
          await contactChannelRepository.applyChannelWrite(tx, input.scope, {
            kind: "phone_verify",
            contactId: contact.id,
            ...(verified.phoneStatus ? { status: verified.phoneStatus } : {}),
            lineType: verified.phoneLineType,
            lineTypeSource: verified.phoneLineType ? "carrier_lookup" : null,
            lastVerifiedAt: verifiedAt,
          });
        }
      }

      // Cross-reveal-type dedup (07 §3): read what this workspace already owns, then charge ONLY for the
      // field(s) this reveal NEWLY uncovers — a prior email reveal is never re-billed by a later full_profile
      // (and vice-versa). Read before the claim insert so it reflects prior ownership only. ADR-0013 grading
      // still applies to each new field (an unusable new field charges 0).
      //
      // CONCURRENCY (load-bearing): the `contactRepository.update` above row-locks THIS contact FOR UPDATE, so
      // two concurrent reveals of the SAME contact serialize here — the second blocks until the first commits
      // and therefore reads the first's claim in `ownedRevealFields` below. Do NOT move this ownership read
      // before that update, or make the update conditional, without another lock: it would reopen the
      // cross-type double-charge under concurrency (the per-(ws,contact,reveal_type) unique index only guards
      // the SAME reveal_type).
      const owned = await revealRepository.ownedRevealFields(
        tx,
        input.scope.workspaceId,
        contact.id,
      );
      const charge = revealCharge({
        revealType: input.revealType,
        hasEmail: contact.emailEnc != null,
        hasPhone: contact.phoneEnc != null,
        ownedEmail: owned.email,
        ownedPhone: owned.phone,
        emailStatus: verified.emailStatus,
        phoneStatus: verified.phoneStatus,
        costs: {
          email: env.REVEAL_COST_EMAIL,
          phone: env.REVEAL_COST_PHONE,
          full: env.REVEAL_COST_FULL_PROFILE,
        },
        chargeRisky: env.REVEAL_CHARGE_RISKY,
      });
      const cost = charge.cost;

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

      // 2) charge against the TENANT counter under FOR UPDATE — skipped entirely when the verified result is
      // unusable (cost 0): the claim row stays, recording the 0-credit outcome (07 §3). Also skipped in `lease`
      // mode (async bulk-reveal): the job already reserved the ceiling off the counter, so this reveal records
      // credits_consumed on the claim (done above) but leaves the counter to the job's aggregate settle/release.
      const settleMode = input.settleMode ?? "counter";
      let balanceAfter: number;
      if (cost > 0 && settleMode === "counter") {
        const { balance, subscriptionBalance } = await creditRepository.lockBalance(
          tx,
          input.scope.tenantId,
        );
        if (balance < cost) throw new InsufficientCreditsError(balance, cost);
        // Subscription-first (M11/ADR-0041): burn the perishable (resetting) bucket before purchased credits.
        const fromSubscription = Math.min(cost, subscriptionBalance);
        const fromPurchased = cost - fromSubscription;
        await creditRepository.decrement(tx, input.scope.tenantId, cost, fromSubscription);
        balanceAfter = balance - cost;
        // M11 ledger (ADR-0029): the paired `spend` entry, atomic with the counter decrement + INSIDE the
        // reveal's withTenantTx (app.current_tenant_id set → the ENABLE-RLS WITH CHECK passes). Idempotent on
        // (tenant, reveal:<reveal_id>); the reveal claim itself already prevents a double-charge (first-wins).
        await creditRepository.insertLedger(tx, {
          tenantId: input.scope.tenantId,
          workspaceId: input.scope.workspaceId,
          entryType: "spend",
          delta: -cost,
          balanceAfter,
          idempotencyKey: `reveal:${claimed.id}`,
          revealId: claimed.id,
          actorUserId: input.userId,
          reason: "reveal",
          metadata: { revealType: input.revealType, fromSubscription, fromPurchased },
        });
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
          newFields: charge.newFields,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      });

      // Realtime (ADR-0027): append the `reveal.completed` domain event IN this tx — crash-safe (commit ⇒
      // event enqueued). Only the single-reveal path (counter settle-mode) emits per-reveal; the bulk path
      // emits coalesced progress/credit events. Dark until REALTIME_SSE_ENABLED — while off nothing is appended
      // (no outbox accumulation). Skip a redundant already-owned re-reveal (nothing changed). PII-free payload.
      if (env.REALTIME_SSE_ENABLED && settleMode === "counter" && !charge.alreadyOwned) {
        await eventOutboxRepository.append(tx, {
          tenantId: input.scope.tenantId,
          workspaceId: input.scope.workspaceId,
          eventType: EVENT_REVEAL_COMPLETED,
          payload: {
            contactId: contact.id,
            revealType: input.revealType,
            creditsCharged: cost,
            alreadyOwned: charge.alreadyOwned,
            balanceAfter,
          },
        });
      }

      // alreadyOwned is true only when the reveal exposed NO new field (a redundant full_profile over an
      // already-owned email+phone still records the type claim but charges 0).
      return buildResponse(cost, balanceAfter, charge.alreadyOwned);
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
