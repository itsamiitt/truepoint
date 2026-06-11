// validatePhone.ts — lightweight phone validation (06 §9): E.164-shaped format/region sanity without a
// vendor. Maps to phone_status `valid`/`invalid`; line-type resolution (direct/mobile/hq) needs a lookup
// provider and lands with the dedicated-verifier wiring. Charged only when a chargeable status resolves.

import type { PhoneStatus } from "@leadwolf/types";

const E164 = /^\+[1-9]\d{6,14}$/;

export function validatePhone(raw: string): PhoneStatus {
  const compact = raw.replace(/[\s().-]/g, "");
  return E164.test(compact) ? "valid" : "invalid";
}
