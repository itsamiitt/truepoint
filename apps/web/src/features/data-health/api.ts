// api.ts — the Data Health slice's data access: typed, authenticated reads of the per-workspace Data Health
// endpoints (mirrors features/home/api.ts — the same fetchWithAuth + problemMessage seam, ADR-0016). This slice
// reuses the EXISTING GET /home/data-quality* endpoints (no new backend); it is a dedicated destination view over
// the same workspace-scoped, PII-safe rollups the Home cockpit cards read. The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { DataQualityTrendPoint, ReverificationRun, WorkspaceDataQuality } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** Load the per-workspace Data Health rollup (coverage / deliverability / freshness counts). */
export async function fetchDataQuality(): Promise<WorkspaceDataQuality> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/data-quality`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your data health"));
  return (await res.json()) as WorkspaceDataQuality;
}

/** Load the per-workspace Data Health trend series (newest first). */
export async function fetchDataQualityHistory(): Promise<DataQualityTrendPoint[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/data-quality/history`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your data health history"));
  return (await res.json()) as DataQualityTrendPoint[];
}

/** Load the per-workspace freshness re-verification runs (newest first). */
export async function fetchReverificationRuns(): Promise<ReverificationRun[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/data-quality/reverification-runs`);
  if (!res.ok) {
    throw new Error(await problemMessage(res, "Could not load your re-verification activity"));
  }
  return (await res.json()) as ReverificationRun[];
}
