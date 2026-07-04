// api.ts — the import slice's data access: typed, authenticated calls to apps/api. Uses the in-memory
// access token via fetchWithAuth (ADR-0016); never talks to the DB or the auth origin directly. The slice's
// only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  BulkImportJobStatusResponse,
  ColumnMapping,
  ConflictPolicy,
  ImportJobRef,
  ImportJobStatusResponse,
  ImportMappingTemplate,
  ImportMappingTemplateList,
  ImportPreview,
  MaskedContact,
  SourceName,
} from "@leadwolf/types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/**
 * Enqueue an import. The backend processes the file in a background worker (apps/workers) and returns 202 +
 * a job ref immediately — NOT the summary. The real `ImportSummary` is fetched later via `getImportJob`.
 */
export async function postImport(args: {
  file: File;
  sourceName: SourceName;
  mapping: ColumnMapping;
  conflictPolicy: ConflictPolicy;
  /** Optional "import into list" target (list-plan/03 §2.2): landed rows are added to this list. Server-
   *  validated against the caller's workspace — the id is never trusted client-side. */
  listId?: string;
}): Promise<ImportJobRef> {
  const form = new FormData();
  form.set("file", args.file);
  form.set("sourceName", args.sourceName);
  form.set("mapping", JSON.stringify(args.mapping));
  form.set("conflictPolicy", args.conflictPolicy);
  if (args.listId) form.set("listId", args.listId);
  const res = await fetchWithAuth(`${API_BASE}/api/v1/imports`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await problemMessage(res, "Import failed"));
  return (await res.json()) as ImportJobRef;
}

/**
 * Pre-commit validation preview (G-IMP-1): upload the file + mapping and get back counts (total/valid/
 * rejected/duplicate) + sample rejected rows WITHOUT enqueuing an import. The wizard requires the user to
 * confirm this before running the real import.
 */
export async function postImportPreview(args: {
  file: File;
  sourceName: SourceName;
  mapping: ColumnMapping;
}): Promise<ImportPreview> {
  const form = new FormData();
  form.set("file", args.file);
  form.set("sourceName", args.sourceName);
  form.set("mapping", JSON.stringify(args.mapping));
  const res = await fetchWithAuth(`${API_BASE}/api/v1/imports/preview`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not validate import"));
  return (await res.json()) as ImportPreview;
}

/**
 * Poll one import job's status. Mirrors `GET /api/v1/imports/:jobId` (apps/api import routes), which always
 * returns the full status envelope: `summary` is non-null only once `status === "completed"`, and
 * `failedReason` carries the message when `status === "failed"`.
 */
export async function getImportJob(jobId: string): Promise<ImportJobStatusResponse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/imports/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not check import status"));
  return (await res.json()) as ImportJobStatusResponse;
}

// ── Bulk import (the big-file COPY-staging path; backlog #2). Gated DARK behind env.BULK_IMPORT_ENABLED on the
// server: while off, the route answers 403 `bulk_import_disabled` and this slice surfaces a clear "not enabled"
// state — NOT a generic failure. Only the status poll remains client-side: the wizard's client-side bulk POST
// fork was deleted with the "Large file" toggle (import-redesign 11 §1.4, S-U1) — how a file is processed is
// the SERVER's commit-time decision, the UI never asks. This read backs the legacy /imports/[jobId] progress
// page until Phase C retires that surface (08 §1.2). ──

/** Thrown when a bulk route answers 403 `bulk_import_disabled` (the feature flag is off). The hook + components
 *  branch on this to show a clear "Bulk import isn't enabled" message instead of a generic error. */
export class BulkImportDisabledError extends Error {
  readonly disabled = true as const;
  constructor(message = "Bulk import is not enabled.") {
    super(message);
    this.name = "BulkImportDisabledError";
  }
}

/** Read an RFC-9457 problem body (machine code + human message), tolerating a non-JSON / empty body. */
async function readProblem(
  res: Response,
): Promise<{ code?: string; detail?: string; title?: string }> {
  return (
    ((await res.json().catch(() => null)) as {
      code?: string;
      detail?: string;
      title?: string;
    } | null) ?? {}
  );
}

/** Map a non-ok bulk response to an Error — a 403 `bulk_import_disabled` becomes the typed disabled error. */
async function bulkError(res: Response, fallback: string): Promise<Error> {
  const p = await readProblem(res);
  if (res.status === 403 && p.code === "bulk_import_disabled") {
    return new BulkImportDisabledError(p.detail ?? p.title ?? "Bulk import is not enabled.");
  }
  return new Error(p.detail ?? p.title ?? `${fallback} (${res.status})`);
}

/** Poll one bulk-import job's status / counts (GET /imports/bulk/:jobId). A 403 `bulk_import_disabled` throws the
 *  typed disabled error so the polling surface shows the "not enabled" state rather than a generic failure. */
export async function getBulkImportJob(jobId: string): Promise<BulkImportJobStatusResponse> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/imports/bulk/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw await bulkError(res, "Could not check the bulk import status");
  return (await res.json()) as BulkImportJobStatusResponse;
}

const TEMPLATES_BASE = `${API_BASE}/api/v1/imports/mapping-templates`;

/** List the workspace's saved column-mapping templates (the picker's data). */
export async function listMappingTemplates(): Promise<ImportMappingTemplate[]> {
  const res = await fetchWithAuth(TEMPLATES_BASE);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load mapping templates"));
  const data = (await res.json()) as ImportMappingTemplateList;
  return data.templates;
}

/** Save (UPSERT by name) the current column mapping as a named template. Returns the persisted template. */
export async function saveMappingTemplate(args: {
  name: string;
  mapping: ColumnMapping;
}): Promise<ImportMappingTemplate> {
  const res = await fetchWithAuth(TEMPLATES_BASE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(await problemMessage(res, "Could not save template"));
  return (await res.json()) as ImportMappingTemplate;
}

export async function fetchContacts(): Promise<MaskedContact[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load contacts"));
  const data = (await res.json()) as { contacts: MaskedContact[] };
  return data.contacts;
}
