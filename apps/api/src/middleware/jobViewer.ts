// jobViewer.ts — build the JobViewer for a job-surface request (import-and-data-model-redesign 10 §4.2
// rule 3: routes never assemble the predicate — they assemble the VIEWER from middleware outputs and pass
// it down; the ONE predicate lives in packages/db). This helper also owns the DUAL-GATE evaluation
// (S-V3): `scoped` = env.JOB_VISIBILITY_SCOPED (global kill-switch) AND the per-tenant
// `job_visibility_scoped` flag (fail-closed evaluator — unknown/unreadable flag ⇒ off ⇒ legacy
// workspace-wide visibility, never an error page). While either layer is off the viewer short-circuits the
// predicate to workspace-wide, byte-identically (T-V4) — and the env-off path performs ZERO extra queries,
// so the flag-off request is cost-identical too. The `scoped` branch is deleted at S-V6.
//
// Identity discipline (truepoint-security): `userId` comes from the VERIFIED token (claims.sub), never the
// body; `role` comes from requireRole's stash when the route ran the guard, else from a fresh ACTIVE
// membership lookup (never the client). A caller with no resolvable role is treated as the lowest tier
// (`viewer` — own-jobs-only under scoping); RLS remains the tenant wall underneath regardless.

import { env } from "@leadwolf/config";
import { isFlagEnabledForTenant } from "@leadwolf/core";
import { withTenantTx, workspaceRepository } from "@leadwolf/db";
import { JOB_VISIBILITY_FLAG_KEY, type JobViewer, type WorkspaceRole } from "@leadwolf/types";

export interface BuildJobViewerInput {
  tenantId: string;
  workspaceId: string;
  /** The verified token subject (claims.sub) — never a body/query value. */
  userId: string;
  /** The workspace role already resolved by requireRole (getWorkspaceRole), when the route ran the guard.
   *  Omit on guardless legacy routes — resolved here from the active membership ONLY when the gate is on. */
  role?: WorkspaceRole;
}

/** Evaluate the dual gate and assemble the viewer. Gate off (either layer) ⇒ `scoped: false`. */
export async function buildJobViewer(input: BuildJobViewerInput): Promise<JobViewer> {
  // LAYER 1 — global env kill-switch: off ⇒ no flag read, no role lookup, no behavior change at all.
  if (!env.JOB_VISIBILITY_SCOPED) {
    return { userId: input.userId, role: input.role ?? "viewer", scoped: false };
  }
  // LAYER 2 — per-tenant rollout flag (fail-closed: unknown flag evaluates off).
  const tenantEnabled = await withTenantTx({ tenantId: input.tenantId }, (tx) =>
    isFlagEnabledForTenant(tx, input.tenantId, JOB_VISIBILITY_FLAG_KEY),
  );
  if (!tenantEnabled) {
    return { userId: input.userId, role: input.role ?? "viewer", scoped: false };
  }
  const role =
    input.role ??
    (await workspaceRepository.getRoleForUser(input.tenantId, input.workspaceId, input.userId)) ??
    "viewer";
  return { userId: input.userId, role, scoped: true };
}
