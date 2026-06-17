// useEnrichmentJobs.ts — loads the workspace's enrichment jobs (GET /enrichment/jobs) with loading/error state
// and live polling: while ANY visible job is still in flight (not completed/failed/cancelled), it re-fetches on
// a fixed interval so status/progress/counts update without a manual refresh (31 §8 "poll now; SSE on M12").
// Polling pauses once every job is terminal and resumes if a fresh job appears on a manual reload. Presentation
// state only — the typed fetch lives in api.ts and the shape comes from @leadwolf/types.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchEnrichmentJobs } from "../api";
import { type EnrichmentJobSummary, TERMINAL_STATUSES } from "../types";

/** Poll cadence while a job is in flight (ms). Conservative — these jobs run for minutes, not seconds. */
const POLL_INTERVAL_MS = 5_000;

const terminal = new Set<string>(TERMINAL_STATUSES);

/** True when at least one job is still in flight (so the surface should keep polling). */
function anyInFlight(jobs: EnrichmentJobSummary[]): boolean {
  return jobs.some((j) => !terminal.has(j.status));
}

export function useEnrichmentJobs() {
  const [jobs, setJobs] = useState<EnrichmentJobSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A polling tick: refetch WITHOUT toggling the page-level loading spinner (the table just updates in place).
  const poll = useCallback(async () => {
    try {
      const next = await fetchEnrichmentJobs();
      setJobs(next);
      setError(null);
    } catch (e) {
      // A transient poll failure shouldn't blow away the table — surface it but keep the last-good rows.
      setError(e instanceof Error ? e.message : "Failed to refresh your enrichment jobs");
    }
  }, []);

  const reload = useCallback(async () => {
    // Cancel any pending poll so a slow in-flight tick can't land AFTER this reload and revert to stale rows.
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setLoading(true);
    setError(null);
    try {
      setJobs(await fetchEnrichmentJobs());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your enrichment jobs");
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Schedule the next poll only while a job is in flight; clean up on unmount / when jobs settle.
  useEffect(() => {
    if (!loaded || !anyInFlight(jobs)) return;
    timer.current = setTimeout(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [jobs, loaded, poll]);

  return { jobs, error, loading, reload, polling: loaded && anyInFlight(jobs) };
}
