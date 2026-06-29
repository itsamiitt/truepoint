// dataRoutes.ts — the Data-management control panel's READ surface (database-management-research, Phase 1 /
// MVP). A cross-tenant data-ops rollup for the internal Database Management team: the job-status tally, recent
// bulk-import outcomes, and retention shadow-run evidence — composed from the SAME proven cross-tenant reads
// (platformAdminRepository.sampleJobStatuses / recentImportJobs / recentRetentionRuns) that back /system-health
// and /import-jobs. READ-ONLY: no mutations on this surface yet (the write tiers land in later phases).
//
// Mounted under adminRoutes at /data, so the parent authn + platformAdmin middleware already apply — every
// caller is a verified `pa` staff member. The granular gate here is requireCapability("data:read"). The
// cross-tenant read runs on the audited withPlatformTx (an `admin.data_overview` row in platform_audit_log,
// in the SAME tx) and is PLATFORM_READ_LIMIT-bounded. METADATA + tallies ONLY — the repo reads the import_jobs /
// retention_runs CONTROL tables, never import_job_rows, so no imported contact PII crosses the boundary
// (truepoint-security: a cross-tenant admin read exposes counts, not records).
import { PLATFORM_READ_LIMIT, platformAdminRepository, withPlatformTx } from "@leadwolf/db";
import { NotFoundError, ValidationError } from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";

// Accept any RFC-4122-shaped UUID (incl. the v7 ids this app mints) for path-param validation.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const dataRoutes = new Hono<{ Variables: ApiVariables }>();

const actorOf = (c: Context<{ Variables: ApiVariables }>) => ({
  userId: c.get("claims").sub,
  ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
});

// ── Data-Ops Overview (database-management-research 04 §UI / 14 Phase 0) — the cross-tenant data-operations
// rollup the new "Data management" area opens on. One audited withPlatformTx runs three bounded reads in
// parallel and tallies them in-process: the overall job-status sample (the historical queue-depth / dead-letter
// proxy, same source /system-health uses), recent bulk-import jobs (status mix + rejected-row sum), and recent
// retention RUNS (the shadow-mode evidence count operators review before any `enforce` flip). Tallies are over
// the bounded recent sample (the `truncated` flag says so) — a dedicated COUNT(*) GROUP BY aggregate is a
// follow-up; the bounded recent view is honest and matches the existing /system-health pattern. data:read-gated.
dataRoutes.get("/overview", requireCapability("data:read"), async (c) => {
  const overview = await withPlatformTx(actorOf(c), "admin.data_overview", async (tx) => {
    const [statuses, importJobs, retentionRuns] = await Promise.all([
      platformAdminRepository.sampleJobStatuses(tx),
      platformAdminRepository.recentImportJobs(tx),
      platformAdminRepository.recentRetentionRuns(tx),
    ]);

    // Overall job-status tally (same shape /system-health derives): queue depth = queued+running+estimating,
    // dead-letter = failed. A bounded sample, so `truncated` is true once it hits the platform read cap.
    const jobsByStatus: Record<string, number> = {};
    for (const s of statuses) jobsByStatus[s] = (jobsByStatus[s] ?? 0) + 1;
    const queueDepth =
      (jobsByStatus.queued ?? 0) + (jobsByStatus.running ?? 0) + (jobsByStatus.estimating ?? 0);

    // Recent bulk-import tally — status mix + total rejected rows across the recent sample (no row contents).
    const importByStatus: Record<string, number> = {};
    let rejectedRecent = 0;
    for (const j of importJobs) {
      importByStatus[j.status] = (importByStatus[j.status] ?? 0) + 1;
      rejectedRecent += j.rowsRejected ?? 0;
    }

    return {
      jobs: {
        sampleSize: statuses.length,
        truncated: statuses.length >= PLATFORM_READ_LIMIT,
        byStatus: jobsByStatus,
        queueDepth,
        deadLetter: jobsByStatus.failed ?? 0,
      },
      imports: {
        recentCount: importJobs.length,
        truncated: importJobs.length >= PLATFORM_READ_LIMIT,
        byStatus: importByStatus,
        rejectedRecent,
      },
      retention: {
        recentRuns: retentionRuns.length,
        truncated: retentionRuns.length >= PLATFORM_READ_LIMIT,
      },
    };
  });

  return c.json(overview);
});

// ── Import-job drill-down (database-management-research Phase 1D) — one bulk-import job's control-row metadata +
// denormalized outcome tallies + a per-status CHUNK tally, so an operator can see WHERE a job stalled or failed.
// METADATA + counts ONLY (import_jobs / import_job_chunks; NEVER import_job_rows) — no raw CSV `input` and no
// free-text `reject_reason` cross the boundary. data:read-gated; the read runs on the audited withPlatformTx
// (targets the job). The jobId is UUID-validated BEFORE the tx (a malformed id is a clean 422, no Postgres 22P02
// 500); an unknown id is a clean 404 after the tx (the lookup-attempt audit row is kept, matching /tenants/:id).
dataRoutes.get("/imports/:jobId", requireCapability("data:read"), async (c) => {
  const jobId = c.req.param("jobId");
  if (!UUID_RE.test(jobId)) throw new ValidationError("jobId must be a UUID");
  const detail = await withPlatformTx(
    actorOf(c),
    "admin.data_import_detail",
    (tx) => platformAdminRepository.importJobDetail(tx, jobId),
    { targetType: "import_job", targetId: jobId },
  );
  if (!detail) throw new NotFoundError("Import job not found.");
  return c.json(detail);
});
