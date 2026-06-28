// api.ts — the home slice's data access: a single typed, authenticated call to apps/api via the in-memory
// access token (fetchWithAuth, ADR-0016). GET /home/summary returns the whole cockpit (HomeSummary) in one
// PII-safe payload, so the slice no longer composes it client-side. The slice's only seam to the backend.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { HomeSummary, WorkspaceDataQuality } from "./types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** Load the whole Home cockpit in one call. */
export async function fetchHomeSummary(): Promise<HomeSummary> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/summary`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your workspace summary"));
  return (await res.json()) as HomeSummary;
}

/** Load the per-workspace Data Health rollup (coverage / deliverability / freshness counts). */
export async function fetchDataQuality(): Promise<WorkspaceDataQuality> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/home/data-quality`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your data health"));
  return (await res.json()) as WorkspaceDataQuality;
}
