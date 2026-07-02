// estimate.ts — the PURE worst-case credit estimate for an async bulk-reveal job (Phase 3). "Worst case" =
// every billable contact charges the full per-type cost (ADR-0013 means most charge 0 or less after dedup, so
// the lease over-reserves and the job RELEASES the unspent remainder). A contact is BILLABLE when it has at
// least one field to reveal for the type AND doesn't already own all of them (a first-reveal-wins claim = free).
// Pure + injected costs so it unit-tests with zero DB.

import type { RevealType } from "@leadwolf/types";

export interface RevealCandidate {
  hasEmail: boolean;
  hasPhone: boolean;
  ownedEmail: boolean;
  ownedPhone: boolean;
}

export interface RevealEstimate {
  totalContacts: number;
  billableContacts: number;
  alreadyOwnedContacts: number;
  projectedMaxCredits: number;
}

function billableFor(revealType: RevealType, c: RevealCandidate): boolean {
  const newEmail = c.hasEmail && !c.ownedEmail;
  const newPhone = c.hasPhone && !c.ownedPhone;
  if (revealType === "email") return newEmail;
  if (revealType === "phone") return newPhone;
  return newEmail || newPhone; // full_profile — anything un-owned to uncover
}

function hasFieldFor(revealType: RevealType, c: RevealCandidate): boolean {
  if (revealType === "email") return c.hasEmail;
  if (revealType === "phone") return c.hasPhone;
  return c.hasEmail || c.hasPhone;
}

/** Compute the worst-case estimate over the candidate set. `unitCost` = the per-type reveal cost (config). */
export function projectRevealEstimate(
  revealType: RevealType,
  candidates: RevealCandidate[],
  unitCost: number,
): RevealEstimate {
  let billable = 0;
  let alreadyOwned = 0;
  for (const c of candidates) {
    if (billableFor(revealType, c)) billable += 1;
    else if (hasFieldFor(revealType, c)) alreadyOwned += 1; // has the field but already owns it → free
  }
  return {
    totalContacts: candidates.length,
    billableContacts: billable,
    alreadyOwnedContacts: alreadyOwned,
    projectedMaxCredits: billable * Math.max(0, Math.trunc(unitCost)),
  };
}
