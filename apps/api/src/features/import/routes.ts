// routes.ts — HTTP wiring for the import feature (05 §3). POST accepts a multipart upload (the CSV/XLSX file +
// a JSON column mapping + the source + an optional target listId), parses it on the request thread, then
// ENQUEUES the parsed rows onto the `imports` queue and returns 202 + a job ref — the heavy per-row dedup/
// encrypt/DB work runs in the apps/workers consumer (processImport → the SAME packages/core runImport). This
// file does only transport (parse the request, enqueue, shape the response) and no business logic. The
// workspace is taken from the VERIFIED token via the tenancy middleware, never the request body (16 §7); the
// client-supplied listId is validated against that workspace before enqueue (list-plan D4 — never trusted).

import { randomUUID } from "node:crypto";
import { assertListInWorkspace, buildImportPreview, parseImportFile } from "@leadwolf/core";
import { type ImportJobRow, importJobRepository, withTenantTx } from "@leadwolf/db";
import {
  type ColumnMapping,
  DEFAULT_CONFLICT_POLICY,
  ForbiddenError,
  type ImportFastInput,
  type ImportJobRef,
  type ImportJobStatus,
  type ImportJobStatusResponse,
  type ImportPreview,
  type ImportProgress,
  type ImportSummary,
  ImportValidationError,
  NotFoundError,
  type SourceName,
  columnMappingSchema,
  conflictPolicy,
  importProgressSchema,
  importSummarySchema,
  importTargetSchema,
  sourceName,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { buildJobViewer } from "../../middleware/jobViewer.ts";
import { rateLimit } from "../../middleware/rateLimit.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { enqueueFastImport } from "./bulkQueue.ts";
import { requireImportCreateGrant } from "./createGrant.ts";
import { isImportV2Enabled } from "./importV2Gate.ts";
import { enqueueImport, getImportJob } from "./queue.ts";
import { admittedImportFormData, readAdmittedImportContent } from "./uploadAdmission.ts";

export const importRoutes = new Hono<{ Variables: TenancyVariables }>();

importRoutes.use("*", authn);
importRoutes.use("*", tenancy);
importRoutes.use("*", rateLimit);

/** Map a BullMQ job state to the public import status enum. */
function toImportJobStatus(state: string): ImportJobStatus {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "active":
      return "active";
    case "waiting":
    case "waiting-children":
    case "delayed":
    case "prioritized":
      return "queued";
    default:
      return "unknown";
  }
}

// ── Import v2 (S-I3, dual-gated): the durable-row read model in the LEGACY response shape ────────────────
// While the compatibility window is open (08 §1.2), gate-on responses keep the shipped transport contract
// byte-shape-identical — old clients never see the 12-state vocabulary. The real v2 DTOs ship with S-I4.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 08 §2.4 legacy status mapping: v2 durable states → the shipped public enum. `cancelled → failed` with
 *  failedReason "cancelled" (the legacy enum predates the verb); draft/uploading never occur in Phase A. */
function toLegacyStatusV2(status: string): ImportJobStatus {
  switch (status) {
    case "queued":
    case "deferred":
    case "draft":
    case "uploading":
      return "queued";
    case "validating":
    case "staged":
    case "running":
    case "paused":
      return "active";
    case "completed":
    case "partial":
      return "completed";
    case "failed":
    case "cancelled":
      return "failed";
    default:
      return "unknown";
  }
}

/** Build the legacy poll response from the DURABLE row (G03's fix: the DB answers for the row's lifetime,
 *  never `Job.getState()`). Progress/summary derive from the atomic counters; the rejected-row DETAIL
 *  (errors/rejectedRows) is not persisted on the non-PII control plane — it arrives with the S-I7 artifact
 *  pair, so gate-on terminal summaries carry counts + histogram with empty detail arrays. */
