// policyShadow.ts — SHADOW validation of the effective-policy engine against the live tenant_auth_policies the
// login gates enforce today. Reads BOTH, emits a match/mismatch/error SLI, and enforces NOTHING. This is the
// SAFE first step of the finalize-login switch (doc 11 §3, doc 12): prove the engine resolves to the SAME policy
// on REAL login traffic before any cutover. The caller gates it behind AUTH_POLICY_SHADOW_ENABLED and invokes it
// DETACHED (never awaited); shadowComparePolicy is additionally fully try/caught, so it can neither slow nor
// break a login. A `mismatch` means a cutover WOULD change enforcement for that login — the number to review
// before flipping — whether from a backfill gap or a (legitimate) new platform default; either way, on-call
// inspects it first.

import { authPolicyRepository, effectivePolicyRepository } from "@leadwolf/db";
import type { AuthPolicy } from "@leadwolf/types";
import { recordAuthMetric } from "./authMetrics.ts";
import { resolvePolicyFromRows } from "./policy.ts";

// The code floor the resolver composes platform/org rows onto. MUST mirror authPolicyRepository's DEFAULT_POLICY
// (the same default getForEnforcement returns for an unconfigured tenant) so an unconfigured tenant with no
// engine rows and no platform default compares EQUAL on both sides.
const FLOOR: AuthPolicy = {
  mfaEnforcement: "optional",
  allowedMethods: ["password", "oauth", "magic_link", "sso", "passkey"],
  disableSocial: false,
  requireSso: false,
  ipAllowlist: [],
};

/** Order-insensitive compare of the two array policy fields (allowedMethods / ipAllowlist are sets, not lists). */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((x) => seen.has(x));
}

/** True when the two policies agree on every ENFORCEMENT-relevant field (arrays as sets; an absent optional
 *  timeout equals an absent one). What the login gates actually consult — the thing a cutover would change. */
export function policiesEquivalent(a: AuthPolicy, b: AuthPolicy): boolean {
  return (
    a.mfaEnforcement === b.mfaEnforcement &&
    a.disableSocial === b.disableSocial &&
    a.requireSso === b.requireSso &&
    (a.sessionTimeoutSeconds ?? null) === (b.sessionTimeoutSeconds ?? null) &&
    (a.idleTimeoutSeconds ?? null) === (b.idleTimeoutSeconds ?? null) &&
    sameSet(a.allowedMethods, b.allowedMethods) &&
    sameSet(a.ipAllowlist, b.ipAllowlist)
  );
}

/**
 * Compare the effective-policy engine's resolved policy to the live tenant_auth_policies enforcement policy and
 * record the outcome as an SLI. Enforces nothing. Safe to call unawaited: every failure is caught and recorded
 * as `error`, never thrown, so a shadow-read fault can't affect the login it runs alongside.
 */
export async function shadowComparePolicy(scope: {
  tenantId: string;
  workspaceId?: string;
}): Promise<void> {
  try {
    const [{ policy: livePolicy }, rows] = await Promise.all([
      authPolicyRepository.getForEnforcement(scope.tenantId),
      effectivePolicyRepository.getScopeRows(scope),
    ]);
    const enginePolicy = resolvePolicyFromRows(rows, scope.workspaceId, FLOOR);
    recordAuthMetric("auth_policy_shadow_total", {
      result: policiesEquivalent(livePolicy, enginePolicy) ? "match" : "mismatch",
    });
  } catch {
    recordAuthMetric("auth_policy_shadow_total", { result: "error" });
  }
}
