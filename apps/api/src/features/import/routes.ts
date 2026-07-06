// routes.ts — HTTP wiring for the import feature (05 §3). POST accepts a multipart upload (the CSV/XLSX file +
// a JSON column mapping + the source + an optional target listId), parses it on the request thread, then
// ENQUEUES the parsed rows onto the `imports` queue and returns 202 + a job ref — the heavy per-row dedup/
// encrypt/DB work runs in the apps/workers consumer (processImport → the SAME packages/core runImport). This
// file does only transport (parse the request, enqueue, shape the response) and no business logic. The
// workspace is taken from the VERIFIED token via the tenancy middleware, never the request body (16 §7); the
// client-supplied listId is validated against that workspace before enqueue (list-plan D4 — never trusted).

import { randomUUID } from "node:crypto";
import { env } from "@leadwolf/config";
import {
  applyMappingTemplate,
  assertListInWorkspace,
  buildDraftPreviewSummary,
  buildImportPreview,
  decideFastAdmission,
  decodeAdmittedCsv,
  deriveImportProgress,
  isXlsxFile,
  parseImportFile,
  suggestColumnMapping,
  writeAudit,
} from "@leadwolf/core";
import {
  type ImportJobRow,
  importJobRepository,
  importPolicyRepository,
  withTenantTx,
} from "@leadwolf/db";
import {
  type AvScanStatus,
  type ColumnMapping,
  type ConflictPolicy,
  DEFAULT_CONFLICT_POLICY,
  ForbiddenError,
  IMPORT_FASTPATH_MAX_BYTES,
  IMPORT_MAX_COMMITS_PER_HOUR,
  IllegalStateError,
  type ImportDraftPreviewResponse,
  type ImportDraftRef,
  type ImportFastInput,
  ImportQuotaExceededError,
  type ImportJobDetailV2,
  type ImportJobListItem,
  type ImportJobListResponse,
  type ImportJobRef,
  type ImportJobStatus,
  type ImportJobStatusResponse,
  type ImportJobStatusV2,
  type ImportMergeMode,
  type ImportPreview,
  type ImportProgress,
  type ImportStrategy,
  type ImportSummary,
  ImportTooLargeError,
  ImportValidationError,
  NotFoundError,
  type SourceName,
  columnMappingSchema,
  conflictPolicy,
  importDraftMappingRequestSchema,
  importMergeMode,
  importProgressSchema,
  importSummarySchema,
  importTargetSchema,
  sourceName,
} from "@leadwolf/types";
import { type Context, Hono } from "hono";
import { authn } from "../../middleware/authn.ts";
import { buildJobViewer } from "../../middleware/jobViewer.ts";
import { rateLimit } from "../../middleware/rateLimit.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { enqueueFastImport } from "./bulkQueue.ts";
import { bulkFileStore } from "./bulkStore.ts";
import { requireImportCreateGrant } from "./createGrant.ts";
import { isImportV2Enabled } from "./importV2Gate.ts";
import { scanImportUpload } from "./malwareScan.ts";
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
 *  never `Job.getState()`). Progress/summary derive from the atomic counters through core's ONE
 *  derivation fn (S-Q6, 09 §4.1 — poll and the future SSE can never disagree); the rejected-row DETAIL
 *  (errors/rejectedRows) is not persisted on the non-PII control plane — it arrives with the S-I7 artifact
 *  pair, so gate-on terminal summaries carry counts + histogram with empty detail arrays. */
