// useBulkImport.ts — view state for tracking ONE bulk import: keyed by a job id, it POLLS getBulkImportJob on an
// interval until the job settles, exposing loading / error / disabled / job. Mirrors useEnrichmentJobs' "poll
// while in flight" loop and useEnrichmentJobDetail's id-keyed effect (NO TanStack — useState + useEffect). Polling
// STOPS on a terminal status (completed | partial | failed | cancelled); a 403 bulk_import_disabled is surfaced as
// the `disabled` flag (a clear "not enabled" state), NOT a generic error. Holds no business logic — the import
// runs server-side in apps/workers; the shape is the @leadwolf/types contract so producer + consumer can't drift.
"use client";

import type { BulkImportJobStatus, BulkImportJobStatusResponse } from "@leadwolf/types";
import { useEffect, useRef, useState } from "react";
import { BulkImportDisabledError, getBulkImportJob } from "../api";

/** Poll cadence while a bulk job is in flight (ms) — these run for minutes, so a calm cadence (cf. enrichment). */
const POLL_INTERVAL_MS = 3_000;
/** Tolerate a few CONSECUTIVE transient poll failures (a dropped connection / 5xx) before giving up; the streak
 *  resets on every successful poll, so one flaky GET never aborts a job that is still running fine server-side. */
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

/** Statuses at which polling STOPS — the job will not change further from the client's view. `paused` is NOT
 *  terminal (an ops / budget hold can resume), so polling continues through it. */
const TERMINAL = new Set<BulkImportJobStatus>(["completed", "partial", "failed", "cancelled"]);

export interface UseBulkImport {
  job: BulkImportJobStatusResponse | null;
  error: string | null;
  /** A poll is in flight and no terminal status has been reached yet (drives the loading state). */
  loading: boolean;
  /** True once a bulk route answered 403 bulk_import_disabled — render the "not enabled" message, not an error. */
  disabled: boolean;
}

export function useBulkImport(jobId: string | null): UseBulkImport {
  const [job, setJob] = useState<BulkImportJobStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(jobId != null);
  const [disabled, setDisabled] = useState(false);
  // The active poll timer — a ref so cleanup never depends on a re-render.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (jobId == null) {
      setJob(null);
      setError(null);
      setDisabled(false);
      setLoading(false);
      return;
    }
    // `active` is the cancel token: a poll/timer that resolves after the id changed (or unmount) is ignored.
    let active = true;
    setJob(null);
    setError(null);
    setDisabled(false);
    setLoading(true);

    const poll = async (errorStreak: number): Promise<void> => {
      if (!active) return;
      try {
        const next = await getBulkImportJob(jobId);
        if (!active) return;
        setJob(next);
        setError(null);
        // Terminal → stop the loop and clear loading (the settled job stays rendered).
        if (TERMINAL.has(next.status)) {
          setLoading(false);
          return;
        }
        timerRef.current = setTimeout(() => void poll(0), POLL_INTERVAL_MS);
      } catch (e) {
        if (!active) return;
        if (e instanceof BulkImportDisabledError) {
          setDisabled(true);
          setLoading(false);
          return;
        }
        if (errorStreak + 1 >= MAX_CONSECUTIVE_POLL_ERRORS) {
          setError(e instanceof Error ? e.message : "Could not check the bulk import status.");
          setLoading(false);
          return;
        }
        // Transient blip — keep the job rendered and retry on the next tick.
        timerRef.current = setTimeout(() => void poll(errorStreak + 1), POLL_INTERVAL_MS);
      }
    };

    void poll(0);

    return () => {
      active = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [jobId]);

  return { job, error, loading, disabled };
}