function toLegacyResponseV2(job: ImportJobRow): ImportJobStatusResponse {
  const status = toLegacyStatusV2(job.status);
  const processed =
    job.rowsCreated +
    job.rowsMatched +
    job.rowsDuplicate +
    job.rowsSkipped +
    job.rowsRejected +
    job.rowsDeduped +
    job.rowsUnprocessed;
  // Mirror the legacy worker's progress lanes: skipped = not-newly-landed (idempotent skips + held-back
  // duplicates), failed = rejected. Null while nothing has run yet (the legacy pre-first-update shape).
  const progress: ImportProgress | null =
    job.status === "queued" || job.status === "deferred"
      ? null
      : {
          total: job.rowsTotal,
          processed,
          created: job.rowsCreated,
          matched: job.rowsMatched,
          skipped: job.rowsSkipped + job.rowsDuplicate + job.rowsDeduped,
          failed: job.rowsRejected,
        };
  const terminal = job.status === "completed" || job.status === "partial";
  const summary: ImportSummary | null = terminal
    ? {
        total: job.rowsTotal,
        created: job.rowsCreated,
        matched: job.rowsMatched,
        skipped: job.rowsSkipped,
        rejected: job.rowsRejected,
        duplicates: job.rowsDuplicate,
        // Not persisted on the control row (non-PII counters only) — the receipt's list tally rides the
        // completed notification today; the v2 detail DTO (S-I4) decides its durable home.
        addedToList: 0,
        errors: [],
        rejectedRows: [],
        rejectHistogram: (job.rejectHistogram ?? {}) as Record<string, number>,
      }
    : null;
  return {
    jobId: String(job.id),
    status,
    progress,
    summary,
    failedReason:
      job.status === "cancelled" ? (job.failedReason ?? "cancelled") : (job.failedReason ?? null),
  };
}

/** Parse the shared import form fields (file + sourceName + mapping); throws ImportValidationError on bad input. */
async function parseImportForm(form: FormData): Promise<{
  file: File;
  sourceName: SourceName;
  mapping: ColumnMapping;
}> {
  const file = form.get("file");
  if (!(file instanceof File))
    throw new ImportValidationError("A CSV or XLSX file is required (field 'file').");

  const parsedSource = sourceName.safeParse(form.get("sourceName"));
  if (!parsedSource.success) throw new ImportValidationError("Unknown or missing 'sourceName'.");

  let mapping: unknown;
  try {
    mapping = JSON.parse(String(form.get("mapping") ?? ""));
  } catch {
    throw new ImportValidationError(
      "'mapping' must be a JSON object of canonicalField → column header.",
    );
  }
  const parsedMapping = columnMappingSchema.safeParse(mapping);
  if (!parsedMapping.success) throw new ImportValidationError("Invalid column mapping.");

  return { file, sourceName: parsedSource.data, mapping: parsedMapping.data };
}

// Reading the upload (bytes for .xlsx, decoded text for CSV) now runs through the S-S1 admission envelope
// (uploadAdmission.ts `readAdmittedImportContent`): per-format byte caps, magic-byte sniffing, and the
// BOM-aware encoding gate — 13 §1.1–§1.3. `parseImportFile` still dispatches on the same filename.

/**
 * The optional "import into list" target (list-plan/03 §2.2). Returns the validated `listId` (uuid) or
 * undefined when absent. Shape-only here; the caller validates it against the verified workspace before use.
 */
function parseListTarget(form: FormData): string | undefined {
  const raw = form.get("listId");
  if (raw == null || raw === "") return undefined;
  const parsed = importTargetSchema.safeParse({ listId: String(raw) });
  if (!parsed.success) throw new ImportValidationError("'listId' must be a valid list id.");
  return parsed.data.listId;
}

// Pre-commit validation PREVIEW (G-IMP-1): parse + validate the upload and return counts (total/valid/
// rejected/duplicate) + a sample of rejected rows with reasons — WITHOUT enqueuing anything. The wizard
// shows this and requires the user to confirm before the actual import runs. No DB writes, no job.
// S-V4: a draft-phase verb — rides the G02 create grant (10 §2.1), dual-gated (pass-through gate-off).
importRoutes.post("/preview", requireImportCreateGrant(), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");

  // S-S1 admission envelope: byte-count-capped multipart parse + hardening caps, then content sniffing.
  const form = await admittedImportFormData(c.req.raw);
  const { file, mapping } = await parseImportForm(form);
  const parsed = parseImportFile(await readAdmittedImportContent(file), file.name);
  const preview: ImportPreview = buildImportPreview(parsed.rows, mapping);
  return c.json(preview, 200);
});

