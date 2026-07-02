// revealCharge.ts — field-aware reveal cost (07 §3, ADR-0013 + the cross-reveal-type dedup fix). A reveal
// charges ONLY for the field(s) it newly uncovers: the workspace never re-pays for a field a prior reveal of
// ANY type already owns. This closes the double-charge where `email` then `full_profile` (or vice-versa) both
// billed the email field — the claim key is per (workspace, contact, reveal_type), so those were two charges
// covering the same field. Field ownership: email ⇐ an email|full_profile claim; phone ⇐ a phone|full_profile
// claim. Pricing is preserved: when BOTH fields are new the `full_profile` bundle price applies (the existing,
// email-driven `chargeFor` behaviour); only a PARTIAL reveal (one field already owned) decomposes to the
// single-field price. Pure + injected costs so it unit-tests with zero DB.

import type { EmailStatus, PhoneStatus, RevealType } from "@leadwolf/types";
import { chargeFor } from "../data-health/chargeFor.ts";

export interface RevealChargeInput {
  revealType: RevealType;
  /** The workspace copy actually carries email/phone ciphertext (nothing to reveal/charge otherwise). */
  hasEmail: boolean;
  hasPhone: boolean;
  /** This workspace already owns a reveal claim covering the field (any reveal_type, any prior cost). */
  ownedEmail: boolean;
  ownedPhone: boolean;
  /** Verified grades driving ADR-0013 charge-by-verified-result. */
  emailStatus: EmailStatus;
  phoneStatus: PhoneStatus | null;
  /** Per-type placeholder costs from config (07 §1) — never hardcoded here. */
  costs: { email: number; phone: number; full: number };
  chargeRisky: boolean;
}

export interface RevealChargeResult {
  /** Credits to charge for this reveal (0 when nothing new, or the new field(s) graded unusable). */
  cost: number;
  /** True when the reveal exposes NO new field (everything wanted was already owned) → a free re-reveal. */
  alreadyOwned: boolean;
  /** The field(s) this reveal newly exposes (drives the claim's revealed_fields + audit). */
  newFields: string[];
}

/** Compute the field-aware charge for a reveal, given what the workspace already owns. */
export function revealCharge(input: RevealChargeInput): RevealChargeResult {
  const wantEmail =
    (input.revealType === "email" || input.revealType === "full_profile") && input.hasEmail;
  const wantPhone =
    (input.revealType === "phone" || input.revealType === "full_profile") && input.hasPhone;

  const newEmail = wantEmail && !input.ownedEmail;
  const newPhone = wantPhone && !input.ownedPhone;

  const newFields: string[] = [];
  if (newEmail) newFields.push("email");
  if (newPhone) newFields.push("phone");

  let cost = 0;
  if (newEmail && newPhone) {
    // Both fields new → the full_profile bundle price (email-driven, unchanged from today's chargeFor).
    cost = chargeFor({
      revealType: "full_profile",
      baseCost: input.costs.full,
      emailStatus: input.emailStatus,
      phoneStatus: input.phoneStatus,
      chargeRisky: input.chargeRisky,
    });
  } else if (newEmail) {
    cost = chargeFor({
      revealType: "email",
      baseCost: input.costs.email,
      emailStatus: input.emailStatus,
      chargeRisky: input.chargeRisky,
    });
  } else if (newPhone) {
    cost = chargeFor({
      revealType: "phone",
      baseCost: input.costs.phone,
      emailStatus: input.emailStatus,
      phoneStatus: input.phoneStatus,
      chargeRisky: input.chargeRisky,
    });
  }

  return { cost, alreadyOwned: newFields.length === 0, newFields };
}
