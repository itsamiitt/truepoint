// useEnrichmentJobDetail.ts — fetches one enrichment job's fresh status detail (GET /enrichment/jobs/:jobId)
// when the drawer opens, so the detail view reflects a fresh server read rather than the possibly-stale list
// row. Re-fetches whenever the selected id changes; clears when nothing is selected. The caller falls back to
// the list row while this load is in flight, so the drawer never flashes empty. READ-only; presentation state.
"use client";

import { useEffect, useState } from "react";
import { fetchEnrichmentJob } from "../api";
import type { EnrichmentJobSummary } from "../types";

export function useEnrichmentJobDetail(jobId: string | null) {
  const [detail, setDetail] = useState<EnrichmentJobSummary | null>(null);

  useEffect(() => {
    if (jobId == null) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetail(null);
    void fetchEnrichmentJob(jobId)
      .then((d) => {
        // Guard against a races: ignore a response for a job the user has since closed/switched away from.
        if (active) setDetail(d);
      })
      .catch(() => {
        // Best-effort: on a detail-fetch failure the caller falls back to the list row, so swallow here.
      });
    return () => {
      active = false;
    };
  }, [jobId]);

  return detail;
}
