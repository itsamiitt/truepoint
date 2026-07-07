// stepUpEligibility.ts — a pure, client-safe predicate mirroring what verifyStepUp (stepUp.ts) will ACCEPT,
// without importing any of its server-only machinery (next/headers, the DB, the limiter). verifyStepUp re-proves
// intent with the current PASSWORD or a current code from a verified TOTP factor — and nothing else. So a
// passwordless user (SSO/magic-link) who has not yet enrolled a verified TOTP factor cannot step up at all.
//
// AUTH-069: that same condition is a bootstrap trap — enrolling the FIRST factor is itself a step-up-gated
// action, so a passwordless-and-factorless user can never satisfy it. The MFA UI uses this to STOP offering an
// unusable "Begin setup" (whose step-up field asks for an authenticator code they cannot have) and instead point
// them at the real path: set a password first (via the reset flow), after which the password satisfies step-up.

/** Can this user satisfy the /account/security step-up gate right now? True iff they have a password OR a
 *  verified TOTP factor — the only two credentials verifyStepUp accepts. */
export function canStepUp(opts: { hasPassword: boolean; hasVerifiedTotp: boolean }): boolean {
  return opts.hasPassword || opts.hasVerifiedTotp;
}
