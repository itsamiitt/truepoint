// api.ts — the enrichment-jobs slice's data access: typed, authenticated reads against apps/api via the
// in-memory access token (fetchWithAuth, ADR-0016). GET /enrichment/jobs lists this workspace's jobs;
// GET /enrichment/jobs/:jobId fetches one. READ-only — the surface never mutates a job. The slice's only seam
// to the backend; the response shapes are the @leadwolf/types contract so producer + consumer can't drift.

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { EnrichmentJobListResponse, EnrichmentJobSummary } from "@leadwolf/types";

async function problemMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; title?: string } | null;
  return body?.detail ?? body?.title ?? `${fallback} (${res.status})`;
}

/** List this workspace's enrichment jobs (most-recent first). */
export async function fetchEnrichmentJobs(): Promise<EnrichmentJobSummary[]> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/enrichment/jobs`);
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load your enrichment jobs"));
  const body = (await res.json()) as EnrichmentJobListResponse;
  return body.jobs;
}

/** Fetch one enrichment job's status detail. */
export async function fetchEnrichmentJob(jobId: string): Promise<EnrichmentJobSummary> {
  const res = await fetchWithAuth(
    `${API_BASE}/api/v1/enrichment/jobs/${encodeURIComponent(jobId)}`,
  );
  if (!res.ok) throw new Error(await problemMessage(res, "Could not load this enrichment job"));
  return (await res.json()) as EnrichmentJobSummary;
}
