// api.ts — the Data-quality slice's data access: a single typed, authenticated read against the apps/api
// `/admin/data-quality` surface via the in-memory access token (fetchWithAuth, ADR-0016). No direct DB access
// from the console (ADR-0011 / ADR-0034). The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { DataQuality } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** GET /admin/data-quality — cross-tenant DQ rollup + the re-verification ledger over a `days` window. */
export async function fetchDataQuality(days?: number): Promise<DataQuality> {
  const qs = days ? `?days=${encodeURIComponent(days)}` : "";
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/data-quality${qs}`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load data quality"));
  return (await res.json()) as DataQuality;
}
