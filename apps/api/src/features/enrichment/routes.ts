// routes.ts — HTTP wiring for enrichment (09 §2). On-demand: POST /enrichment/:entity/:id runs the waterfall
// inline with the configured adapters injected (bulk/background work diverts to the `enrichment` worker queue,
// same core fn). Customer status surface (G-ENR-4, 06 §4.1): GET /enrichment/jobs[/:jobId] return the
// workspace's enrichment jobs with live status/progress/counts/failure-reason for the polling UI — READ-only.
// The one mutation on the /jobs surface is POST /jobs/:jobId/confirm — the confirm-before-spend gate (I3 / audit
// A3/P08) that releases a bulk-enrich run only after an admin accepts the worst-case ceiling; DARK behind
// BULK_ENRICHMENT_ENABLED. Transport only — cache, budget breaker, waterfall, persistence, and the status query
// live in core/db. The workspace is taken from the VERIFIED token via tenancy, never the request body (16 §7).

import { env } from "@leadwolf/config";
import {
  confirmBulkEnrichmentJob,
  enrichContact,
  getEnrichmentJobStatus,
  listEnrichmentJobs,
} from "@leadwolf/core";
import { defaultProviders } from "@leadwolf/integrations";
import {
  AppError,
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
import { type RoleVariables, requireRole } from "../../middleware/requireRole.ts";
import { tenancy } from "../../middleware/tenancy.ts";

export const enrichmentRoutes = new Hono<{ Variables: RoleVariables }>();

enrichmentRoutes.use("*", authn);
enrichmentRoutes.use("*", tenancy);

// ── Customer-visible job-status surface (G-ENR-4) — READ-only; any active workspace role may view. ───────
// Registered BEFORE POST /:entity/:id so the literal `jobs` segment is never captured as an `:entity` param.

/** List this workspace's enrichment jobs (most-recent first) with live status/progress/counts. */
enrichmentRoutes.get("/jobs", requireRole("owner", "admin", "member", "viewer"), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to view enrichment jobs.");
  const jobs = await listEnrichmentJobs({
    scope: { tenantId: c.get("tenantId"), workspaceId },
  });
  const body: EnrichmentJobListResponse = { jobs };
  return c.json(enrichmentJobListResponseSchema.parse(body), 200);
});

/** One enrichment job's status detail. 404 (never leak existence) when not in the caller's workspace. */
enrichmentRoutes.get(
  "/jobs/:jobId",
  requireRole("owner", "admin", "member", "viewer"),
  async (c) => {
    const workspaceId = c.get("workspaceId");
    if (!workspaceId)
      throw new ForbiddenError("no_workspace", "Select a workspace to view enrichment jobs.");
    const job = await getEnrichmentJobStatus({
      scope: { tenantId: c.get("tenantId"), workspaceId },
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
  // GLOBAL kill-switch: while BULK_ENRICHMENT_ENABLED is false the confirm-before-spend pipeline is DARK for
  // everyone — the endpoint 403s, so no job can be promoted to `running` (and thus never reaches the worker/spend).
  if (!env.BULK_ENRICHMENT_ENABLED) {
    throw new ForbiddenError("bulk_enrichment_disabled", "Bulk enrichment is not enabled.");
  }
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace to confirm enrichment.");
  const result = await confirmBulkEnrichmentJob({
    scope: { tenantId: c.get("tenantId"), workspaceId },
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
