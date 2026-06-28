// bulkRoutes.ts — HTTP wiring for the BULK COPY-staging import (backlog #2, phase 6; 15-bulk-import-design). The
// big-file sibling of routes.ts: instead of parsing the upload on the request thread, it STREAMS the raw bytes to
// the FileStore, records a control row (import_jobs), and enqueues ONE `drive` job — the apps/workers consumer
// stages the file + fans out chunk jobs off the request path. GATED DARK behind env.BULK_IMPORT_ENABLED (default
// false): while the flag is off this router creates + enqueues NOTHING (every route fails with an RFC-9457
// problem before any work), so the feature is inert in prod until the COPY spike + a prod object store land. Same
// trust boundary as the sync route: the workspace comes from the VERIFIED token (tenancy middleware), never the
// body; the client listId is validated against that workspace before enqueue (list-plan D4 — never trusted).

import { randomUUID } from "node:crypto";
import { env } from "@leadwolf/config";
import { assertListInWorkspace } from "@leadwolf/core";
import { type ImportJobRow, importJobRepository, withTenantTx } from "@leadwolf/db";
import {
  type AvScanStatus,
  type BulkImportJobRef,
  type BulkImportJobStatus,
  type BulkImportJobStatusResponse,
  type ColumnMapping,
  DEFAULT_CONFLICT_POLICY,
  ForbiddenError,
  type ImportJobCounts,
  ImportValidationError,
  NotFoundError,
  type SourceName,
  columnMappingSchema,
  conflictPolicy,
  importTargetSchema,
  sourceName,
} from "@leadwolf/types";
import { Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { rateLimit } from "../../middleware/rateLimit.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { enqueueBulkImportDrive } from "./bulkQueue.ts";
import { bulkFileStore } from "./bulkStore.ts";

export const bulkImportRoutes = new Hono<{ Variables: TenancyVariables }>();

bulkImportRoutes.use("*", authn);
bulkImportRoutes.use("*", tenancy);
bulkImportRoutes.use("*", rateLimit);

// HARD GATE (the safety): while BULK_IMPORT_ENABLED is false the feature is DARK — every bulk route fails with a
// clear RFC-9457 problem and NOTHING is read, created, or enqueued. A `use` so it covers POST + GET uniformly;
// placed AFTER authn so an unauthenticated caller still gets a 401 (the feature's existence is never revealed to
// an anonymous request). The api creating/enqueuing nothing while off is what makes the dark worker harmless.
bulkImportRoutes.use("*", async (_c, next) => {
  if (!env.BULK_IMPORT_ENABLED) {
    throw new ForbiddenError("bulk_import_disabled", "Bulk import is not enabled.");
  }
  await next();
});

/** Map a stored control row's row-accounting columns to the public, non-PII counts DTO (rows_in = the sum). */
function toCounts(job: ImportJobRow): ImportJobCounts {
  return {
    total: job.rowsTotal,
    created: job.rowsCreated,
    matched: job.rowsMatched,
    duplicate: job.rowsDuplicate,
    skipped: job.rowsSkipped,
    rejected: job.rowsRejected,
    deduped: job.rowsDeduped,
    unprocessed: job.rowsUnprocessed,
  };
}

/**
 * Parse the bulk import form fields (file + sourceName + mapping). Mirrors the sync route's parser MINUS the
 * on-thread file PARSE — the bulk path streams the raw bytes to the FileStore and parses them in the worker.
 */
async function parseBulkImportForm(form: FormData): Promise<{
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

/** The optional "import into list" target (list-plan/03 §2.2). Returns the validated listId or undefined. The
 *  caller validates it against the verified workspace before use. Mirrors the sync route. */
function parseBulkListTarget(form: FormData): string | undefined {
  const raw = form.get("listId");
  if (raw == null || raw === "") return undefined;
  const parsed = importTargetSchema.safeParse({ listId: String(raw) });
  if (!parsed.success) throw new ImportValidationError("'listId' must be a valid list id.");
  return parsed.data.listId;
}

/** A sanitized lowercase extension for the deterministic source key — the filename is NEVER trusted in a path
 *  (alnum only; the disk adapter is traversal-guarded too). Defaults to `csv`. */
function sourceExt(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext || "csv";
}

/**
 * AV-scan SEAM (G-IMP-6): no scanner is wired at this composition root yet, so an untrusted upload is recorded as
 * `skipped`. When a real scanner is injected here it returns `clean`/`infected`; the caller REFUSES an `infected`
 * file before any job is created (and core's promote-to-staging re-checks the gate).
 */
function scanUpload(): AvScanStatus {
  return "skipped";
}

// POST /imports/bulk — accept a (potentially huge) upload: stream it to the FileStore, record a control row, and
// enqueue ONE drive job; return 202 + a job ref to poll. No per-row work on the request thread.
bulkImportRoutes.post("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  const claims = c.get("claims");
  const scope = { tenantId, workspaceId };

  const form = await c.req.formData();
  const { file, sourceName: src, mapping } = await parseBulkImportForm(form);

  // Explicit conflict policy (G-IMP-5) — default `skip` (no silent overwrite) when the field is absent.
  const policyRaw = form.get("conflictPolicy");
  const parsedPolicy =
    policyRaw == null
      ? { success: true as const, data: DEFAULT_CONFLICT_POLICY }
      : conflictPolicy.safeParse(policyRaw);
  if (!parsedPolicy.success)
    throw new ImportValidationError("'conflictPolicy' must be one of: overwrite, skip, keep_both.");

  // Optional target list — validated against the VERIFIED workspace BEFORE enqueue (list-plan D4, never trusted);
  // runBulkImport re-validates it under RLS in the worker. A foreign/absent id 404s here, not a dead-lettered job.
  const listId = parseBulkListTarget(form);
  if (listId) await assertListInWorkspace({ scope, listId });

  // AV-scan SEAM: refuse an infected upload before any job exists. With no scanner configured this is `skipped`.
  const avScan = scanUpload();
  if (avScan === "infected")
    throw new ImportValidationError("The uploaded file did not pass the malware scan.");

  // Deterministic object-store key for the SOURCE upload, keyed by a fresh upload id (NOT the jobId): createJob
  // assigns the jobId from the DB default and the db repo exposes no setter to rewrite source_file post-insert, so
  // the key is computed BEFORE create (put → create → enqueue). The ext is sanitized — the filename is untrusted.
  // (The rejected-rows artifact is jobId-based, written by core's runBulkImport — see the GET handler.)
  const sourceKey = `imports/${randomUUID()}/source.${sourceExt(file.name)}`;

  // Idempotency-Key (09 §5): a re-submit carrying the same key collapses onto the existing job via the partial-
  // unique (workspace_id, idempotency_key) index in createJob — never a duplicate import.
  const idempotencyKey = c.req.header("idempotency-key") ?? null;

  // Create the control row FIRST (short tx) so an idempotent re-submit is detected BEFORE we stream the upload or
  // enqueue a duplicate drive. source_file points at sourceKey; we write those bytes immediately after (and only
  // for a freshly-created job), BEFORE the drive is enqueued — so the worker never reads a not-yet-written object.
  const { id: jobId, created } = await withTenantTx(scope, (tx) =>
    importJobRepository.createJob(tx, {
      tenantId,
      workspaceId,
      createdByUserId: claims.sub,
      // source_file = the object-store KEY (core's bulkStage reads the upload from it); source_name = the
      // SourceName PROVIDER enum (core casts `job.sourceName as SourceName` for the content hash + the
      // `import:<source>` provenance stamp, byte-identical to the sync path — NOT the display filename, despite
      // the schema's inline comment). The original filename is carried only inside the object key here.
      sourceFile: sourceKey,
      sourceName: src,
      fileSize: file.size,
      avScanStatus: avScan,
      idempotencyKey,
      columnMapping: mapping,
      conflictPolicy: parsedPolicy.data,
      targetListId: listId ?? null,
    }),
  );

  if (created) {
    // Stream the raw upload to the FileStore (constant memory — File.stream() is a ReadableStream<Uint8Array>),
    // THEN enqueue the single drive job. On a storage failure mark the job failed (best-effort) and surface it.
    try {
      await bulkFileStore().putObject(sourceKey, file.stream());
    } catch (err) {
      await withTenantTx(scope, (tx) =>
        importJobRepository.updateJobStatus(tx, jobId, {
          status: "failed",
          failedReason: "Failed to store the uploaded file.",
          completedAt: new Date(),
        }),
      ).catch(() => undefined);
      throw err;
    }
    await enqueueBulkImportDrive({ kind: "drive", jobId, scope });
  }

  // The accept-status is always `queued` (the sync route's posture); the client polls GET for the real status —
  // which, for an idempotent re-submit, reflects wherever the original job already is.
  const body: BulkImportJobRef = { jobId, status: "queued" };
  return c.json(body, 202);
});

// GET /imports/bulk/:jobId — poll a bulk import's status/counts. Tenant-scoped: only the owning workspace reads it.
bulkImportRoutes.get("/:jobId", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  const scope = { tenantId, workspaceId };
  const jobId = c.req.param("jobId");

  const job = await withTenantTx(scope, (tx) => importJobRepository.getJob(tx, jobId));
  // Tenant isolation: RLS already restricts getJob to the caller's workspace; the explicit workspace check is
  // belt-and-suspenders. A foreign/absent job 404s — never leak another workspace's job (nor its existence).
  if (!job || job.workspaceId !== workspaceId)
    throw new NotFoundError("Bulk import job not found.");

  const status = job.status as BulkImportJobStatus;
  const terminal = status === "completed" || status === "partial";
  const progress = job.totalChunks > 0 ? job.completedChunks / job.totalChunks : 0;
  // The rejected-rows artifact is written by the drive phase ONLY when ≥1 row was rejected, and is only meaningful
  // once the job is terminal. Its key is jobId-based (hardcoded in core's runBulkImport — this read matches it).
  const rejectedRowsUrl =
    terminal && job.rowsRejected > 0
      ? await bulkFileStore().getSignedDownloadUrl(`imports/${jobId}/rejected-rows.csv`)
      : null;

  const body: BulkImportJobStatusResponse = {
    jobId: String(job.id),
    sourceName: job.sourceName,
    status,
    progress,
    counts: toCounts(job),
    rejectedRowsUrl,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    failedReason: job.failedReason ?? null,
  };
  return c.json(body, 200);
});
