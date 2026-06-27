// phoneVerifier.ts — the phone-verification port (06 §9), the phone analog of emailVerifier. A dedicated,
// provider-independent verifier grades a phone number: the default keeps today's E.164 FORMAT check
// (validatePhone), and a configured provider (Twilio Lookup, twilioPhoneVerifier.ts) upgrades that to a
// CARRIER-CONFIRMED valid/invalid. Carrier LINE-TYPE (mobile/landline/voip — the TCPA-gating signal, 01 §5.3)
// needs a dedicated phone_line_type column (a drizzle migration) + Twilio's paid line_type_intelligence add-on;
// that is the migration-gated follow-up (13 §6 item 1). This port returns ONLY a PhoneStatus — no lossy squeeze
// of carrier line types into the direct/mobile/hq enum.

import type { PhoneStatus } from "@leadwolf/types";
import { validatePhone } from "./validatePhone.ts";

export interface PhoneVerifierPort {
  name: string;
  /** Grade an E.164 phone; `currentStatus` is the stored grade (returned unchanged when a provider can't decide). */
  verify(phoneE164: string, currentStatus: PhoneStatus | null): Promise<PhoneStatus>;
}

/** No provider configured: the E.164 FORMAT check only (validatePhone) — today's behaviour, the floor. */
export const formatOnlyPhoneVerifier: PhoneVerifierPort = {
  name: "format_only",
  verify: (phone) => Promise.resolve(validatePhone(phone)),
};

/** Deterministic verifier for tests/fixtures: exact-number map with a default. */
export function staticPhoneVerifier(
  results: Record<string, PhoneStatus>,
  fallback: PhoneStatus = "unknown",
): PhoneVerifierPort {
  return {
    name: "static_fixture",
    verify: (phone) => Promise.resolve(results[phone] ?? fallback),
  };
}
