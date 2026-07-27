// useEnrichmentJobDetail.ts — one enrichment job's fresh status detail (GET /enrichment/jobs/:jobId) for the
// drawer, so the detail view reflects a fresh server read rather than the possibly-stale list row. The caller
// falls back to the list row while this is in flight, so the drawer never flashes empty.
//
// Best-effort by design: a failed detail read returns null and the caller keeps showing the list row, which is
// why the error is not surfaced. Keying by job id is what makes the old race guard unnecessary — a response
// for a job the user has switched away from lands on that job's entry, not on the open one.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchEnrichmentJob } from "../api";
import { enrichmentJobKeys } from "../keys";
import type { EnrichmentJobSummary } from "../types";

export function useEnrichmentJobDetail(jobId: string | null): EnrichmentJobSummary | null {
  const query = useQuery<EnrichmentJobSummary>({
    queryKey: enrichmentJobKeys.detail(jobId ?? ""),
    enabled: jobId !== null,
    queryFn: () => fetchEnrichmentJob(jobId as string),
    retry: false,
  });

  return jobId ? (query.data ?? null) : null;
}
