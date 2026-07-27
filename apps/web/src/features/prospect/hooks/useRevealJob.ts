// useRevealJob.ts — polls a single async bulk-reveal job until it reaches a terminal state (completed /
// failed / cancelled).
//
// The self-rescheduling setTimeout this replaces is `refetchInterval` returning false once the row is
// terminal. Two things the manual version could not do: it kept polling a hidden tab, and a transient error
// stopped the chain entirely — the catch never rescheduled, so one failed poll left the job frozen on screen
// until something remounted it. RQ retries on its own schedule and keeps the last good row meanwhile.
"use client";

import { REVEAL_JOB_TERMINAL, type RevealJobSummary } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { fetchRevealJob } from "../api";
import { prospectKeys } from "../keys";

const POLL_MS = 2000;

export function useRevealJob(jobId: string | null): {
  job: RevealJobSummary | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const query = useQuery<RevealJobSummary>({
    queryKey: prospectKeys.revealJob(jobId ?? ""),
    enabled: jobId !== null,
    queryFn: () => fetchRevealJob(jobId as string),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      // Keep polling until the job is terminal; an unknown status (nothing loaded yet) also keeps polling.
      return status && REVEAL_JOB_TERMINAL.has(status) ? false : POLL_MS;
    },
  });

  return {
    job: jobId ? (query.data ?? null) : null,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Could not load job"
      : null,
    reload: async () => {
      await query.refetch();
    },
  };
}
