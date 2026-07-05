// artifactRoutes.ts — the PII-bearing import error-artifact download surface (import-and-data-model-redesign 10
// §5 row 5 / §2.1, 13 §4.2, step S-V5). A NEW router, kept OUT of routes.ts (the sibling verb surface) so the
// two slices never collide; mounted at /api/v1/imports from the feature index + app wiring. ONE route:
//
//   GET /imports/:jobId/artifacts/:kind   (kind ∈ repair | errors)
//
// The TIGHTEST gate in the program (10 §2.1): creator ∪ elevated, `shared_with_workspace` IGNORED (sharing
// shares metadata, never the PII artifacts), member+ role required, and — because this is a NEW endpoint — it is
// strict from birth regardless of the JOB_VISIBILITY_SCOPED dual gate. Every download writes an in-tx
// `import.artifact_downloaded` audit row (actor + jobId + kind + IP — the HubSpot who-downloaded precedent,
// 03 §5.1 [7]); a DENIED attempt writes nothing and 404s (no existence oracle — 13 §6 IDOR posture). An invalid
// `:kind` or a job with no such artifact key is a uniform 404, never a probe result.
//
// DELIVERY (S-V5): the gate + audit + object-key resolution land here; the bytes are delivered via a signed
// download URL (the shipped FileStore seam — 10 §5 row 5's literal "signed expiring URL"). S-S4 refines this to
// PROXIED-WITH-AUDIT streaming (13 §4.3 ruling M6), demoting the signed URL to a bounded fallback.

import { writeAudit } from "@leadwolf/core";
import { importJobRepository, withTenantTx } from "@leadwolf/db";
import { ForbiddenError, NotFoundError } from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { rateLimit } from "../../middleware/rateLimit.ts";
import { getWorkspaceRole, requireRole } from "../../middleware/requireRole.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { bulkFileStore } from "./bulkStore.ts";

export const importArtifactRoutes = new Hono<{ Variables: TenancyVariables }>();

importArtifactRoutes.use("*", authn);
importArtifactRoutes.use("*", tenancy);
importArtifactRoutes.use("*", rateLimit);

/** The closed artifact-kind vocabulary → the object-key column it resolves to on the durable job row. `errors`
 *  rides `options.errorReportKey` (the pair's second key — only one key column shipped in S-I1, 08). */
type ArtifactKind = "repair" | "errors";
const ARTIFACT_KINDS = new Set<ArtifactKind>(["repair", "errors"]);

/**
 * GET /imports/:jobId/artifacts/:kind — download an error artifact. member+ role gate (13 §6; viewers 403);
 * the creator-∪-elevated share-ignored predicate is applied INSIDE the repository read (getJobForArtifact); the
 * download is audited in the same tx that authorizes it. A stricter per-user download bucket (10 §7) is not yet
 * expressible — the shipped coarse `rateLimit` is applied; the dedicated bucket is CI/config-owed (drift note).
 */
importArtifactRoutes.get(
  "/:jobId/artifacts/:kind",
  requireRole("owner", "admin", "member"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId)
      throw new ForbiddenError("no_workspace", "Select a workspace before downloading artifacts.");
    const tenantId = c.get("tenantId");
    const scope = { tenantId, workspaceId };
    const jobId = c.req.param("jobId");
    const kind = c.req.param("kind");
    // Invalid kind = a closed-enum miss → 404 (never a probe result; 13 §6 enumeration resistance).
    if (!ARTIFACT_KINDS.has(kind as ArtifactKind)) throw new NotFoundError("Artifact not found.");

    const userId = c.get("claims").sub;
    // The viewer carries the REAL resolved role (requireRole stashed it) — the artifact predicate is
    // gate-independent, so `scoped` is irrelevant here (artifactVisibility ignores it); pass true.
    const viewer = { userId, role: getWorkspaceRole(c), scoped: true as const };
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    // ONE tx: the gated read + the in-tx download audit. A denied/absent job or a missing artifact key ⇒ 404
    // with NOTHING written (denials audit nothing but the denial itself — none is recorded).
    const objectKey = await withTenantTx(scope, async (tx) => {
      const job = await importJobRepository.getJobForArtifact(tx, viewer, jobId);
      // Belt-and-suspenders workspace check on top of RLS + the predicate (shipped bulkRoutes posture).
      if (!job || job.workspaceId !== workspaceId) return null;
      const key =
        kind === "repair"
          ? (job.rejectedArtifactKey ?? null)
          : ((job.options as { errorReportKey?: string } | null | undefined)?.errorReportKey ??
            null);
      if (!key) return null; // no artifact of this kind (never generated, or lifecycle-lapsed) ⇒ honest 404
      // The download is authorized — record it in the SAME tx before delivery (13 §4.2; never fire-and-forget).
      await writeAudit(tx, {
        tenantId,
        workspaceId,
        actorUserId: userId,
        action: "import.artifact_downloaded",
        entityType: "import_job",
        entityId: jobId,
        metadata: { kind }, // non-PII: the artifact kind only, never a key or row value
        ipAddress: ip,
        userAgent: c.req.header("user-agent") ?? null,
      });
      return key;
    });

    if (!objectKey) throw new NotFoundError("Artifact not found.");

    // S-V5 delivery: a signed download URL from the FileStore seam (dev diskFileStore → a bare file:// URL, no
    // signing/expiry — the honest dev gap; the prod S3 adapter signs + expires). S-S4 replaces this with proxied
    // streaming + the pinned CSV headers (13 §4.3).
    const url = await bulkFileStore().getSignedDownloadUrl(objectKey);
    return c.json({ url }, 200);
  },
);