// S-V4 (G02): the one-shot submit is a job-CREATING verb — member+ required, `who_can_import` enforced,
// behind the dual gate (today's zero-gate posture is byte-identical while the gate is off).
importRoutes.post("/", requireImportCreateGrant(), async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  const claims = c.get("claims");

  // S-S1 admission envelope: byte-count-capped multipart parse + hardening caps, then content sniffing.
  const form = await admittedImportFormData(c.req.raw);
  const { file, sourceName: src, mapping } = await parseImportForm(form);

  // Explicit conflict policy (G-IMP-5) — default `skip` (no silent overwrite) when the field is absent.
  const policyRaw = form.get("conflictPolicy");
  const parsedPolicy =
    policyRaw == null
      ? { success: true as const, data: DEFAULT_CONFLICT_POLICY }
      : conflictPolicy.safeParse(policyRaw);
  if (!parsedPolicy.success)
    throw new ImportValidationError("'conflictPolicy' must be one of: overwrite, skip, keep_both.");

  // Optional "import into list" target (list-plan/03 §2.2). Validate the client-supplied list id against the
  // VERIFIED token's workspace BEFORE enqueue (list-plan D4 — never trusted): a foreign/absent id 404s here,
  // a clean error instead of a dead-lettered job. runImport re-validates it under RLS when the worker runs.
  const listId = parseListTarget(form);
  if (listId) await assertListInWorkspace({ scope: { tenantId, workspaceId }, listId });

  const parsed = parseImportFile(await readAdmittedImportContent(file), file.name);

  // ── S-I3 fork: the IMPORT_V2 dual gate (env kill-switch AND per-tenant flag; importV2Gate.ts). ─────────
  // GATE ON: the one-shot submit creates the DURABLE import_jobs row (processing_mode='fast') and enqueues
  // a `fast` job on the unified bulk-imports queue — jobId = import_jobs.id, the poll reads the DB row
  // (G03 closes). GATE OFF: the legacy branch below is the shipped code, byte-identical (T1 parity) — the
  // Redis enqueue, the BullMQ jobId, the 202 body, everything.
  if (await isImportV2Enabled(tenantId)) {
    const scope = { tenantId, workspaceId };
    const input: ImportFastInput = {
      importedByUserId: claims.sub,
      sourceName: src,
      sourceFile: file.name,
      mapping,
      conflictPolicy: parsedPolicy.data,
      rows: parsed.rows,
      target: listId ? { listId } : undefined,
    };
    // Job-level idempotency (08 §1.1 level 1): the same Idempotency-Key collapses onto the existing job via
    // the shipped partial unique (workspace_id, idempotency_key) — the replay returns the SAME jobId and
    // enqueues nothing (levels 2/3 — the single chunk row + source_imports.content_hash — live below).
    const idempotencyKey = c.req.header("idempotency-key") ?? null;
    const { id: jobId, created } = await withTenantTx(scope, (tx) =>
      importJobRepository.createJob(tx, {
        tenantId,
        workspaceId,
        createdByUserId: claims.sub,
        // No stored object exists on the Phase-A fast path (rows travel in the payload until G07); the
        // NOT NULL storage-key column records an honest inline sentinel, and the DISPLAY filename lands in
        // the S-I1 source_filename column (source_name keeps the provider enum — 08 §Contradiction scan).
        sourceFile: `inline:${randomUUID()}`,
        sourceName: src,
        fileSize: file.size,
        // No scanner is wired at this composition root (the G08 seam) — recorded honestly, like bulkRoutes.
        avScanStatus: "skipped",
        idempotencyKey,
        columnMapping: mapping,
        conflictPolicy: parsedPolicy.data,
        targetListId: listId ?? null,
        // S-I1 v2 columns, written by their first writer: the server's routing verdict (Phase A: always
        // fast — copy engagement is S-I5/S-I9) + the honest display filename.
        processingMode: "fast",
        sourceFilename: file.name,
      }),
    );
    if (created) {
      await enqueueFastImport({ kind: "fast", jobId, scope, input });
    }
    const body: ImportJobRef = { jobId, status: "queued" };
    return c.json(body, 202);
  }

  const jobId = await enqueueImport({
    scope: { tenantId, workspaceId },
    importedByUserId: claims.sub,
    sourceName: src,
    sourceFile: file.name,
    mapping,
    conflictPolicy: parsedPolicy.data,
    rows: parsed.rows,
    target: listId ? { listId } : undefined,
  });
  const body: ImportJobRef = { jobId, status: "queued" };
  return c.json(body, 202);
});

