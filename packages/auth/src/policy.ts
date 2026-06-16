// policy.ts — resolve the effective auth policy across tenant + workspace scopes, STRICTEST-WINS
// (ADR-0018). A workspace may only tighten the tenant policy, never relax it; MFA enforcement escalates.

import type { AuthMethod, AuthPolicy, MfaEnforcement } from "@leadwolf/types";

const MFA_RANK: Record<MfaEnforcement, number> = { off: 0, optional: 1, required: 2 };

/** The strictest of the supplied enforcement levels (a parent `required` always wins). */
export function strictestMfa(...levels: Array<MfaEnforcement | undefined>): MfaEnforcement {
  let acc: MfaEnforcement = "off";
  for (const l of levels) if (l && MFA_RANK[l] > MFA_RANK[acc]) acc = l;
  return acc;
}

// Allowlist intersection models "must satisfy both scopes"; an empty scope imposes no restriction.
function tighten(tenant: string[], workspace?: string[]): string[] {
  if (!workspace || workspace.length === 0) return tenant;
  if (tenant.length === 0) return workspace;
  return tenant.filter((c) => workspace.includes(c));
}

function intersectMethods(tenant: AuthMethod[], workspace?: AuthMethod[]): AuthMethod[] {
  return workspace ? tenant.filter((m) => workspace.includes(m)) : tenant;
}

function minDefined(a?: number, b?: number): number | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

/** Effective policy a login/refresh must satisfy. Booleans can only become more restrictive. */
export function resolveEffectivePolicy(
  tenant: AuthPolicy,
  workspace?: Partial<AuthPolicy>,
): AuthPolicy {
  return {
    mfaEnforcement: strictestMfa(tenant.mfaEnforcement, workspace?.mfaEnforcement),
    allowedMethods: intersectMethods(tenant.allowedMethods, workspace?.allowedMethods),
    disableSocial: tenant.disableSocial || (workspace?.disableSocial ?? false),
    requireSso: tenant.requireSso || (workspace?.requireSso ?? false),
    ipAllowlist: tighten(tenant.ipAllowlist, workspace?.ipAllowlist),
    sessionTimeoutSeconds: minDefined(
      tenant.sessionTimeoutSeconds,
      workspace?.sessionTimeoutSeconds,
    ),
  };
}

/** Whether a login method is permitted under the effective policy. */
export function isMethodAllowed(policy: AuthPolicy, method: AuthMethod): boolean {
  if (policy.requireSso && method !== "sso") return false;
  if (policy.disableSocial && method === "oauth") return false;
  return policy.allowedMethods.includes(method);
}
