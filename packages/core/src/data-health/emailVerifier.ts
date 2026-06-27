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

/** Statuses a pure SMTP probe cannot resolve on its own — catch-all domains + provider-blocked lookups
 * (01 §5.2). The hybrid verifier escalates ONLY these to the secondary, so metered secondary spend is bounded. */
const NON_DECISIVE: ReadonlySet<EmailStatus> = new Set<EmailStatus>(["catch_all", "unknown"]);

/**
 * Compose two verifiers (06 §9, 01 §5.2). Run `primary`; if it returns a NON-DECISIVE status
 * (`catch_all`/`unknown`) and a `secondary` is given, consult `secondary` and prefer its result when it is
 * decisive — otherwise keep the primary's. This bounds the (metered) secondary to exactly the cases a pure
 * SMTP prober (Reacher) structurally cannot resolve, keeping commercial-verifier spend minimal.
 */
export function hybridVerifier(
  primary: EmailVerifierPort,
  secondary: EmailVerifierPort,
): EmailVerifierPort {
  return {
    name: `hybrid(${primary.name}+${secondary.name})`,
    async verify(email, currentStatus) {
      const first = await primary.verify(email, currentStatus);
      if (!NON_DECISIVE.has(first)) return first;
      const second = await secondary.verify(email, first);
      return NON_DECISIVE.has(second) ? first : second;
    },
  };
}
