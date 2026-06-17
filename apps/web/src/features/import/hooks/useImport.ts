// useImport.ts — view state for running an async import: it enqueues via api.postImport (which returns a job
// ref, NOT the summary), then POLLS api.getImportJob until the job settles, exposing an idle → submitting →
// processing → done/failed lifecycle. Holds no business logic (the pipeline runs server-side in
// packages/core); the queued→settled view-model decision lives in the pure ../importJob policy. Polling
// timers are torn down on unmount and at the start of every new run so nothing leaks or double-fires.
"use client";

import type { ColumnMapping, ConflictPolicy, ImportSummary, SourceName } from "@leadwolf/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { getImportJob, postImport } from "../api";
import {
  IDLE_VIEW_MODEL,
  type ImportPhase,
  type ImportViewModel,
  isTerminalPhase,
  viewModelFromError,
  viewModelFromJob,
} from "../importJob";

export interface RunArgs {
  file: File;
  sourceName: SourceName;
  mapping: ColumnMapping;
  conflictPolicy: ConflictPolicy;
}

/** Poll cadence and ceiling: ~1.5s between polls, giving up after ~2 min so the UI never hangs forever. */
const POLL_INTERVAL_MS = 1_500;
const MAX_POLL_ATTEMPTS = 80;
/** Tolerate a few CONSECUTIVE transient poll failures (a dropped connection / 5xx) before giving up — one
 *  flaky GET must not abort a job that is still running fine server-side. Reset on every successful poll. */
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

export interface UseImport {
  status: ImportPhase;
  jobId: string | null;
  summary: ImportSummary | null;
  error: string | null;
  busy: boolean;
  run: (args: RunArgs) => void;
}

export function useImport(): UseImport {
  const [vm, setVm] = useState<ImportViewModel>(IDLE_VIEW_MODEL);
  // The active poll timer. A ref (not state) so cleanup never depends on a re-render, and so a stale run's
  // timer can be cancelled the instant a new run (or unmount) happens.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic run token: every run bumps it, and only the latest run is allowed to commit state. This makes
  // an in-flight poll/post from a superseded run a no-op even if its timer/promise already resolved.
  const runIdRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Tear the poll loop down on unmount (and bump the run token so any in-flight async work is ignored).
  useEffect(() => {
    return () => {
      runIdRef.current++;
      clearTimer();
    };
  }, [clearTimer]);

  const run = useCallback(
    (args: RunArgs): void => {
      clearTimer();
      const runId = ++runIdRef.current;
      const isCurrent = () => runId === runIdRef.current;
      setVm({ phase: "submitting", jobId: null, summary: null, error: null });

      // `errorStreak` counts CONSECUTIVE failed polls so a single blip doesn't kill a still-running job.
      const poll = async (jobId: string, attempt: number, errorStreak: number): Promise<void> => {
        if (!isCurrent()) return;
        if (attempt > MAX_POLL_ATTEMPTS) {
          setVm(
            viewModelFromError("Import is taking longer than expected. Check back shortly.", jobId),
          );
          return;
        }
        try {
          const job = await getImportJob(jobId);
          if (!isCurrent()) return;
          const next = viewModelFromJob(job);
          setVm(next);
          // Terminal is decided by the MAPPED phase, never the raw status: a "completed" job whose summary
          // hasn't materialized yet maps to `processing`, so we keep polling instead of freezing on a null.
          if (isTerminalPhase(next.phase)) return;
          timerRef.current = setTimeout(() => void poll(jobId, attempt + 1, 0), POLL_INTERVAL_MS);
        } catch (e) {
          if (!isCurrent()) return;
          if (errorStreak + 1 >= MAX_CONSECUTIVE_POLL_ERRORS) {
            setVm(
              viewModelFromError(
                e instanceof Error ? e.message : "Could not check import status.",
                jobId,
              ),
            );
            return;
          }
          // Transient blip — keep the user in `processing` and retry on the next tick.
          timerRef.current = setTimeout(
            () => void poll(jobId, attempt + 1, errorStreak + 1),
            POLL_INTERVAL_MS,
          );
        }
      };

      void (async () => {
        try {
          const ref = await postImport(args);
          if (!isCurrent()) return;
          setVm({ phase: "processing", jobId: ref.jobId, summary: null, error: null });
          await poll(ref.jobId, 1, 0);
        } catch (e) {
          if (!isCurrent()) return;
          setVm(viewModelFromError(e instanceof Error ? e.message : "Import failed."));
        }
      })();
    },
    [clearTimer],
  );

  const busy = vm.phase === "submitting" || vm.phase === "processing";

  return {
    status: vm.phase,
    jobId: vm.jobId,
    summary: vm.summary,
    error: vm.error,
    busy,
    run,
  };
}
