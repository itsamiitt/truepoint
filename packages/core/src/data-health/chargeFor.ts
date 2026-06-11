// chargeFor.ts — ADR-0013's charge-by-verified-result, as one pure function (07 §3): `valid` charges the
// full per-type cost; verifier-determined `invalid`/`catch_all`/`unknown` (and provider-miss) charge 0;
// `risky` is charged-but-flagged (configurable, default charge); `unverified` (no verifier ran) keeps the
// pre-verifier full charge. Phone charges only when a line type resolves.

import type { EmailStatus, PhoneStatus, RevealType } from "@leadwolf/types";

export interface ChargeInput {
  revealType: RevealType;
  baseCost: number;
  emailStatus: EmailStatus;
  phoneStatus?: PhoneStatus | null;
  chargeRisky: boolean;
}

const CHARGEABLE_PHONE: ReadonlySet<string> = new Set(["direct", "mobile", "hq", "valid"]);

export function chargeFor(input: ChargeInput): number {
  if (input.revealType === "phone") {
    return input.phoneStatus && CHARGEABLE_PHONE.has(input.phoneStatus) ? input.baseCost : 0;
  }
  // email | full_profile — the email result drives the charge (ADR-0013).
  switch (input.emailStatus) {
    case "valid":
    case "unverified": // pre-verifier behavior: charged until a verifier grades it (06 §11 Q1)
      return input.baseCost;
    case "risky":
      return input.chargeRisky ? input.baseCost : 0;
    case "invalid":
    case "catch_all":
    case "unknown":
      return 0;
  }
}
