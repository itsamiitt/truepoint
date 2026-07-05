// routes.ts — HTTP wiring for the import feature (05 §3). POST accepts a multipart upload (the CSV/XLSX file +
// a JSON column mapping + the source + an optional target listId), parses it on the request thread, then
// ENQUEUES the parsed rows onto the `imports` queue and returns 202 + a job ref — the heavy per-row dedup/
// encrypt/DB work runs in the apps/workers consumer (processImport → the SAME packages/core runImport). This
// file does only transport (parse the request, enqueue, shape the response) and no business logic. The
// workspace is taken from the VERIFIED token via the tenancy middleware, never the request body (16 §7); the
// client-supplied listId is validated against that workspace before enqueue (list-plan D4 — never trusted).

import { assertListInWorkspace, buildImportPreview, parseImportFile } from "@leadwolf/core";
import {
  type ColumnMapping,
  DEFAULT_CONFLICT_POLICY,
  ForbiddenError,
  type ImportJobRef,
  type ImportJobStatus,
  type ImportJobStatusResponse,
  type ImportPreview,
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
import { requireImportCreateGrant } from "./createGrant.ts";
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

  const job = await getImportJob(c.req.param("jobId"));
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
