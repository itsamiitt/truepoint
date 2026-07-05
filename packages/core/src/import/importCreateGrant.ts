// importCreateGrant.ts — the G02 "import at all" grant decision (import-and-data-model-redesign 10 §3,
// S-V4). PURE: role + policy in, verdict out — the ONE place the grant matrix lives, so the API middleware
// and the tests can never disagree. Enforcement rides the SAME dual gate as visibility (a tenant's behavior
// changes once, 10 §Rollout): the caller evaluates the gate first and only consults this when scoping is
// active; gate off ⇒ today's zero-gate posture, byte-identical.
//
// The matrix (10 §2.1 Create row + §3):
//   • viewer                       → denied (viewer is a read-only role product-wide)   → insufficient_role
//   • member under policy 'member' → allowed (the market broad default)
//   • member under policy 'admin'  → denied (governed workspace)                        → disabled_by_policy
//   • admin / owner                → allowed under either policy
// Role is always resolved server-side from the ACTIVE membership; policy comes from
// importPolicyRepository.resolved (stored row or the member-broad default).

import type { WhoCanImport, WorkspaceRole } from "@leadwolf/types";

export type ImportCreateGrantVerdict = "ok" | "insufficient_role" | "disabled_by_policy";

/** Decide whether `role` may run a job-CREATING import verb under the workspace's policy. */
export function evaluateImportCreateGrant(
  role: WorkspaceRole,
  whoCanImport: WhoCanImport,
): ImportCreateGrantVerdict {
  if (role === "owner" || role === "admin") return "ok";
  if (role === "viewer") return "insufficient_role";
  // member
  return whoCanImport === "admin" ? "disabled_by_policy" : "ok";
}
