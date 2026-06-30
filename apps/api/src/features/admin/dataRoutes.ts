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
import {
  PLATFORM_READ_LIMIT,
  platformAdminRepository,
  platformAdminWriteRepository,
  withPlatformTx,
} from "@leadwolf/db";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  approvalRequestViewSchema,
  createApprovalSchema,
  decideApprovalSchema,
} from "@leadwolf/types";
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

// One approval row as the repo returns it (PlatformApprovalRow), serialized to the shared ApprovalRequestView.
type ApprovalRow = Awaited<ReturnType<typeof platformAdminRepository.listPendingApprovals>>[number];

function toApprovalView(r: ApprovalRow) {
  return {
    id: r.id,
    operation: r.operation,
    params: (r.params ?? {}) as Record<string, unknown>,
    targetTenantId: r.targetTenantId,
    requestedByUserId: r.requestedByUserId,
    requestReason: r.requestReason,
    status: r.status,
    decidedByUserId: r.decidedByUserId,
    decisionReason: r.decisionReason,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    expiresAt: r.expiresAt.toISOString(),
    executedAt: r.executedAt ? r.executedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

// Shared approve/reject handler — the CHECKER path (data:review). The decision + its refusals all run INSIDE the
// withPlatformTx fn, so a refusal (not found / not pending / self-approval) throws and rolls the audit row back
// (the "no trace for an action that did not happen" discipline); only a real decision commits its audit row.
async function decideApprovalRoute(
  c: Context<{ Variables: ApiVariables }>,
  decision: "approved" | "rejected",
  action: string,
) {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = decideApprovalSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  const view = await withPlatformTx(
    actor,
    action,
    async (tx) => {
      const outcome = await platformAdminWriteRepository.decideApproval(
        tx,
        id,
        actor.userId,
        decision,
        parsed.data.reason,
      );
      if (!outcome.found) throw new NotFoundError("Approval request not found.");
      if (outcome.selfApproval)
        throw new ForbiddenError(
          "maker_checker",
          "You filed this request — it must be decided by a different operator (separation of duties).",
        );
      if (outcome.notPending) throw new ValidationError("This request is no longer pending.");
      return toApprovalView(outcome.row!);
    },
    { targetType: "approval_request", targetId: id, metadata: { decision } },
  );
  return c.json({ approval: approvalRequestViewSchema.parse(view) });
}

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

// ── Enrichment-run monitor (database-management-research 08, Phase 2 read slice) — recent bulk-enrichment jobs
// ACROSS all tenants: status / row tallies / credit spend / failures joined to the tenant name, newest-first +
// PLATFORM_READ_LIMIT-bounded. METADATA + cost ONLY (enrichment_jobs control table; NEVER enrichment_job_rows)
// — no enriched contact PII crosses the boundary. data:read-gated; the read runs on the audited withPlatformTx.
// The write actions (re-run / test-batch / preview-then-commit) land later behind data:manage + the approval flow.
dataRoutes.get("/enrichment/runs", requireCapability("data:read"), async (c) => {
  const runs = await withPlatformTx(actorOf(c), "admin.data_enrichment_runs", (tx) =>
    platformAdminRepository.recentEnrichmentJobs(tx),
  );
  return c.json({ runs });
});

// ── Verification-run monitor (database-management-research 08/10, Phase 2 read slice) — recent freshness
// re-verification runs ACROSS all tenants: scanned / reverified / errored + run window joined to the tenant name,
// newest-first + PLATFORM_READ_LIMIT-bounded. COUNTS only (verification_jobs ledger; no contact rows / PII).
// data:read-gated; the read runs on the audited withPlatformTx.
dataRoutes.get("/verification/runs", requireCapability("data:read"), async (c) => {
  const runs = await withPlatformTx(actorOf(c), "admin.data_verification_runs", (tx) =>
    platformAdminRepository.recentVerificationJobs(tx),
  );
  return c.json({ runs });
});

// ── Fleet data-quality view (database-management-research 10, gap G18) — recent per-workspace data-quality
// snapshots ACROSS all tenants: the daily WorkspaceDataQuality count rollup joined to the tenant name, newest-
// first + PLATFORM_READ_LIMIT-bounded. NON-PII (counts + present-flags + statuses; the UI derives rates).
// data:read-gated; the read runs on the audited withPlatformTx. This fills the "no fleet quality view" gap.
dataRoutes.get("/quality/snapshots", requireCapability("data:read"), async (c) => {
  const snapshots = await withPlatformTx(actorOf(c), "admin.data_quality_snapshots", (tx) =>
    platformAdminRepository.recentDataQualitySnapshots(tx),
  );
  return c.json({ snapshots });
});

// ── Maker-checker approvals (database-management-research 09) — the review queue + the request/approve/reject
// actions for high-risk Data-management ops. The MAKER files a request (data:manage); the CHECKER lists + decides
// (data:review). Separation of duties (requester != approver) is enforced server-side in decideApproval. Every
// mutation runs on the audited withPlatformTx (data.approval.*). PLATFORM staff data; params are operator-supplied
// op parameters (never imported PII). The op EXECUTION on approve (e.g. the retention-enforce flip) is wired
// per-op in a follow-up; this lands the request/decision lifecycle + its audit + the review queue.

/** File an approval request (the MAKER). data:manage. Audited `data.approval.request`. A pending request is
 *  hard-expired after 7 days (a worker-driven expiry sweep is a follow-up). */
dataRoutes.post("/approvals", requireCapability("data:manage"), async (c) => {
  const parsed = createApprovalSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const view = await withPlatformTx(
    actor,
    "data.approval.request",
    (tx) =>
      platformAdminWriteRepository
        .createApproval(tx, {
          operation: parsed.data.operation,
          params: parsed.data.params,
          targetTenantId: parsed.data.targetTenantId ?? null,
          requestedByUserId: actor.userId,
          requestReason: parsed.data.reason,
          expiresAt,
        })
        .then(toApprovalView),
    {
      targetType: "approval_request",
      tenantId: parsed.data.targetTenantId ?? undefined,
      metadata: { operation: parsed.data.operation },
    },
  );
  return c.json({ approval: approvalRequestViewSchema.parse(view) });
});

/** The review queue — pending requests (the CHECKER). data:review. Audited read. */
dataRoutes.get("/approvals", requireCapability("data:review"), async (c) => {
  const rows = await withPlatformTx(actorOf(c), "admin.data_approvals", (tx) =>
    platformAdminRepository.listPendingApprovals(tx),
  );
  return c.json({ approvals: approvalRequestViewSchema.array().parse(rows.map(toApprovalView)) });
});

/** Approve a pending request (the CHECKER; requester != approver enforced). data:review. */
dataRoutes.post("/approvals/:id/approve", requireCapability("data:review"), (c) =>
  decideApprovalRoute(c, "approved", "data.approval.approve"),
);

/** Reject a pending request (the CHECKER). data:review. */
dataRoutes.post("/approvals/:id/reject", requireCapability("data:review"), (c) =>
  decideApprovalRoute(c, "rejected", "data.approval.reject"),
);
