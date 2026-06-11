// emailVerifier.ts — the email-verification port (06 §9): a DEDICATED, provider-independent verifier
// grades the address so a data provider never grades its own answer (backs ADR-0013's
// charge-only-for-valid + credit-back). The vendor (ZeroBounce/NeverBounce) is an open question (06 §11
// Q1); until one is wired, `passThroughVerifier` keeps the contact's stored status — meaning the
// 0-credit outcomes apply only to VERIFIER-determined results, exactly as 07 §3 frames them.

import type { EmailStatus } from "@leadwolf/types";

export interface EmailVerifierPort {
  name: string;
  verify(email: string, currentStatus: EmailStatus): Promise<EmailStatus>;
}

/** No vendor configured: keep the stored status (import/enrichment-supplied) unchanged. */
export const passThroughVerifier: EmailVerifierPort = {
  name: "pass_through",
  verify: (_email, currentStatus) => Promise.resolve(currentStatus),
};

/** Deterministic verifier for tests/fixtures: exact-email map with a default. */
export function staticVerifier(
  results: Record<string, EmailStatus>,
  fallback: EmailStatus = "unknown",
): EmailVerifierPort {
  return {
    name: "static_fixture",
    verify: (email) => Promise.resolve(results[email.toLowerCase()] ?? fallback),
  };
}