function toLegacyResponseV2(job: ImportJobRow): ImportJobStatusResponse {
  const status = toLegacyStatusV2(job.status);
  const { processedRows } = deriveImportProgress(job);
  // Mirror the legacy worker's progress lanes: skipped = not-newly-landed (idempotent skips + held-back
  // duplicates), failed = rejected. Null while nothing has run yet (the legacy pre-first-update shape).
  const progress: ImportProgress | null =
    job.status === "queued" || job.status === "deferred"
      ? null
      : {
          total: job.rowsTotal,
          processed: processedRows,
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

// ── S-I4 v2 tenant-surface mappers (08 §7) ───────────────────────────────────────────────────────────────
// The durable list/detail read model. Non-PII: counts + statuses + histogram labels only, never a row value.

/** The 7-bucket accounting view straight off the atomic `rows_*` counters (09 §4 identity). */
function toImportJobCounts(job: ImportJobRow): ImportJobListItem["counts"] {
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

/** One durable job → a `GET /imports` list item (the real 12-state vocabulary; progress via the ONE derivation fn). */
function toImportJobListItem(job: ImportJobRow): ImportJobListItem {
  const { percent, stage } = deriveImportProgress(job);
  return {
    jobId: String(job.id),
    status: job.status as ImportJobListItem["status"],
    mode: (job.processingMode ?? null) as ImportJobListItem["mode"],
    sourceName: job.sourceName as SourceName,
    sourceFilename: job.sourceFilename ?? null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    percent,
    stage,
    counts: toImportJobCounts(job),
    createdBy: { userId: job.createdByUserId ?? null },
    parentJobId: job.parentJobId ?? null,
  };
}

/** The additive v2 members layered onto the legacy detail response (08 §2.4 window): old clients keep
 *  `status`/`progress`/`summary`; new clients read `statusV2` + these. `addedToList` is intentionally omitted
 *  (the control row never persists it — see importJobDetailV2Schema). */
function toImportJobDetailV2(job: ImportJobRow): ImportJobDetailV2 {
  const item = toImportJobListItem(job);
  return {
    statusV2: item.status,
    mode: item.mode,
    sourceFilename: item.sourceFilename,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    percent: item.percent,
    stage: item.stage,
    counts: item.counts,
    createdBy: item.createdBy,
    parentJobId: item.parentJobId,
    mergeMode: job.mergeMode as ImportJobDetailV2["mergeMode"],
    preservePopulated: job.preservePopulated,
    rejectHistogram: (job.rejectHistogram ?? {}) as Record<string, number>,
    previewSummary: (job.previewSummary ?? null) as ImportJobDetailV2["previewSummary"],
  };
}

/** Opaque keyset cursor over `(created_at, id)` — the exact order of `idx_import_jobs_ws_created`. base64url. */
function encodeJobCursor(job: ImportJobRow): string {
  return Buffer.from(`${job.createdAt.toISOString()}|${job.id}`, "utf8").toString("base64url");
}
function decodeJobCursor(raw: string): { createdAt: Date; id: string } | null {
  try {
    const s = Buffer.from(raw, "base64url").toString("utf8");
    const sep = s.lastIndexOf("|");
    if (sep <= 0) return null;
    const createdAt = new Date(s.slice(0, sep));
    const id = s.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// ── S-I5: server-side routing pre-gate (08 §1, G10 routing half) ────────────────────────────────────────
// The SERVER decides fast vs copy from MEASURED facts (row count + byte size), never a client hint. Copy mode
// is not engaged until the enable-gates clear (G07+G09), so an over-threshold file gets an honest
// `file_too_large`/`xlsx_too_large` refusal NAMING the ceiling (12 §5) — never a dead-end toggle (14's
// standing fallback). Copy engagement + its UX are S-I9/Phase 2. Called ONLY inside the IMPORT_V2 gate, so the
// legacy path is byte-identical (a 100k-row CSV still runs on the legacy engine, unrefused, gate-off).
function assertFastPathRouting(fileName: string, byteSize: number, rowCount: number): void {
  const isXlsx = /\.xlsx$/i.test(fileName);
  const rowCeiling = env.BULK_IMPORT_THRESHOLD_ROWS;
  if (rowCeiling > 0 && rowCount > rowCeiling) {
    throw new ImportTooLargeError({
      limit: rowCeiling,
      current: rowCount,
      unit: "rows",
      code: isXlsx ? "xlsx_too_large" : "file_too_large",
    });
  }
  // XLSX bytes are already hard-capped at admission (IMPORT_XLSX_MAX_BYTES); the fast-path BYTE ceiling here is
  // the CSV routing limit (12 §5's 10 MB pair-half). Above it ⇒ copy territory ⇒ honest refusal until Phase 2.
  if (!isXlsx && byteSize > IMPORT_FASTPATH_MAX_BYTES) {
    throw new ImportTooLargeError({
      limit: IMPORT_FASTPATH_MAX_BYTES,
      current: byteSize,
      unit: "bytes",
      code: "file_too_large",
    });
  }
}

// ── S-I6: resolve the 08 §5 merge strategy for a gate-on job (request → template → import_policy default) ─
// Precedence (08 §5): explicit request `mergeMode`/`preservePopulated` win (each independently falling back to
// the workspace policy default); a legacy client sending only `conflictPolicy` gets it MAPPED onto the triad
// (the compatibility mapping — mirrors core's conflictPolicyToStrategy); otherwise the org-admin workspace
// default from `import_policy` (10 §3). The TEMPLATE layer (a saved mapping template's strategy block) slots
// between request and policy when S-I2/S-I8 wire `mapping_template_id` on this route — not yet reachable here.
async function resolveImportStrategy(
  form: FormData,
  scope: { tenantId: string; workspaceId: string },
  conflictPolicyData: ConflictPolicy,
  conflictPolicySent: boolean,
): Promise<ImportStrategy> {
  const mergeRaw = form.get("mergeMode") ?? form.get("merge_mode");
  const preserveRaw = form.get("preservePopulated") ?? form.get("preserve_populated");

  if (mergeRaw != null || preserveRaw != null) {
    // Explicit v2 strategy fields present ⇒ they win, each field independently defaulting to the policy.
    const policy = await importPolicyRepository.resolved(scope);
    let mergeMode = policy.defaultMergeMode;
    if (mergeRaw != null) {
      const parsed = importMergeMode.safeParse(mergeRaw);
      if (!parsed.success)
        throw new ImportValidationError(
          "'mergeMode' must be one of: create_and_update, create_only, update_only.",
        );
      mergeMode = parsed.data;
    }
    let preservePopulated = policy.defaultPreservePopulated;
    if (preserveRaw != null) {
      if (preserveRaw !== "true" && preserveRaw !== "false")
        throw new ImportValidationError("'preservePopulated' must be 'true' or 'false'.");
      preservePopulated = preserveRaw === "true";
    }
    return { mergeMode, preservePopulated };
  }

  if (conflictPolicySent) {
    // Legacy conflictPolicy → triad (08 §5): overwrite → create_and_update; skip/keep_both → create_only;
    // preserve_populated:false (no legacy switch). Byte-equivalent to core's conflictPolicyToStrategy.
    return {
      mergeMode: conflictPolicyData === "overwrite" ? "create_and_update" : "create_only",
      preservePopulated: false,
    };
  }

  const policy = await importPolicyRepository.resolved(scope);
  return { mergeMode: policy.defaultMergeMode, preservePopulated: policy.defaultPreservePopulated };
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

// ── S-I8: the upload-once draft flow (08 §2.1 draft state, §2.3 verb table, §3 mapping, §4 preview) ──────
// Every draft verb is dark behind the IMPORT_V2 dual gate (gate-off ⇒ the create dispatch never fires and
// the per-draft verbs 404 — the list's no-existence-oracle posture). The draft rides the SAME admission +
// scan pipeline as the one-shot, stores the SOURCE OBJECT via the env-selected FileStore (diskFileStore
// today; the S3 adapter transparently when the Gate-B env lands — bulkStore.ts is the one selection seam),
// and is CANARY-ONLY until Gate C clears (15 §M-SEQ row 35).

/** Sanitized lowercase extension for the source object key — the filename is NEVER trusted in a path
 *  (alnum only; mirrors bulkRoutes.ts sourceExt — keep the two in sync). Defaults to `csv`. */
function draftSourceExt(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext || "csv";
}

/**
 * Buffer a stored draft source object. BOUNDED BY CONSTRUCTION: callers pre-gate CSV bytes at the
 * fast-path ceiling (10 MiB) off the row's `file_size` BEFORE reading, and XLSX was admission-capped at
 * upload (25 MiB) — so this never buffers past the same bounds the one-shot request thread already accepts
 * (08 §1.2 Phase-A memory bound). A missing/unreadable object (store loss) is an honest 422, not a 500 —
 * the draft's file is the one unrecoverable input (08 pre-build "FileStore object lost").
 */
async function readDraftSourceObject(key: string): Promise<Uint8Array> {
  try {
    const stream = await bulkFileStore().getObjectStream(key);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  } catch {
    throw new ImportValidationError(
      "The uploaded draft file is no longer available — upload it again.",
    );
  }
}

/** Decode + parse a stored draft object with the SAME per-format rules as the upload thread (13 §1.3 BOM-
 *  aware CSV decode; XLSX as bytes) — the draft never re-runs full admission (it was admitted at upload). */
function parseDraftSource(bytes: Uint8Array, filename: string) {
  const content = isXlsxFile(filename) ? bytes : decodeAdmittedCsv(bytes);
  return parseImportFile(content, filename);
}

/** The CSV byte pre-gate shared by preview + commit: refuse off the ROW's recorded size BEFORE reading the
 *  object (bounds the buffer AND matches the S-I5 refusal the commit would give — an honest early ceiling,
 *  08 §1). XLSX rides its 25 MiB admission cap; its row ceiling is enforced post-parse by the routing gate. */
function assertDraftReadable(filename: string, fileSize: number | null): void {
  if (!isXlsxFile(filename) && (fileSize ?? 0) > IMPORT_FASTPATH_MAX_BYTES) {
    throw new ImportTooLargeError({
      limit: IMPORT_FASTPATH_MAX_BYTES,
      current: fileSize ?? 0,
      unit: "bytes",
      code: "file_too_large",
    });
  }
}

/**
 * POST /imports without a `mapping` form field, gate-on (08 §2.3 dispatch): create a DRAFT — admit + scan
 * + parse-verdict the upload, store the source object, create the `draft` control row, and answer with the
 * draft ref + headers + the server's auto-map proposal (08 §3.2). Scan strictly precedes parse AND storage
 * (13 §2.2 wire point 1 — the exact bulkRoutes order); an empty/undecodable/infected file is refused with
 * NO job and NO stored object (08 §Edge cases). Idempotency-Key collapses onto the existing job via the
 * shipped partial unique; the replay reports the collapsed job's REAL status (a committed draft replays as
 * queued/…) and re-stores nothing. The create grant (G02) rides the route middleware, same as the one-shot.
 */
async function createImportDraft(
  c: Context<{ Variables: TenancyVariables }>,
  form: FormData,
  ids: { tenantId: string; workspaceId: string; userId: string },
): Promise<Response> {
  const { tenantId, workspaceId, userId } = ids;
  const scope = { tenantId, workspaceId };

  const file = form.get("file");
  if (!(file instanceof File))
    throw new ImportValidationError("A CSV or XLSX file is required (field 'file').");
  const parsedSource = sourceName.safeParse(form.get("sourceName"));
  if (!parsedSource.success) throw new ImportValidationError("Unknown or missing 'sourceName'.");

  // Optional list target — validated against the VERIFIED workspace (list-plan D4, never trusted).
  const listId = parseListTarget(form);
  if (listId) await assertListInWorkspace({ scope, listId });

  // S-S2 wire point 1 (G08, 13 §2.2): scan BEFORE parse and BEFORE the object is stored. Stub ⇒ 'skipped'
  // (recorded honestly); infected ⇒ refused pre-job, nothing stored; real-scanner outage ⇒ 503 fail-closed.
  const avScan = await scanImportUpload(file);
  if (avScan === "infected")
    throw new ImportValidationError("The uploaded file did not pass the malware scan.");

  // Fast-path ceiling AT UPLOAD (08 §1: until the copy gates clear, an over-threshold file is refused at
  // upload — a truthful product limit, and the byte half fires BEFORE the buffer/parse so the draft path
  // never does more request-thread work than commit would admit). When G07+G09 clear, the draft upload
  // starts admitting above this and only commit's routing lifts — the user contract never changes shape.
  assertDraftReadable(file.name, file.size);

  // Parse verdict at upload (08 §2.1: draft = "file uploaded and stored, parse verdict + AV verdict
  // recorded"): admission caps + sniffing + BOM-aware decode, then parse — an empty file 422s with no job.
  // The parsed headers feed the auto-map proposal; the ROWS are deliberately discarded (the draft's truth
  // is the stored object; preview/commit re-read it — nothing PII rides the control row or this closure).
  const parsed = parseImportFile(await readAdmittedImportContent(file), file.name);
  // The row half of the pre-gate (measured, post-parse — the same S-I5 ceiling commit re-asserts).
  assertFastPathRouting(file.name, file.size, parsed.rows.length);
  const suggestedMapping = suggestColumnMapping(parsed.headers);

  // Deterministic object key, minted BEFORE create (the bulkRoutes idiom: createJob assigns the jobId from
  // the DB default, and source_file is NOT NULL at insert). Ext sanitized — the filename is untrusted.
  const sourceKey = `imports/${randomUUID()}/source.${draftSourceExt(file.name)}`;
  const idempotencyKey = c.req.header("idempotency-key") ?? null;

  const viewer = await buildJobViewer({ tenantId, workspaceId, userId });
  const { jobId, created, status } = await withTenantTx(scope, async (tx) => {
    const res = await importJobRepository.createJob(tx, {
      tenantId,
      workspaceId,
      createdByUserId: userId,
      status: "draft",
      sourceFile: sourceKey,
      sourceName: parsedSource.data,
      fileSize: file.size,
      avScanStatus: avScan,
      idempotencyKey,
      // The mapping arrives via PUT /imports/:id/mapping (08 §3); commit 422s while it is empty.
      columnMapping: {},
      targetListId: listId ?? null,
      sourceFilename: file.name,
      // processing_mode deliberately UNSET: the server routes ONCE, at commit, from measured facts (08 §1).
    });
    if (res.created) return { jobId: res.id, created: true, status: "draft" as ImportJobStatusV2 };
    // Idempotent replay: report the collapsed job's REAL state (it may have committed since) through the
    // VIEWER-predicated read (10 §4.3 — no system read on a user route). Invisible (another member reused
    // the key — the workspace-wide key namespace is the shipped createJob design) ⇒ the ref carries the
    // id + 'draft' only, mirroring the one-shot replay's blind {jobId, queued} posture.
    const existing = await importJobRepository.getJob(tx, viewer, res.id);
    return {
      jobId: res.id,
      created: false,
      status: (existing?.status ?? "draft") as ImportJobStatusV2,
    };
  });

  if (created) {
    // Stream the raw upload to the FileStore (constant memory), AFTER the row exists so an idempotent
    // re-submit never re-streams. On storage failure mark the draft failed (best-effort) and surface it —
    // the shipped bulkRoutes posture.
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
  }

  const body: ImportDraftRef = {
    jobId,
    status,
    sourceFilename: file.name,
    headers: parsed.headers,
    suggestedMapping,
  };
  return c.json(body, created ? 201 : 200);
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

  // ── S-I8 dispatch (08 §2.3): a multipart POST WITHOUT the `mapping` form field is the upload-once
  // DRAFT-CREATE verb — gate-on only. The gate is evaluated ONCE here and reused by the one-shot fork
  // below (same result, one flag read). Gate-off (and every legacy caller — they always send `mapping`)
  // falls through byte-identically: a missing mapping still 422s in parseImportForm exactly as shipped.
  const importV2 = await isImportV2Enabled(tenantId);
  if (importV2 && form.get("mapping") == null) {
    return createImportDraft(c, form, { tenantId, workspaceId, userId: claims.sub });
  }

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

  // S-S2 wire point 1 (G08, 13 §2.2): scan the admitted upload BEFORE parse — the parser is itself attack
  // surface (13 §1.4), so the AV verdict must never depend on surviving it. Applies to BOTH branches below
  // (the fast Phase-A bytes ARE this request's upload — there is no stored object to re-scan later, so
  // admission is the fast path's one wire point). Stub ⇒ 'skipped' (shipped behavior, byte-identical);
  // infected ⇒ refused pre-job (no row, nothing enqueued); real-scanner outage ⇒ 503 fail-closed.
  const avScan = await scanImportUpload(file);
  if (avScan === "infected")
    throw new ImportValidationError("The uploaded file did not pass the malware scan.");

  const parsed = parseImportFile(await readAdmittedImportContent(file), file.name);

  // ── S-I3 fork: the IMPORT_V2 dual gate (env kill-switch AND per-tenant flag; importV2Gate.ts). ─────────
  // GATE ON: the one-shot submit creates the DURABLE import_jobs row (processing_mode='fast') and enqueues
  // a `fast` job on the unified bulk-imports queue — jobId = import_jobs.id, the poll reads the DB row
  // (G03 closes). GATE OFF: the legacy branch below is the shipped code, byte-identical (T1 parity) — the
  // Redis enqueue, the BullMQ jobId, the 202 body, everything.
  if (importV2) {
    // S-I5: measured server-side routing. Over-threshold ⇒ honest refusal (copy mode is dark until Phase 2);
    // otherwise the verdict is `fast` (processing_mode below). Gate-on only — the legacy path never refuses.
    assertFastPathRouting(file.name, file.size, parsed.rows.length);
    const scope = { tenantId, workspaceId };
    // S-I6: resolve the 08 §5 merge strategy (request → import_policy default; legacy conflictPolicy mapped).
    // It rides the payload (supersedes conflictPolicy in the engine) AND is persisted on the job row below.
    const strategy = await resolveImportStrategy(form, scope, parsedPolicy.data, policyRaw != null);
    const input: ImportFastInput = {
      importedByUserId: claims.sub,
      sourceName: src,
      sourceFile: file.name,
      mapping,
      conflictPolicy: parsedPolicy.data,
      strategy,
      rows: parsed.rows,
      target: listId ? { listId } : undefined,
    };
    // Job-level idempotency (08 §1.1 level 1): the same Idempotency-Key collapses onto the existing job via
    // the shipped partial unique (workspace_id, idempotency_key) — the replay returns the SAME jobId and
    // enqueues nothing (levels 2/3 — the single chunk row + source_imports.content_hash — live below).
    const idempotencyKey = c.req.header("idempotency-key") ?? null;
    // S-Q2 per-workspace cap (09 §2.2): the census + the row creation share ONE tx — at/over the cap the
    // job parks in `deferred` (the visible-backpressure state; the legacy response shape maps it to
    // `queued`, 08 §2.4) and its queue job carries the recheck delay; the leader-locked sweep promotes
    // oldest-first as slots free. Cap 0 = disabled = always `queued` (legacy).
    const { id: jobId, created, admission } = await withTenantTx(scope, async (tx) => {
      const verdict = await decideFastAdmission(tx, workspaceId);
      const res = await importJobRepository.createJob(tx, {
        tenantId,
        workspaceId,
        createdByUserId: claims.sub,
        status: verdict,
        // No stored object exists on the Phase-A fast path (rows travel in the payload until G07); the
        // NOT NULL storage-key column records an honest inline sentinel, and the DISPLAY filename lands in
        // the S-I1 source_filename column (source_name keeps the provider enum — 08 §Contradiction scan).
        sourceFile: `inline:${randomUUID()}`,
        sourceName: src,
        fileSize: file.size,
        // S-S2: the admission scan's real verdict ('clean' with a scanner; 'skipped' under the stub —
        // recorded honestly either way; 'infected' never reaches here, it was refused above).
        avScanStatus: avScan,
        idempotencyKey,
        columnMapping: mapping,
        conflictPolicy: parsedPolicy.data,
        targetListId: listId ?? null,
        // S-I1 v2 columns, written by their first writer: the server's routing verdict (Phase A: always
        // fast — copy engagement is S-I5/S-I9) + the honest display filename.
        processingMode: "fast",
        sourceFilename: file.name,
        // S-I6: persist the resolved 08 §5 strategy so history/detail reflects HOW the job merged.
        mergeMode: strategy.mergeMode,
        preservePopulated: strategy.preservePopulated,
      });
      return { ...res, admission: verdict };
    });
    if (created) {
      // A deferred job STILL gets transport (rows live in the payload until G07 — Phase-A bound): the
      // delayed claim re-checks the cap cooperatively and re-parks or runs; the sweep is the DB promoter.
      await enqueueFastImport(
        { kind: "fast", jobId, scope, input },
        admission === "deferred" ? env.IMPORT_DEFER_RECHECK_DELAY_MS : 0,
      );
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

// ── S-I4: GET /imports — the durable import history (08 §7, G04). A NEW endpoint, strict from birth (10 §5
// row 1): it exists ONLY behind the IMPORT_V2 dual gate (legacy imports have no durable list; gate-off ⇒ 404,
// no existence oracle). Keyset-paginated on `idx_import_jobs_ws_created`; the jobVisibility predicate rides
// INSIDE the repo read (viewer built from the verified token + resolved role), so members see own+shared and
// elevated see all — the predicate short-circuits to workspace-wide only while JOB_VISIBILITY_SCOPED is off
// (RLS still walls the tenant/workspace either way).
importRoutes.get("/", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  if (!(await isImportV2Enabled(tenantId))) throw new NotFoundError("Import history not found.");

  const viewer = await buildJobViewer({ tenantId, workspaceId, userId: c.get("claims").sub });
  const limitRaw = Number(c.req.query("limit") ?? "50");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.trunc(limitRaw))) : 50;
  const cursorRaw = c.req.query("cursor");
  const cursor = cursorRaw ? decodeJobCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) throw new ImportValidationError("Invalid pagination cursor.");
  // 08 §7: drafts are EXCLUDED from history by default; `?state=draft` is the wizard-resume opt-in
  // (drafts only, still viewer-scoped). Any other value is rejected (closed vocabulary).
  const stateRaw = c.req.query("state");
  if (stateRaw != null && stateRaw !== "draft")
    throw new ImportValidationError("'state' supports only 'draft'.");
  const drafts = stateRaw === "draft" ? ("only" as const) : ("exclude" as const);

  // Fetch one extra to know whether a further page exists (the house keyset idiom).
  const rows = await withTenantTx({ tenantId, workspaceId }, (tx) =>
    importJobRepository.listJobs(tx, viewer, { limit: limit + 1, cursor, drafts }),
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const body: ImportJobListResponse = {
    jobs: page.map(toImportJobListItem),
    nextCursor: hasMore && last ? encodeJobCursor(last) : null,
  };
  return c.json(body, 200);
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
    // S-I4: the detail is the legacy poll shape (byte-compat for old clients) PLUS the additive v2 members
    // (mode, counts, derived percent/stage, attribution, strategy, preview_summary — 08 §7). Additive ⇒ old
    // clients ignore the new keys; new clients read `statusV2` + `counts` instead of `status`/`progress`.
    return c.json({ ...toLegacyResponseV2(row), ...toImportJobDetailV2(row) }, 200);
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

// ── S-I4: POST /imports/:jobId/cancel — the tenant cancel verb (G05; 08 §2.2 stop-remainder, 09 §5 machinery).
// A NEW v2 verb, strict from birth (10 §5 row 4): it acts only on durable rows, so a legacy (non-uuid) id or a
// gate-off tenant ⇒ 404 (no legacy cancel ever existed; no existence oracle). Who may cancel = creator ∪
// elevated (the viewer predicate on the FOR-UPDATE read; invisible ⇒ 404). Legality (08 §2.1) is checked
// against the LOCKED row: cancel-on-cancelled = 200 no-op; a terminal/non-cancellable state ⇒ 409
// illegal_state. The flip + its `import.cancelled` audit row commit in ONE tx; committed rows are NOT rolled
// back (the worker discovers `cancelled` cooperatively at its next boundary — runFastImport's terminal guard).
const CANCELLABLE_STATES = new Set([
  "draft",
  "queued",
  "deferred",
  "validating",
  "staged",
  "running",
]);

importRoutes.post("/:jobId/cancel", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  const jobIdParam = c.req.param("jobId");
  if (!UUID_RE.test(jobIdParam) || !(await isImportV2Enabled(tenantId)))
    throw new NotFoundError("Import job not found.");

  const viewer = await buildJobViewer({ tenantId, workspaceId, userId: c.get("claims").sub });
  type CancelResult =
    | { kind: "not_found" }
    | { kind: "noop"; row: ImportJobRow }
    | { kind: "illegal"; status: string }
    | { kind: "cancelled"; row: ImportJobRow };
  const result = await withTenantTx({ tenantId, workspaceId }, async (tx): Promise<CancelResult> => {
    const row = await importJobRepository.getJobForUpdate(tx, viewer, jobIdParam);
    if (!row || row.workspaceId !== workspaceId) return { kind: "not_found" };
    if (row.status === "cancelled") return { kind: "noop", row };
    if (!CANCELLABLE_STATES.has(row.status)) return { kind: "illegal", status: row.status };
    await importJobRepository.updateJobStatus(tx, jobIdParam, {
      status: "cancelled",
      completedAt: new Date(),
      failedReason: "cancelled",
    });
    // In-tx audit (08 §7) — a cancel that can't record its actor can't commit. metadata is non-PII.
    await writeAudit(tx, {
      tenantId,
      workspaceId,
      actorUserId: viewer.userId,
      action: "import.cancelled",
      entityType: "import_job",
      entityId: jobIdParam,
      metadata: { fromStatus: row.status },
    });
    return { kind: "cancelled", row: { ...row, status: "cancelled", failedReason: "cancelled" } };
  });

  if (result.kind === "not_found") throw new NotFoundError("Import job not found.");
  if (result.kind === "illegal")
    throw new IllegalStateError(
      `An import in state '${result.status}' cannot be cancelled.`,
      result.status,
    );
  // noop (already cancelled) and cancelled both answer 200 with the current detail (idempotent verb, 08 §2.3).
  return c.json({ ...toLegacyResponseV2(result.row), ...toImportJobDetailV2(result.row) }, 200);
});

// ── S-I10: POST /imports/:jobId/retry-failed — the retry-failed CHILD job (08 §6.3, G05 retry half; 09 §2.2).
// A NEW v2 verb, strict from birth: a legacy (non-uuid) id or a gate-off tenant ⇒ 404 (no legacy retry existed;
// no existence oracle). Who may retry = creator ∪ elevated (the viewer predicate on the parent read; invisible ⇒
// 404 — the same S-I4/S-V5 rule). Only a TERMINAL partial/failed parent is retryable (else 409 illegal_state).
// The child is a fresh `import_jobs` row with `parent_job_id = :id`, mode/mapping/strategy/list INHERITED, and
// its rows sourced from the parent's failed+unprocessed LEDGER `input` (the durable equivalent of the repair
// CSV — Phase A has no FileStore in apps/api; Phase B re-extracts by row_index from the stored object). It counts
// against the per-workspace commit quota (08 §2.3) and sheds to `deferred` at the S-Q2 cap. `import.retry_created`
// audits in the SAME tx as the create. Idempotency-Key replay returns the same child (createJob's partial unique).
importRoutes.post("/:jobId/retry-failed", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  const claims = c.get("claims");
  const parentId = c.req.param("jobId");
  if (!UUID_RE.test(parentId) || !(await isImportV2Enabled(tenantId)))
    throw new NotFoundError("Import job not found.");

  const viewer = await buildJobViewer({ tenantId, workspaceId, userId: claims.sub });
  const idempotencyKey = c.req.header("idempotency-key") ?? null;
  const scope = { tenantId, workspaceId };

  type RetryResult =
    | { kind: "not_found" }
    | { kind: "illegal"; status: string }
    | { kind: "nothing" }
    | { kind: "replay"; jobId: string }
    | { kind: "created"; jobId: string; admission: "queued" | "deferred"; input: ImportFastInput };

  const result = await withTenantTx(scope, async (tx): Promise<RetryResult> => {
    // Creator ∪ elevated (the viewer predicate; invisible/foreign ⇒ 404, no IDOR side-door — S-I4/S-V5 rule).
    const parent = await importJobRepository.getJob(tx, viewer, parentId);
    if (!parent || parent.workspaceId !== workspaceId) return { kind: "not_found" };
    // Only a terminal partial/failed parent is retryable (08 §2.3); anything else ⇒ 409 illegal_state.
    if (parent.status !== "partial" && parent.status !== "failed")
      return { kind: "illegal", status: parent.status };
    // Phase-A source: the parent's failed+unprocessed ledger rows (== the repair CSV, regenerated). Empty ⇒
    // nothing to retry (a wholly-`failed` fast job wrote no per-row ledger) ⇒ 409 (08 §2.3 "nothing to retry").
    const rows = await importJobRepository.listRetryableRows(tx, parentId);
    if (rows.length === 0) return { kind: "nothing" };

    // Admission (S-Q2 cap): at/over the workspace cap ⇒ park `deferred` (visible backpressure), else `queued`.
    const admission = await decideFastAdmission(tx, workspaceId);
    // Inherit the parent's mapping + strategy + provider + list target (08 §6.3; a per-child override is future).
    const mapping = (parent.columnMapping ?? {}) as ColumnMapping;
    const strategy: ImportStrategy = {
      mergeMode: parent.mergeMode as ImportStrategy["mergeMode"],
      preservePopulated: parent.preservePopulated,
    };
    const parentConflict = (parent.conflictPolicy ?? undefined) as ConflictPolicy | undefined;
    const input: ImportFastInput = {
      importedByUserId: claims.sub,
      sourceName: parent.sourceName as SourceName,
      sourceFile: parent.sourceFilename ?? undefined,
      mapping,
      conflictPolicy: parentConflict,
      strategy,
      rows,
      target: parent.targetListId ? { listId: parent.targetListId } : undefined,
    };
    const { id: childId, created } = await importJobRepository.createJob(tx, {
      tenantId,
      workspaceId,
      createdByUserId: claims.sub,
      status: admission,
      // No stored object on the Phase-A fast path (rows travel in the payload); the NOT NULL storage-key column
      // records an honest inline sentinel, the display filename inherits the parent's.
      sourceFile: `retry:${randomUUID()}`,
      sourceName: parent.sourceName,
      // S-S2: a retry child carries NO new bytes — its rows are the parent's ledger rows, admitted (and
      // scanned, when a scanner was configured) at the parent's upload. Inherit the parent's verdict rather
      // than minting a fresh 'skipped' (the no-new-'skipped' monitor excludes `retry:%` rows either way).
      avScanStatus: (parent.avScanStatus as AvScanStatus) ?? "skipped",
      idempotencyKey,
      columnMapping: mapping,
      conflictPolicy: parentConflict,
      targetListId: parent.targetListId ?? null,
      processingMode: "fast",
      sourceFilename: parent.sourceFilename ?? null,
      parentJobId: parentId,
      mergeMode: strategy.mergeMode,
      preservePopulated: strategy.preservePopulated,
    });
    // Idempotent replay: the same key collapsed onto the existing child — return it, no quota/audit/enqueue.
    if (!created) return { kind: "replay", jobId: childId };
    // Commit quota (08 §2.3 / 12 §5), enforced AFTER the create so the new row is included: > cap ⇒ 429,
    // throwing to roll THIS insert back. Replays never reach here, so the verb stays idempotent at the cap.
    const cap = IMPORT_MAX_COMMITS_PER_HOUR;
    if (cap > 0) {
      const since = new Date(Date.now() - 3_600_000);
      const recent = await importJobRepository.countJobsCreatedSince(tx, workspaceId, since);
      if (recent > cap)
        throw new ImportQuotaExceededError(
          `This workspace has reached its import limit of ${cap} per hour. Try again shortly.`,
          3600,
        );
    }
    // In-tx audit (08 §7): a retry that can't record its actor can't commit. metadata is non-PII (ids + count).
    await writeAudit(tx, {
      tenantId,
      workspaceId,
      actorUserId: viewer.userId,
      action: "import.retry_created",
      entityType: "import_job",
      entityId: childId,
      metadata: { parentJobId: parentId, retryRows: rows.length },
    });
    return { kind: "created", jobId: childId, admission, input };
  });

  if (result.kind === "not_found") throw new NotFoundError("Import job not found.");
  if (result.kind === "illegal")
    throw new IllegalStateError(
      `An import in state '${result.status}' cannot be retried.`,
      result.status,
    );
  if (result.kind === "nothing")
    throw new IllegalStateError("This import has no failed rows to retry.", "no_retryable_rows");
  if (result.kind === "replay") {
    const body: ImportJobRef = { jobId: result.jobId, status: "queued" };
    return c.json(body, 202);
  }
  // Fresh child: enqueue transport (rows ride the payload — the Phase-A bound). A deferred child carries the
  // re-check delay; the leader-locked sweep is the DB-truth promoter (S-Q2).
  await enqueueFastImport(
    { kind: "fast", jobId: result.jobId, scope, input: result.input },
    result.admission === "deferred" ? env.IMPORT_DEFER_RECHECK_DELAY_MS : 0,
  );
  const body: ImportJobRef = { jobId: result.jobId, status: "queued" };
  return c.json(body, 202);
});

// ── S-I8: PUT /imports/:jobId/mapping — save the draft's mapping document (08 §2.3/§3). Draft-only: the
// legality check runs against the LOCKED row (409 illegal_state otherwise; 404 for gate-off/legacy-id/
// invisible — no existence oracle). FULL REPLACE (naturally idempotent): the mapping (inline or from a
// saved template — the template's stored mapping applies when `mapping` is absent, and its id is recorded
// as provenance), the 08 §5 strategy pair (absent fields resolve to the workspace `import_policy` default —
// the S-I6 request→template→policy precedence; the TEMPLATE strategy layer waits on S-I2's strategy block),
// and the optional list target (absent = keep, null = clear). In-flow custom-field creation (08 §3.3) is
// the EXISTING typed-registry endpoint (`POST /api/v1/custom-fields`, ADR-0028) — the wizard calls it, then
// re-PUTs the mapping; nothing is duplicated here.
importRoutes.put("/:jobId/mapping", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  const jobIdParam = c.req.param("jobId");
  if (!UUID_RE.test(jobIdParam) || !(await isImportV2Enabled(tenantId)))
    throw new NotFoundError("Import job not found.");
  const scope = { tenantId, workspaceId };

  const parsed = importDraftMappingRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new ImportValidationError(
      "Body must carry a 'mapping' (canonical field → column header) or a 'templateId'.",
    );

  // Read-only resolution BEFORE the row lock (keeps the locked tx short): the template's stored mapping
  // (unknown/foreign template ⇒ 422 — RLS walls it, so foreign and absent are indistinguishable), the
  // workspace strategy defaults, and the list target's workspace check (D4 — never trusted).
  let templateMapping: ColumnMapping | null = null;
  if (parsed.data.templateId) {
    templateMapping = await applyMappingTemplate(scope, parsed.data.templateId);
    if (!templateMapping) throw new ImportValidationError("Unknown mapping template.");
  }
  const mapping = parsed.data.mapping ?? templateMapping ?? {};
  if (Object.keys(mapping).length === 0)
    throw new ImportValidationError("The mapping must map at least one column.");
  const policy = await importPolicyRepository.resolved(scope);
  const mergeMode: ImportMergeMode = parsed.data.mergeMode ?? policy.defaultMergeMode;
  const preservePopulated = parsed.data.preservePopulated ?? policy.defaultPreservePopulated;
  if (parsed.data.listId) await assertListInWorkspace({ scope, listId: parsed.data.listId });

  const viewer = await buildJobViewer({ tenantId, workspaceId, userId: c.get("claims").sub });
  type MappingResult =
    | { kind: "not_found" }
    | { kind: "illegal"; status: string }
    | { kind: "saved"; row: ImportJobRow };
  const result = await withTenantTx(scope, async (tx): Promise<MappingResult> => {
    const row = await importJobRepository.getJobForUpdate(tx, viewer, jobIdParam);
    if (!row || row.workspaceId !== workspaceId) return { kind: "not_found" };
    if (row.status !== "draft") return { kind: "illegal", status: row.status };
    await importJobRepository.updateDraftMapping(tx, jobIdParam, {
      columnMapping: mapping,
      mergeMode,
      preservePopulated,
      // Full-replace provenance: a PUT without a template CLEARS the pointer (templates are copies, never
      // live references — 08 §3.1); listId absent = keep the upload's target, explicit null = clear.
      mappingTemplateId: parsed.data.templateId ?? null,
      targetListId: parsed.data.listId === undefined ? undefined : parsed.data.listId,
    });
    return {
      kind: "saved",
      row: {
        ...row,
        columnMapping: mapping,
        mergeMode,
        preservePopulated,
        mappingTemplateId: parsed.data.templateId ?? null,
        targetListId: parsed.data.listId === undefined ? row.targetListId : parsed.data.listId,
      },
    };
  });

  if (result.kind === "not_found") throw new NotFoundError("Import job not found.");
  if (result.kind === "illegal")
    throw new IllegalStateError(
      `An import in state '${result.status}' cannot change its mapping.`,
      result.status,
    );
  return c.json({ ...toLegacyResponseV2(result.row), ...toImportJobDetailV2(result.row) }, 200);
});

// ── S-I8: POST /imports/:jobId/preview — the draft's FULL-PASS projection (08 §4). Read-shaped (no state
// change beyond the non-PII `preview_summary` cache) but POST because it does real work; rides the shared
// rateLimit (the stricter CPU bucket of 08 §2.3 is the S-V5-noted config gap — no per-route knob yet).
// Draft-only (409 otherwise); 404 for gate-off/legacy-id/invisible. THE SCAN IS BOUNDED: the CSV byte
// pre-gate refuses off the row's recorded size BEFORE the object is read and the routing row ceiling
// (BULK_IMPORT_THRESHOLD_ROWS) is enforced post-parse — the preview can never scan past the fast-path pair
// the commit itself admits (08 §1/12 §5), so worst case is the same ≤ 10 MiB/5k-row work as the one-shot
// request thread. Sample rows are recomputed per request and NEVER persisted (T12's non-PII half).
importRoutes.post("/:jobId/preview", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  const jobIdParam = c.req.param("jobId");
  if (!UUID_RE.test(jobIdParam) || !(await isImportV2Enabled(tenantId)))
    throw new NotFoundError("Import job not found.");
  const scope = { tenantId, workspaceId };
  const viewer = await buildJobViewer({ tenantId, workspaceId, userId: c.get("claims").sub });

  const job = await withTenantTx(scope, (tx) =>
    importJobRepository.getJob(tx, viewer, jobIdParam),
  );
  if (!job || job.workspaceId !== workspaceId) throw new NotFoundError("Import job not found.");
  if (job.status !== "draft")
    throw new IllegalStateError(
      `An import in state '${job.status}' cannot be previewed.`,
      job.status,
    );
  const mapping = (job.columnMapping ?? {}) as ColumnMapping;
  if (Object.keys(mapping).length === 0)
    throw new ImportValidationError("Save a column mapping before previewing.");

  const filename = job.sourceFilename ?? job.sourceFile;
  assertDraftReadable(filename, job.fileSize);
  const bytes = await readDraftSourceObject(job.sourceFile);
  const parsed = parseDraftSource(bytes, filename);
  // The same measured ceiling commit enforces (S-I5) — an over-threshold draft learns it here, honestly,
  // instead of after mapping work; also the preview's own scan bound (nothing above the pair is scanned).
  assertFastPathRouting(filename, job.fileSize ?? bytes.byteLength, parsed.rows.length);

  // Full pass + batched dedup lookups under ONE RLS-scoped tx; the non-PII summary caches on the row in
  // the same tx (draft-pinned write — a raced commit just drops the cache, the projection is re-derivable).
  const result = await withTenantTx(scope, async (tx) => {
    const r = await buildDraftPreviewSummary(tx, workspaceId, parsed.rows, mapping);
    await importJobRepository.savePreviewSummary(tx, jobIdParam, r.summary);
    return r;
  });
  const body: ImportDraftPreviewResponse = {
    summary: result.summary,
    sampleRejectedRows: result.sampleRejectedRows,
  };
  return c.json(body, 200);
});

// ── S-I8: POST /imports/:jobId/commit — draft → queued/deferred (08 §2.3). The S-I5 routing pre-gate runs
// HERE, at commit, from measured facts (re-parsed rows + recorded bytes — never a client hint); admission
// (S-Q2 cap), the commit quota, the enqueue, and the payload shape are EXACTLY the one-shot's fast lane
// (Phase A: rows travel in the BullMQ payload — the sanctioned transport bound, memory-capped by the same
// fast-path pair the routing gate enforces; Phase B slims it to {jobId, scope}). Idempotency-Key REQUIRED
// (08 §2.3): the key is recorded on the row (`options.commitIdempotencyKey`) and a replay returns the same
// 202 without a second transition/enqueue (BullMQ's stable `import-fast:<jobId>` id dedupes transport
// anyway). Draft-only against the LOCKED row: 409 illegal_state otherwise (422 while no mapping is saved);
// 404 for gate-off/legacy-id/invisible. `import.committed` audits IN-TX (08 §7 — in the 0054 CHECK).
importRoutes.post("/:jobId/commit", async (c) => {
  const workspaceId = c.get("workspaceId");
  if (!workspaceId)
    throw new ForbiddenError("no_workspace", "Select a workspace before importing.");
  const tenantId = c.get("tenantId");
  const claims = c.get("claims");
  const jobIdParam = c.req.param("jobId");
  if (!UUID_RE.test(jobIdParam) || !(await isImportV2Enabled(tenantId)))
    throw new NotFoundError("Import job not found.");
  const scope = { tenantId, workspaceId };
  const idempotencyKey = c.req.header("idempotency-key");
  if (!idempotencyKey)
    throw new ImportValidationError("An Idempotency-Key header is required to commit an import.");

  const viewer = await buildJobViewer({ tenantId, workspaceId, userId: claims.sub });

  // Phase 1 (no lock): state/mapping checks + the bounded re-parse OFF the row lock — the stored object is
  // immutable after upload (no re-upload verb exists), so parsing outside the lock is race-free; the locked
  // phase below re-checks the state before transitioning.
  const job = await withTenantTx(scope, (tx) =>
    importJobRepository.getJob(tx, viewer, jobIdParam),
  );
  if (!job || job.workspaceId !== workspaceId) throw new NotFoundError("Import job not found.");
  const priorKey = (job.options as Record<string, unknown> | null)?.commitIdempotencyKey;
  if (job.status !== "draft") {
    if (priorKey === idempotencyKey) {
      const replay: ImportJobRef = { jobId: job.id, status: "queued" };
      return c.json(replay, 202);
    }
    throw new IllegalStateError(
      `An import in state '${job.status}' cannot be committed.`,
      job.status,
    );
  }
  const mapping = (job.columnMapping ?? {}) as ColumnMapping;
  if (Object.keys(mapping).length === 0)
    throw new ImportValidationError("Save a column mapping before committing.");

  const filename = job.sourceFilename ?? job.sourceFile;
  assertDraftReadable(filename, job.fileSize);
  const bytes = await readDraftSourceObject(job.sourceFile);
  const parsed = parseDraftSource(bytes, filename);
  // S-I5: the server's routing decision, once, at commit. Over-threshold ⇒ the honest refusal until the
  // copy gates clear (the draft STAYS a draft — re-uploadable smaller, cancellable, or reaped at TTL).
  assertFastPathRouting(filename, job.fileSize ?? bytes.byteLength, parsed.rows.length);

  const strategy: ImportStrategy = {
    mergeMode: job.mergeMode as ImportMergeMode,
    preservePopulated: job.preservePopulated,
  };
  const input: ImportFastInput = {
    // Attribution stays the draft's creator (the committer is the creator ∪ elevated by the viewer gate).
    importedByUserId: job.createdByUserId ?? claims.sub,
    sourceName: job.sourceName as SourceName,
    sourceFile: job.sourceFilename ?? undefined,
    mapping,
    conflictPolicy: (job.conflictPolicy ?? undefined) as ConflictPolicy | undefined,
    strategy,
    rows: parsed.rows,
    target: job.targetListId ? { listId: job.targetListId } : undefined,
  };

  type CommitResult =
    | { kind: "not_found" }
    | { kind: "illegal"; status: string }
    | { kind: "replay" }
    | { kind: "committed"; admission: "queued" | "deferred" };
  const result = await withTenantTx(scope, async (tx): Promise<CommitResult> => {
    const row = await importJobRepository.getJobForUpdate(tx, viewer, jobIdParam);
    if (!row || row.workspaceId !== workspaceId) return { kind: "not_found" };
    if (row.status !== "draft") {
      const k = (row.options as Record<string, unknown> | null)?.commitIdempotencyKey;
      return k === idempotencyKey ? { kind: "replay" } : { kind: "illegal", status: row.status };
    }
    // Commit quota (08 §2.3 / 12 §5): drafts are excluded from the census, so this commit counts as +1 —
    // the same soft posture as the retry verb (±1 under a race; the quota throw rolls the tx back).
    const cap = IMPORT_MAX_COMMITS_PER_HOUR;
    if (cap > 0) {
      const since = new Date(Date.now() - 3_600_000);
      const recent = await importJobRepository.countJobsCreatedSince(tx, workspaceId, since);
      if (recent + 1 > cap)
        throw new ImportQuotaExceededError(
          `This workspace has reached its import limit of ${cap} per hour. Try again shortly.`,
          3600,
        );
    }
    // S-Q2 admission: at/over the workspace cap the job parks `deferred` (visible backpressure).
    const admission = await decideFastAdmission(tx, workspaceId);
    await importJobRepository.updateJobStatus(tx, jobIdParam, {
      status: admission,
      // The routing verdict, recorded where it was decided (Phase A: always fast — copy is S-I9's).
      processingMode: "fast",
      options: {
        ...((row.options as Record<string, unknown> | null) ?? {}),
        commitIdempotencyKey: idempotencyKey,
      },
    });
    // In-tx audit (08 §7): a commit that can't record its actor can't commit. Metadata is non-PII.
    await writeAudit(tx, {
      tenantId,
      workspaceId,
      actorUserId: viewer.userId,
      action: "import.committed",
      entityType: "import_job",
      entityId: jobIdParam,
      metadata: { rows: parsed.rows.length, mode: "fast", admission },
    });
    return { kind: "committed", admission };
  });

  if (result.kind === "not_found") throw new NotFoundError("Import job not found.");
  if (result.kind === "illegal")
    throw new IllegalStateError(
      `An import in state '${result.status}' cannot be committed.`,
      result.status,
    );
  if (result.kind === "committed") {
    // Transport exactly like the one-shot (a deferred job still gets its delayed cooperative re-check).
    await enqueueFastImport(
      { kind: "fast", jobId: jobIdParam, scope, input },
      result.admission === "deferred" ? env.IMPORT_DEFER_RECHECK_DELAY_MS : 0,
    );
  }
  const body: ImportJobRef = { jobId: jobIdParam, status: "queued" };
  return c.json(body, 202);
});
