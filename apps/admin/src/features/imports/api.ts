// api.ts — the Imports-monitor slice's data access: a typed, authenticated read against the apps/api `/admin/*`
// surface via the in-memory access token (fetchWithAuth, ADR-0016), mirroring the Tenants/Users read slices.
// The console NEVER touches the database directly — the cross-tenant read goes through the audited api endpoint
// (ADR-0011 / ADR-0032). Read-only: this surface has no mutations. The slice's only seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { ImportJobRow } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/import-jobs — recent bulk-import jobs across all tenants (bounded + newest-first by the api). */
export async function fetchImportJobs(): Promise<ImportJobRow[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/import-jobs`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load import jobs"));
  const body = (await res.json()) as { jobs: ImportJobRow[] };
  return body.jobs;
}
