// tenantSuspension.ts — decide what a suspended tenant means for a session, and say so out loud (audit 32 §9E).
//
// THE GAP THIS CLOSES. `tenants.status` is set to 'suspended' by two paths — the staff break-glass route
// (super_admin + a consumed JIT elevation, whose own comment says "the action gates the whole tenant") and the
// dunning ladder's terminal state — and no runtime code read it. A suspended tenant's users kept their
// sessions, kept refreshing them, kept switching into the org, and kept every API route. USER suspension was
// enforced correctly all along; the TENANT-level control was not.
//
// WHY THIS SHIPS OBSERVE-FIRST. The correct behaviour is unambiguous, but enforcing it ejects every currently
// suspended tenant the moment it deploys — including any suspended for a stale, mistaken or long-resolved
// reason. That is customer-visible with no undo. So this follows the posture already used for
// BREACHED_PASSWORD_CHECK_AT_LOGIN and the entitlement gate's rollout: compute the decision always, log it
// always, refuse only when someone deliberately arms it. Reading the shadow marker for a week tells an operator
// the blast radius BEFORE anyone is locked out, which is the whole point.
//
// Kept pure — no env read, no DB, no I/O — so the caller injects `enforced` and this stays unit-testable.
// The env flag is read at the call site (see switchOrg.ts).

/** What to do about a membership whose tenant is not active. */
export interface SuspensionDecision {
  /** True only when enforcement is armed AND the tenant is not active. */
  refuse: boolean;
  /** True when the tenant is not active — regardless of enforcement. This is what makes the gap measurable. */
  suspended: boolean;
}

/**
 * Decide whether a tenant's status should block a session.
 *
 * `active` is the only permitted status: the vocabulary is `active|suspended|…`, and treating anything
 * unrecognised as permitted would let a future status silently become an access grant. Fail closed on the
 * classification, then let `enforced` decide whether that classification bites.
 */
export function tenantSuspensionDecision(
  tenantStatus: string | null | undefined,
  enforced: boolean,
): SuspensionDecision {
  const suspended = tenantStatus !== "active";
  return { suspended, refuse: suspended && enforced };
}

/** Is enforcement armed? Only the literal "true", matching the flag's declared contract. */
export function suspensionEnforced(flag: string | undefined): boolean {
  return flag === "true";
}

/**
 * The alertable marker for a session that touched a suspended tenant.
 *
 * `mode=shadow` means the request PROCEEDED and would have been refused under enforcement — that is the line an
 * operator counts to size the blast radius. `mode=enforce` means it was actually refused.
 *
 * Carries the tenant id and the status only. No user id, no email: this fires on an auth path, and an operator
 * sizing a rollout needs to know WHICH TENANTS are affected, not who was using them.
 */
export function tenantSuspensionLog(
  tenantId: string,
  tenantStatus: string | null | undefined,
  refused: boolean,
): string {
  const mode = refused ? "enforce" : "shadow";
  const verb = refused ? "refused" : "ALLOWED (would refuse once armed)";
  return `[tenant-suspension] mode=${mode} tenant=${tenantId} status=${tenantStatus ?? "null"} — ${verb}`;
}
