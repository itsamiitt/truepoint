// createGrant.ts — the G02 create-grant enforcement for job-CREATING import verbs (import-redesign 10 §3,
// S-V4): upload, preview (a draft-phase verb rides the create grant, 10 §2.1), one-shot submit, bulk
// submit — and, later, retry-failed (08 S-I10). RIDES THE SAME DUAL GATE as visibility scoping
// (JOB_VISIBILITY_SCOPED env + per-tenant job_visibility_scoped flag) so a tenant's behavior changes once
// (10 §Rollout): while the gate is off this middleware is a pure pass-through — today's zero-gate posture,
// byte-identical (T-V4). With the gate on:
//   • role below member  → 403 `insufficient_role` (the shipped requireRole slug);
//   • member under a `who_can_import='admin'` policy → 403 `import_disabled_by_policy` (10 §API);
//   • admin/owner → allowed under either policy.
// The verdict itself is the PURE core matrix (evaluateImportCreateGrant) — this file only resolves the
// viewer (verified token + ACTIVE membership, never the client) and the resolved policy, and maps the
// verdict to RFC-9457 problems. In-flight jobs are untouched — the policy gates CREATION only (10 §Edge).

import { evaluateImportCreateGrant } from "@leadwolf/core";
import { importPolicyRepository } from "@leadwolf/db";
import { ForbiddenError } from "@leadwolf/types";
import type { MiddlewareHandler } from "hono";
import { buildJobViewer } from "../../middleware/jobViewer.ts";

/** Guard a job-creating import verb by the G02 grant, behind the visibility dual gate. */
export function requireImportCreateGrant(): MiddlewareHandler {
  return async (c, next) => {
    const workspaceId = c.get("workspaceId") as string | undefined;
    if (!workspaceId)
      throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
    const tenantId = c.get("tenantId") as string;
    const claims = c.get("claims") as { sub: string };

    // Dual gate: off ⇒ pass-through (zero extra queries on the env-off path — buildJobViewer short-circuits).
    const viewer = await buildJobViewer({ tenantId, workspaceId, userId: claims.sub });
    if (!viewer.scoped) return next();

    const policy = await importPolicyRepository.resolved({ tenantId, workspaceId });
    const verdict = evaluateImportCreateGrant(viewer.role, policy.whoCanImport);
    if (verdict === "insufficient_role") {
      throw new ForbiddenError("insufficient_role", "Your role does not allow creating imports.");
    }
    if (verdict === "disabled_by_policy") {
      throw new ForbiddenError(
        "import_disabled_by_policy",
        "Imports are admin-managed in this workspace.",
      );
    }
    await next();
  };
}
