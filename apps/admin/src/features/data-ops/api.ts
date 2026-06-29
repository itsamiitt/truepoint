// api.ts — the Data-Ops Overview slice's data access: a typed, authenticated read against the apps/api
// `/admin/data/*` surface via the in-memory access token (fetchWithAuth, ADR-0016), mirroring the Imports /
// Tenants read slices. The console NEVER touches the database directly — the cross-tenant read goes through the
// audited api endpoint (ADR-0011 / ADR-0032), which gates on the data:read capability. Read-only: this surface
// has no mutations. The slice's only network seam.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { DataImportDetail, DataOpsOverview } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/data/overview — the cross-tenant data-ops rollup (counts/tallies only; bounded by the api). */
export async function fetchDataOpsOverview(): Promise<DataOpsOverview> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/overview`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the data-ops overview"));
  return (await res.json()) as DataOpsOverview;
}

/** GET /admin/data/imports/:jobId — one bulk-import job's metadata + per-status chunk tally (counts only, no PII). */
export async function fetchDataImportDetail(jobId: string): Promise<DataImportDetail> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data/imports/${jobId}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load the import job"));
  return (await res.json()) as DataImportDetail;
}