// Poll an import job's status/progress. Tenant-scoped: only the owning workspace may read its job — and,
// behind the S-V3 dual gate, only the job's CREATOR or an elevated role within it (import-redesign 10 §5
// row 3: this Redis/BullMQ-backed read has no repository row, so the SAME rule is applied app-side over the
// queue payload's importedByUserId until the read retires with 08 §1.2). Gate off ⇒ workspace-wide,
// byte-identical (T-V4). Invisible ⇒ 404, indistinguishable from absent (no existence oracle).
importRoutes.get("/:jobId", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");

  // ── S-I3 fork: gate ON + a uuid-shaped id ⇒ the DURABLE read (G03's fix — answers for the row's
  // lifetime, ≥90 days, never a Redis eviction 404). The S-V2 viewer-predicated repo read applies the SAME
  // creator-or-elevated rule as the legacy branch below; invisible (foreign user/workspace or absent) ⇒
  // null ⇒ 404, indistinguishable from absent. Non-uuid ids (legacy BullMQ numeric ids from jobs submitted
  // before the flip) FALL THROUGH to the legacy Redis read so a mid-window flip strands no in-flight poll.
  // Gate OFF ⇒ the legacy branch runs untouched, byte-identical (T1).
  const tenantId = c.get("tenantId");
  const jobIdParam = c.req.param("jobId");
  if (UUID_RE.test(jobIdParam) && (await isImportV2Enabled(tenantId))) {
    const viewer = await buildJobViewer({
      tenantId,
      workspaceId,
      userId: c.get("claims").sub,
    });
    const row = await withTenantTx({ tenantId, workspaceId }, (tx) =>
      importJobRepository.getJob(tx, viewer, jobIdParam),
    );
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundError("Import job not found.");
    return c.json(toLegacyResponseV2(row), 200);
  }

  const job = await getImportJob(jobIdParam);
  // Tenant isolation: a job from another workspace (or a non-existent id) returns 404 — never leak existence.
  if (!job || job.data.scope.workspaceId !== workspaceId)
    throw new NotFoundError("Import job not found.");

  // Creator ∪ elevated (10 §2.1 detail row), evaluated only when the dual gate is on. A payload with no
  // importedByUserId is a system/automation job — nobody's "own", visible to elevated roles only.
  const viewer = await buildJobViewer({
    tenantId: c.get("tenantId"),
    workspaceId,
    userId: c.get("claims").sub,
  });
  if (viewer.scoped && viewer.role !== "owner" && viewer.role !== "admin") {
    if (job.data.importedByUserId !== viewer.userId)
      throw new NotFoundError("Import job not found.");
  }

  const state = await job.getState();
  const progress = importProgressSchema.safeParse(job.progress);
  const summary = importSummarySchema.safeParse(job.returnvalue);
  const body: ImportJobStatusResponse = {
    jobId: String(job.id),
    status: toImportJobStatus(state),
    progress: progress.success ? progress.data : null,
    summary: summary.success ? summary.data : null,
    failedReason: job.failedReason ?? null,
  };
  return c.json(body, 200);
});
