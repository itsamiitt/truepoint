// submitCopyImport.ts — the ONE store-then-enqueue copy submission (import-and-data-model-redesign 08 §1.2
// Phase C, S-I9): create the `import_jobs` control row (`processing_mode='copy'`), stream the raw upload to
// the FileStore, and enqueue the single DRIVE job — the worker stages + fans out off the request path. This
// is the shipped `POST /imports/bulk` internals EXTRACTED so the legacy bulk route becomes a THIN DELEGATE
// over it and the unified one-shot POST reuses it instead of duplicating (08 §2.4's delegation window: one
// engine, two entry surfaces for one release window, then the bulk surface retires — 15 seq 43).
//
// Ordering is the shipped bulk idiom, kept exactly: create the row FIRST (short tx) so an Idempotency-Key
// re-submit is detected BEFORE any bytes are streamed or a duplicate drive enqueued; store the object; THEN
// enqueue — the worker never reads a not-yet-written object, and a storage failure marks the job `failed`
// (best-effort) and surfaces. Dependency-injected like runBulkImport (FileStore + enqueue), so core stays
// BullMQ/Redis/SDK-free and the seam is itest-able against real Postgres with a collector queue.
//
// Trust boundary: callers pass a VERIFIED scope (tenancy middleware) and have already run admission + the
// AV scan (S-S1/S-S2 wire point 1 — scan strictly precedes storage) and validated any targetListId against
// the workspace (list-plan D4). The filename is untrusted: it rides only as the display `source_filename`
// and a SANITIZED extension inside the object key — never a path.

import { randomUUID } from "node:crypto";
import { importJobRepository, withTenantTx } from "@leadwolf/db";
import type {
  AvScanStatus,
  BulkImportScope,
  ColumnMapping,
  ConflictPolicy,
  ImportMergeMode,
  SourceName,
} from "@leadwolf/types";
import type { FileStore } from "../storage/fileStore.ts";

/** Sanitized lowercase extension for the deterministic source key — alnum only, defaults to `csv` (the
 *  shipped bulkRoutes/draft idiom; the disk adapter is traversal-guarded on top). */
export function copySourceExt(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext || "csv";
}

export interface SubmitCopyImportInput {
  scope: BulkImportScope;
  createdByUserId: string;
  sourceName: SourceName;
  /** Untrusted display filename (source_filename + the sanitized key extension only). */
  fileName: string;
  fileSize: number;
  /** Re-openable body source — called at most once, only for a freshly-created job (an idempotent replay
   *  streams nothing). `File.stream()` is blob-backed and re-readable per call, so `() => file.stream()`
   *  is the api's shape even after admission/scan consumed a read. */
  body: () => ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array;
  avScanStatus: AvScanStatus;
  idempotencyKey: string | null;
  columnMapping: ColumnMapping;
  conflictPolicy?: ConflictPolicy;
  targetListId?: string | null;
  /** The resolved 08 §5 strategy pair (S-I6) — omitted by the legacy bulk delegate (its engine keeps
   *  reading `conflictPolicy`; the columns take their policy-matching defaults). */
  mergeMode?: ImportMergeMode;
  preservePopulated?: boolean;
  fileStore: FileStore;
  /** The drive producer, injected (the api passes enqueueBulkImportDrive — stable id `import-drive:<jobId>`,
   *  copy-drive priority band, backpressure shed inside). */
  enqueueDrive: (jobId: string, scope: BulkImportScope) => Promise<unknown>;
}

export interface SubmitCopyImportResult {
  jobId: string;
  /** false = the Idempotency-Key collapsed onto an existing job (nothing stored, nothing enqueued). */
  created: boolean;
}

export async function submitCopyImport(
  input: SubmitCopyImportInput,
): Promise<SubmitCopyImportResult> {
  const { scope } = input;
  // Deterministic object key minted BEFORE create (createJob assigns the jobId from the DB default and
  // source_file is NOT NULL at insert — the shipped bulk idiom).
  const sourceKey = `imports/${randomUUID()}/source.${copySourceExt(input.fileName)}`;

  const { id: jobId, created } = await withTenantTx(scope, (tx) =>
    importJobRepository.createJob(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      createdByUserId: input.createdByUserId,
      // status defaults to 'queued' (the shipped bulk posture); the poll reads the durable row.
      sourceFile: sourceKey,
      sourceName: input.sourceName,
      fileSize: input.fileSize,
      avScanStatus: input.avScanStatus,
      idempotencyKey: input.idempotencyKey,
      columnMapping: input.columnMapping,
      conflictPolicy: input.conflictPolicy,
      targetListId: input.targetListId ?? null,
      // The server's routing verdict, recorded where it was decided (08 §1) — also what the reaper's
      // mode-split keys on (a copy row is RE-DRIVABLE from the stored object; a fast row is not).
      processingMode: "copy",
      sourceFilename: input.fileName,
      ...(input.mergeMode !== undefined ? { mergeMode: input.mergeMode } : {}),
      ...(input.preservePopulated !== undefined
        ? { preservePopulated: input.preservePopulated }
        : {}),
    }),
  );

  if (created) {
    // Stream the raw upload to the FileStore (constant memory), AFTER the row exists so an idempotent
    // re-submit never re-streams; on storage failure mark the job failed (best-effort) and surface it.
    try {
      await input.fileStore.putObject(sourceKey, input.body());
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
    // Enqueue the drive LAST — the worker never races a not-yet-written object. A backpressure shed here
    // (typed 503 from the injected producer) leaves the row honestly `queued` with no transport; the S-Q5
    // reaper's copy_redrive re-publishes it from the durable row (the shipped bulk posture, unchanged).
    await input.enqueueDrive(jobId, scope);
  }

  return { jobId, created };
}
