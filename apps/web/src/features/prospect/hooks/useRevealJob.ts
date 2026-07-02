// useRevealJob.ts — polls a single async bulk-reveal job's status/progress until it reaches a terminal state
// (completed / failed / cancelled). Vanilla React (no query lib): a self-rescheduling timeout that stops once
// the job is terminal; a transient poll error keeps the last-good row. Mirrors the enrichment-jobs poller.
"use client";

import { REVEAL_JOB_TERMINAL, type RevealJobSummary } from "@leadwolf/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchRevealJob } from "../api";

const POLL_MS = 2000;

export function useRevealJob(jobId: string | null): {
  job: RevealJobSummary | null;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [job, setJob] = useState<RevealJobSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poll = useCallback(async () => {
    if (!jobId) return;
    try {
      const j = await fetchRevealJob(jobId);
      setJob(j);
      setError(null);
      if (!REVEAL_JOB_TERMINAL.has(j.status)) {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void poll(), POLL_MS);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load job");
    }
  }, [jobId]);

  useEffect(() => {
    setJob(null);
    setError(null);
    if (timer.current) clearTimeout(timer.current);
    if (jobId) void poll();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [jobId, poll]);

  return { job, error, reload: poll };
}
