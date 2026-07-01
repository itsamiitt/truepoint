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
import { BUILTIN_VALIDATION_RULES, staffWorkspaceExport } from "@leadwolf/core";
import {
  PLATFORM_READ_LIMIT,
  platformAdminRepository,
  platformAdminWriteRepository,
  retentionClassPolicyRepository,
  withPlatformTx,
} from "@leadwolf/db";
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  approvalRequestViewSchema,
  bulkExportParamsSchema,
  createApprovalSchema,
  decideApprovalSchema,
  retentionEnforceParamsSchema,
  toggleValidationRuleSchema,
  upsertValidationRuleSchema,
  validationRuleSchema,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import type { ApiVariables } from "../../middleware/authn.ts";
import { requireCapability } from "../../middleware/requireCapability.ts";
import { bulkFileStore } from "../import/bulkStore.ts";

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

// One custom validation_rules row → the shared ValidationRule view (builtin=false; ISO dates).
type ValidationRuleRow = Awaited<
  ReturnType<typeof platformAdminRepository.listValidationRules>
>[number];

function toValidationRuleView(r: ValidationRuleRow) {
  return {
    id: r.id,
    name: r.name,
    field: r.field,
    checkType: r.checkType,
    config: (r.config ?? {}) as Record<string, unknown>,
    enabled: r.enabled,
    builtin: false,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// The built-in checks as ValidationRule views — always-on, read-only (builtin=true). A fixed epoch timestamp
// since they are code constants, not rows; the api prepends them to the custom rules in the list.
const BUILTIN_RULE_VIEWS = BUILTIN_VALIDATION_RULES.map((b) => ({
  id: b.id,
  name: b.name,
  field: b.field,
  checkType: b.checkType,
  config: b.config as Record<string, unknown>,
  enabled: true,
  builtin: true,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
}));

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
// rollup the new "Data management" area opens on. One audited withPlatformTx runs three reads in parallel: the
// overall enrichment job-status counts (an EXACT COUNT(*) GROUP BY — queue-depth / dead-letter proxy), recent
// bulk-import jobs (status mix + rejected-row sum, a bounded recent sample), and recent retention RUNS (the
// shadow-mode evidence count operators review before any `enforce` flip, a bounded recent sample). The job-status
// tally is now exact (the earlier COUNT(*) GROUP BY follow-up); imports/retention stay bounded-recent (the
// `truncated` flag says so), matching the /system-health pattern. data:read-gated.
dataRoutes.get("/overview", requireCapability("data:read"), async (c) => {
  const overview = await withPlatformTx(actorOf(c), "admin.data_overview", async (tx) => {
    const [statusCounts, importJobs, retentionRuns] = await Promise.all([
      platformAdminRepository.enrichmentJobStatusCounts(tx),
      platformAdminRepository.recentImportJobs(tx),
      platformAdminRepository.recentRetentionRuns(tx),
    ]);

    // Overall job-status tally — EXACT counts across all tenants (queue depth = queued+running+estimating,
    // dead-letter = failed). No longer a bounded sample: enrichmentJobStatusCounts is a COUNT(*) GROUP BY, so
    // the numbers are exact and there is no truncation flag to carry.
    const jobsByStatus: Record<string, number> = {};
    let jobsTotal = 0;
    for (const { status, count } of statusCounts) {
      jobsByStatus[status] = count;
      jobsTotal += count;
    }
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
        total: jobsTotal,
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

// ── Fleet data-quality view (database-management-research 10, gap G18) — the LATEST per-workspace data-quality
// snapshot ACROSS all tenants (one row per workspace = its CURRENT quality, not a mixed recent series — the
// flagged follow-up). The daily WorkspaceDataQuality count rollup joined to the tenant name, PLATFORM_READ_LIMIT-
// bounded. NON-PII (counts + present-flags + statuses; the UI derives rates). data:read-gated; the read runs on
// the audited withPlatformTx. This fills the "no fleet quality view" gap.
dataRoutes.get("/quality/snapshots", requireCapability("data:read"), async (c) => {
  const snapshots = await withPlatformTx(actorOf(c), "admin.data_quality_snapshots", (tx) =>
    platformAdminRepository.latestDataQualityPerWorkspace(tx),
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
dataRoutes.post("/approvals/:id/approve", requireCapability("data:review"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = decideApprovalSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const actor = actorOf(c);
  const view = await withPlatformTx(
    actor,
    "data.approval.approve",
    async (tx) => {
      const outcome = await platformAdminWriteRepository.decideApproval(
        tx,
        id,
        actor.userId,
        "approved",
        parsed.data.reason,
      );
      if (!outcome.found) throw new NotFoundError("Approval request not found.");
      if (outcome.selfApproval)
        throw new ForbiddenError(
          "maker_checker",
          "You filed this request — it must be decided by a different operator (separation of duties).",
        );
      if (outcome.notPending) throw new ValidationError("This request is no longer pending.");
      const row = outcome.row!;
      // EXECUTE the approved op IMMEDIATELY, in the SAME audited tx — a failed run rolls the approval back so the
      // decision and the effect are atomic. Only retention_enforce is wired today; a filed request for an unwired
      // op can't be approved until its feature ships (the throw rolls back). Bulk ops add a row-cap here.
      if (row.operation === "retention_enforce") {
        const p = retentionEnforceParamsSchema.safeParse(row.params);
        if (!p.success)
          throw new ValidationError(
            p.error.issues[0]?.message ?? "Invalid retention_enforce params",
          );
        // Arm real deletion for the class (the per-tenant retention_engine_enabled flag is still the outer gate).
        await retentionClassPolicyRepository.upsertPolicy(tx, {
          dataClass: p.data.dataClass,
          ttlDays: p.data.ttlDays,
          mode: "enforce",
        });
      } else if (row.operation === "bulk_export") {
        const p = bulkExportParamsSchema.safeParse(row.params);
        if (!p.success)
          throw new ValidationError(p.error.issues[0]?.message ?? "Invalid bulk_export params");
        // SECURITY-SENSITIVE (audit X3): cross-tenant PII decryption, gated by the EXPLICIT-scope suppression
        // filter (findMatchExplicit — the owner bypasses RLS). Audited via THIS approval's platform_audit_log row
        // (NOT per-contact credit-charged — admin egress by policy). The artifact is keyed to the approval id; a
        // separate data:export-gated route streams it. Flagged for security review.
        await staffWorkspaceExport(tx, {
          tenantId: p.data.tenantId,
          workspaceId: p.data.workspaceId,
          fileStore: bulkFileStore(),
          exportKey: `exports/staff/${id}.csv`,
        });
      } else {
        throw new ValidationError(
          `No executor is wired for '${row.operation}' yet — it can be filed but not approved until its feature ships.`,
        );
      }
      await platformAdminWriteRepository.markApprovalExecuted(tx, id);
      return toApprovalView({ ...row, status: "executed", executedAt: new Date() });
    },
    { targetType: "approval_request", targetId: id, metadata: { decision: "approved" } },
  );
  return c.json({ approval: approvalRequestViewSchema.parse(view) });
});

/** Reject a pending request (the CHECKER). data:review. */
dataRoutes.post("/approvals/:id/reject", requireCapability("data:review"), (c) =>
  decideApprovalRoute(c, "rejected", "data.approval.reject"),
);

// ── Data-quality validation rules (database-management-research 06) — the global rule set the import pipeline
// enforces (reject-on-fail). The built-in checks are code constants (read-only); staff author CUSTOM rules here.
// List = data:read; create/update/toggle/delete = data:manage. All writes run on the audited withPlatformTx
// (data.validation_rule.*). config carries the per-check settings (pattern / maxLength / allowed).

/** List the active rules — built-in checks + custom rules. data:read. */
dataRoutes.get("/validation/rules", requireCapability("data:read"), async (c) => {
  const custom = await withPlatformTx(actorOf(c), "admin.data_validation_rules", (tx) =>
    platformAdminRepository.listValidationRules(tx),
  );
  const rules = [...BUILTIN_RULE_VIEWS, ...custom.map(toValidationRuleView)];
  return c.json({ rules: validationRuleSchema.array().parse(rules) });
});

/** Create a custom rule (the rule-builder). data:manage. Audited data.validation_rule.create. */
dataRoutes.post("/validation/rules", requireCapability("data:manage"), async (c) => {
  const parsed = upsertValidationRuleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  const view = await withPlatformTx(
    actorOf(c),
    "data.validation_rule.create",
    (tx) =>
      platformAdminWriteRepository
        .createValidationRule(tx, {
          name: parsed.data.name,
          field: parsed.data.field,
          checkType: parsed.data.checkType,
          config: parsed.data.config,
          enabled: parsed.data.enabled,
        })
        .then(toValidationRuleView),
    {
      targetType: "validation_rule",
      metadata: { field: parsed.data.field, checkType: parsed.data.checkType },
    },
  );
  return c.json({ rule: validationRuleSchema.parse(view) });
});

/** Update a custom rule. data:manage. Audited. Built-in ids (builtin:*) are not UUIDs → a clean 422. */
dataRoutes.put("/validation/rules/:id", requireCapability("data:manage"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id))
    throw new ValidationError("id must be a UUID (built-in rules cannot be edited)");
  const parsed = upsertValidationRuleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "data.validation_rule.update",
    async (tx) => {
      const n = await platformAdminWriteRepository.updateValidationRule(tx, id, {
        name: parsed.data.name,
        field: parsed.data.field,
        checkType: parsed.data.checkType,
        config: parsed.data.config,
        enabled: parsed.data.enabled,
      });
      if (n === 0) throw new NotFoundError("Validation rule not found.");
    },
    { targetType: "validation_rule", targetId: id },
  );
  return c.json({ ok: true, id });
});

/** Enable/disable a custom rule. data:manage. Audited. */
dataRoutes.post("/validation/rules/:id/toggle", requireCapability("data:manage"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  const parsed = toggleValidationRuleSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message);
  await withPlatformTx(
    actorOf(c),
    "data.validation_rule.toggle",
    async (tx) => {
      const n = await platformAdminWriteRepository.setValidationRuleEnabled(
        tx,
        id,
        parsed.data.enabled,
      );
      if (n === 0) throw new NotFoundError("Validation rule not found.");
    },
    { targetType: "validation_rule", targetId: id, metadata: { enabled: parsed.data.enabled } },
  );
  return c.json({ ok: true, id, enabled: parsed.data.enabled });
});

/** Delete a custom rule (built-ins can't be deleted — they're code constants). data:manage. Audited. */
dataRoutes.delete("/validation/rules/:id", requireCapability("data:manage"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id))
    throw new ValidationError("id must be a UUID (built-in rules cannot be deleted)");
  await withPlatformTx(
    actorOf(c),
    "data.validation_rule.delete",
    async (tx) => {
      const n = await platformAdminWriteRepository.deleteValidationRule(tx, id);
      if (n === 0) throw new NotFoundError("Validation rule not found.");
    },
    { targetType: "validation_rule", targetId: id },
  );
  return c.json({ ok: true, id });
});

// ── Dedup / ER clerical-review surface (database-management-research 07). Recent match-links across all tenants;
// the matched person NAME is PII, so this is gated on data:review (the reviewer capability), NOT the PII-free
// data:read. Read-only foundation — the non-destructive merge/split actions (which mutate the system-owned master
// graph via withErTx) land next behind maker-checker approval. `pending` rows are the human-decision queue (fed by
// probabilistic ER, a later phase); `auto` rows are the deterministic resolutions, shown for oversight.

type MatchLinkRow = Awaited<
  ReturnType<typeof platformAdminRepository.listMatchLinksForReview>
>[number];

function toMatchLinkView(r: MatchLinkRow) {
  return {
    id: r.id,
    entityType: r.entityType,
    clusterId: r.clusterId,
    matchMethod: r.matchMethod,
    matchProbability: r.matchProbability != null ? Number(r.matchProbability) : null,
    reviewStatus: r.reviewStatus,
    isDuplicateOf: r.isDuplicateOf,
    resolvedAt: r.resolvedAt.toISOString(),
    name: r.personName,
  };
}

/** Recent ER match-links for clerical review. data:review (exposes the matched entity name). */
dataRoutes.get("/dedup/links", requireCapability("data:review"), async (c) => {
  const links = await withPlatformTx(actorOf(c), "admin.data_dedup_links", (tx) =>
    platformAdminRepository.listMatchLinksForReview(tx),
  );
  return c.json({ links: links.map(toMatchLinkView) });
});

/**
 * GET /admin/data/approvals/:id/export — stream a completed staff cross-tenant export artifact (Phase 2). data:export.
 * The artifact exists only for an EXECUTED bulk_export approval, and the key is the approval id (server-side), so a
 * client can't fetch an arbitrary object. Cross-tenant PII egress — already approval-gated + audited. (v1 buffers
 * the bounded file; streaming is a follow-up.)
 */
dataRoutes.get("/approvals/:id/export", requireCapability("data:export"), async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new ValidationError("id must be a UUID");
  let bytes: Uint8Array;
  try {
    const stream = await bulkFileStore().getObjectStream(`exports/staff/${id}.csv`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    bytes = Buffer.concat(chunks);
  } catch {
    throw new NotFoundError("Export artifact not found.");
  }
  c.header("content-type", "text/csv; charset=utf-8");
  c.header("content-disposition", `attachment; filename="staff-export-${id}.csv"`);
  // Merged-types fallout: c.body's Data type rejects a Buffer/Uint8Array here — hand it a fresh ArrayBuffer
  // slice (exact bytes; runtime behavior unchanged). See contacts-bulk export for the same shape.
  return c.body(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    200,
  );
});
