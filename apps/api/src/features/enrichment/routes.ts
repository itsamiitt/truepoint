// routes.ts — HTTP wiring for enrichment (09 §2). On-demand: POST /enrichment/:entity/:id runs the waterfall
// inline with the configured adapters injected (bulk/background work diverts to the `enrichment` worker queue,
// same core fn). Customer status surface (G-ENR-4, 06 §4.1): GET /enrichment/jobs[/:jobId] return the
// workspace's enrichment jobs with live status/progress/counts/failure-reason for the polling UI — READ-only.
// The one mutation on the /jobs surface is POST /jobs/:jobId/confirm — the confirm-before-spend gate (I3 / audit
// A3/P08) that releases a bulk-enrich run only after an admin accepts the worst-case ceiling; DARK behind a
// TWO-LAYER gate (the env BULK_ENRICHMENT_ENABLED master kill-switch + the bulk_enrichment_enabled per-tenant
// rollout flag). Transport only — cache, budget breaker, waterfall, persistence, and the status query
// live in core/db. The workspace is taken from the VERIFIED token via tenancy, never the request body (16 §7).

import { env } from "@leadwolf/config";
import {
  confirmBulkEnrichmentJob,
  enrichContact,
  getEnrichmentJobStatus,
  isFlagEnabledForTenant,
  listEnrichmentJobs,
} from "@leadwolf/core";
import { withTenantTx } from "@leadwolf/db";
import { defaultProviders } from "@leadwolf/integrations";
import {
  AppError,
  BULK_ENRICHMENT_FLAG_KEY,
  type EnrichmentJobDetailResponse,
  type EnrichmentJobListResponse,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  enrichmentJobDetailResponseSchema,
  enrichmentJobListResponseSchema,
  enrichmentRequestSchema,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { buildJobViewer } from "../../middleware/jobViewer.ts";
import { type RoleVariables, getWorkspaceRole, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const enrichmentRoutes = new Hono<{ Variables: RoleVariables }>();

enrichmentRoutes.use("*", authn);
enrichmentRoutes.use("*", tenancy);

// ── Customer-visible job-status surface (G-ENR-4) — READ-only; any active workspace role may view. ───────
// Registered BEFORE POST /:entity/:id so the literal `jobs` segment is never captured as an `:entity` param.

/** List the enrichment jobs visible to the viewer (most-recent first) with live status/progress/counts.
 *  The repo's jobVisibility predicate decides WHICH rows (import-redesign 10 §2.1), behind the S-V3 dual
 *  gate (env JOB_VISIBILITY_SCOPED + per-tenant flag; off ⇒ workspace-wide, byte-identical — T-V4). */
enrichmentRoutes.get("/jobs", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view enrichment jobs.");
  const viewer = await buildJobViewer({
    tenantId: c.get("tenantId"),
    workspaceId,
    userId: c.get("claims").sub,
    role: getWorkspaceRole(c),
  });
  const jobs = await listEnrichmentJobs({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    viewer,
  });
  const body: EnrichmentJobListResponse = { jobs };
  return c.json(enrichmentJobListResponseSchema.parse(body), 200);
});

/** One enrichment job's status detail — the SAME predicate as the list (10 §4.2 rule 2). 404 (never leak
 *  existence) when absent OR invisible to the viewer. */
enrichmentRoutes.get(
  "/jobs/:jobId",
  requireRole("owner", "admin", "member", "viewer"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId)
      throw new ForbiddenError("no_workspace", "Select a workspace to view enrichment jobs.");
    const viewer = await buildJobViewer({
      tenantId: c.get("tenantId"),
      workspaceId,
      userId: c.get("claims").sub,
      role: getWorkspaceRole(c),
    });
    const job = await getEnrichmentJobStatus({
      scope: { tenantId: c.get("tenantId"), workspaceId },
      viewer,
      jobId: c.req.param("jobId"),
    });
    if (!job) throw new NotFoundError("Enrichment job not found.");
    const body: EnrichmentJobDetailResponse = job;
    return c.json(enrichmentJobDetailResponseSchema.parse(body), 200);
  },
);

