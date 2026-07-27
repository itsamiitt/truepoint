// useEnrichmentJobs.ts — the workspace's enrichment jobs (GET /enrichment/jobs), polled while ANY visible job
// is still in flight so status/progress/counts update without a manual refresh (31 §8 "poll now; SSE on M12").
// Polling stops once every job is terminal and resumes when a fresh job appears.
//
// `refetchInterval` reads the current data to decide whether to schedule the next tick, which is exactly the
// condition the hand-rolled timer expressed — minus the two things it got wrong: it kept polling a hidden tab,
// and a reload racing a pending tick needed explicit cancellation to stop the slow tick from reverting to
// stale rows. RQ will not overlap a fetch with itself.
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchEnrichmentJobs } from "../api";
import { enrichmentJobKeys } from "../keys";
import { type EnrichmentJobSummary, TERMINAL_STATUSES } from "../types";

/** Poll cadence while a job is in flight (ms). Conservative — these jobs run for minutes, not seconds. */
const POLL_INTERVAL_MS = 5_000;

const terminal = new Set<string>(TERMINAL_STATUSES);

/** True when at least one job is still in flight (so the surface should keep polling). */
function anyInFlight(jobs: EnrichmentJobSummary[]): boolean {
  return jobs.some((j) => !terminal.has(j.status));
}

export function useEnrichmentJobs() {
  const query = useQuery<EnrichmentJobSummary[]>({
    queryKey: enrichmentJobKeys.list(),
    queryFn: fetchEnrichmentJobs,
    refetchInterval: (q) => (anyInFlight(q.state.data ?? []) ? POLL_INTERVAL_MS : false),
  });

  const jobs = query.data ?? [];

  return {
    jobs,
    // A transient poll failure must not blow away the table: RQ keeps the last good data alongside the error,
    // so both are surfaced and the rows stay put.
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load your enrichment jobs"
      : null,
    loading: query.isPending,
    reload: async () => {
      await query.refetch();
    },
    polling: !query.isPending && anyInFlight(jobs),
  };
}
