// phoneVerifier.ts — the phone-verification port (06 §9), the phone analog of emailVerifier. A dedicated,
// provider-independent verifier grades a phone number AND classifies its carrier line type: the default keeps
// today's E.164 FORMAT check (validatePhone) with no line type, and a configured provider (Twilio Lookup,
// twilioPhoneVerifier.ts) upgrades that to a CARRIER-CONFIRMED valid/invalid + the line type (mobile/landline/
// voip — the TCPA-gating signal, 01 §5.3). The line type is stored separately in contacts.phone_line_type, so
// nothing is lossily squeezed into the direct/mobile/hq phone_status enum.

import type { PhoneLineType, PhoneStatus } from "@leadwolf/types";
import { validatePhone } from "./validatePhone.ts";

/** A phone verifier's verdict: the reachability/format STATUS + the carrier LINE TYPE (null when unclassified). */
export interface PhoneVerifyResult {
  status: PhoneStatus;
  lineType: PhoneLineType | null;
}

export interface PhoneVerifierPort {
  name: string;
  /** Grade an E.164 phone; `currentStatus` is the stored grade (used by a provider that can fall back). */
  verify(phoneE164: string, currentStatus: PhoneStatus | null): Promise<PhoneVerifyResult>;
}

/** No provider configured: the E.164 FORMAT check only (validatePhone), no line type — today's behaviour. */
export const formatOnlyPhoneVerifier: PhoneVerifierPort = {
  name: "format_only",
  verify: (phone) => Promise.resolve({ status: validatePhone(phone), lineType: null }),
};

/** Deterministic verifier for tests/fixtures: exact-number → status map with a default; never a line type. */
export function staticPhoneVerifier(
  results: Record<string, PhoneStatus>,
  fallback: PhoneStatus = "unknown",
): PhoneVerifierPort {
  return {
    name: "static_fixture",
    verify: (phone) => Promise.resolve({ status: results[phone] ?? fallback, lineType: null }),
  };
}