// ── Confirm-before-spend gate (prospect-database-platform I3 / audit A3/P08) ─────────────────────────────
// The ONLY door to a spending bulk-enrich run: promote a job awaiting_confirmation → running AFTER a workspace
// owner/admin accepts the persisted worst-case credit ceiling. A WRITE, so it sits in the /jobs group BEFORE
// POST /:entity/:id (the literal `jobs` segment is never captured as an `:entity`). Spend authority is
// owner/admin only — members/viewers may watch a job (GET) but may not release its spend.
enrichmentRoutes.post("/jobs/:jobId/confirm", requireRole("owner", "admin"), async (c) => {
  // LAYER 1 — GLOBAL kill-switch: while BULK_ENRICHMENT_ENABLED is false the confirm-before-spend pipeline is DARK
  // for everyone — the endpoint 403s, so no job can be promoted to `running` (and thus never reaches the worker/spend).
  if (!env.BULK_ENRICHMENT_ENABLED) {
    throw new ForbiddenError("bulk_enrichment_disabled", "Bulk enrichment is not enabled.");
  }
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to confirm enrichment.");
  const scope = { tenantId: c.get("tenantId"), workspaceId };
  // LAYER 2 — per-tenant rollout flag (bulk_enrichment_enabled): with the global switch on, a run is released ONLY
  // for a tenant explicitly enrolled via the feature-flag console. Fail-closed (default off) and checked BEFORE
  // confirm promotes the job to `running`, so a non-enrolled tenant can never release spend. Mirrors bulk import.
  const tenantEnabled = await withTenantTx(scope, (tx) =>
    isFlagEnabledForTenant(tx, scope.tenantId, BULK_ENRICHMENT_FLAG_KEY),
  );
  if (!tenantEnabled) {
    throw new ForbiddenError("bulk_enrichment_disabled", "Bulk enrichment is not enabled.");
  }
  const result = await confirmBulkEnrichmentJob({
    scope,
    jobId: c.req.param("jobId"),
  });
  if (result.outcome === "not_found") throw new NotFoundError("Enrichment job not found.");
  if (result.outcome === "not_awaiting") {
    // 409: the job is not awaiting confirmation (already running/settled, or it never armed the gate). Surface
    // the current status so the UI can reconcile without leaking anything beyond the job's own lifecycle state.
    throw new AppError({
      status: 409,
      code: "job_not_awaiting_confirmation",
      title: "Cannot confirm",
      detail: `Job is '${result.job.status}', not awaiting confirmation.`,
    });
  }
  // CONFIRMED → the drive is ALREADY committed. Phase 3 (ADR-0027 transactional outbox): the
  // awaiting_confirmation → running transition wrote its drive-publish intent into worker_outbox in the SAME
  // tx (enrichmentJobRepository.confirmAwaitingJob), so "DB commit ⇒ event published" — a crash after this
  // point can no longer strand a `running` job with no drive (the old commit-then-enqueue gap). The workers'
  // leaderless relay publishes it to BULK_ENRICHMENT_QUEUE with a stable jobId; spend release semantics are
  // unchanged (human confirm only, drive guards on `running`, ceiling + daily breaker cap each chunk).
  const body: EnrichmentJobDetailResponse = result.job;
  return c.json(enrichmentJobDetailResponseSchema.parse(body), 200);
});

enrichmentRoutes.post("/:entity/:id", requireRole("owner", "admin", "member"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before enriching.");
  if (c.req.param("entity") !== "contact") {
    throw new ValidationError("Only entity 'contact' is enrichable at M4 (accounts land later).");
  }

  const parsed = enrichmentRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError("Body must be { fields: EnrichField[] }.");

  const result = await enrichContact({
    scope: { tenantId: c.get("tenantId"), workspaceId },
    contactId: c.req.param("id"),
    fields: parsed.data.fields,
    providers: defaultProviders(),
    requestedByUserId: c.get("claims").sub,
  });
  return c.json(result, 200);
});
