// api.ts — the import slice's data access: typed, authenticated calls to apps/api. Uses the in-memory
// access token via fetchWithAuth (ADR-0016); never talks to the DB or the auth origin directly. The slice's
// only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type {
  ColumnMapping,
  ImportJobRef,
  ImportJobStatusResponse,
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
}): Promise<ImportJobRef> {
  const form = new FormData();
  form.set("file", args.file);
  form.set("sourceName", args.sourceName);
  form.set("mapping", JSON.stringify(args.mapping));
  const res = await fetchWithAuth(`${API_BASE}/api/v1/imports`, { method: "POST", body: form });
  if (!res.ok) throw new Error(await problemMessage(res, "Import failed"));
  return (await res.json()) as ImportJobRef;
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

export async function fetchContacts(): Promise<MaskedContact[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/contacts`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load contacts"));
  const data = (await res.json()) as { contacts: MaskedContact[] };
  return data.contacts;
}
