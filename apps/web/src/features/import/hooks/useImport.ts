// useImport.ts — view state for running an async import: it enqueues via api.postImport (which returns a job
// ref, NOT the summary), then POLLS api.getImportJob until the job settles, exposing an idle → submitting →
// processing → done/failed lifecycle. Holds no business logic (the pipeline runs server-side in
// packages/core); the queued→settled view-model decision lives in the pure ../importJob policy.
//
// A mutation that yields a job id, plus a query keyed on that id. The monotonic run token this used to carry
// exists because the id is only known after the POST returns — and it becomes unnecessary here: a new run is
// a new id, so it is a new cache entry, and a superseded run's poll cannot commit over the current one no
// matter when it resolves. Same for the manual timer teardown; RQ stops polling an unmounted query.
//
// Terminal is decided by the MAPPED phase, never the raw status: a "completed" job whose summary has not
// materialized yet maps to `processing`, so polling continues rather than freezing on a null summary.
"use client";

import type {
  ColumnMapping,
  ConflictPolicy,
  ImportMergeMode,
  ImportSummary,
  SourceName,
} from "@leadwolf/types";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getImportJob, postImport } from "../api";
import {
  IDLE_VIEW_MODEL,
  type ImportPhase,
  type ImportViewModel,
  isTerminalPhase,
  viewModelFromError,
  viewModelFromJob,
} from "../importJob";
import { importKeys } from "../keys";

export interface RunArgs {
  file: File;
  sourceName: SourceName;
  mapping: ColumnMapping;
  conflictPolicy: ConflictPolicy;
  /** The 08 §5 merge strategy (S-U4). Sent alongside `conflictPolicy`; the server uses it gate-on, ignores it
   *  gate-off. Optional — absent ⇒ the workspace policy default. */
  mergeMode?: ImportMergeMode;
  preservePopulated?: boolean;
  /** Optional "import into list" target — landed rows are added to this list (list-plan/03 §2.2). */
  listId?: string;
}

/** Poll cadence: ~1.5s between polls. There is NO attempt ceiling — a running job is durable server-side, so
 *  the poll follows it to a terminal state rather than giving up (import-redesign 11 §4 / G11: the old ~2-min
 *  "taking longer than expected" abort is deleted; the page flow uses the durable job page instead). */
const POLL_INTERVAL_MS = 1_500;
/** Tolerate a few CONSECUTIVE transient poll failures (a dropped connection / 5xx) before surfacing an error —
 *  one flaky GET must not abort a job that is still running fine server-side. Reset on every successful poll. */
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
  // The job being followed. Client state: which run this hook is watching, not something the server holds.
  const [jobId, setJobId] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: postImport,
    onSuccess: (ref) => setJobId(ref.jobId),
    // A new run supersedes the previous job even if the POST fails — otherwise the old job would keep polling
    // underneath a failed submit and report ITS outcome as this run's.
    onMutate: () => setJobId(null),
  });

  const job = useQuery({
    queryKey: importKeys.detail(jobId ?? ""),
    enabled: jobId !== null,
    queryFn: () => getImportJob(jobId as string),
    refetchInterval: (q) =>
      q.state.data && isTerminalPhase(viewModelFromJob(q.state.data).phase)
        ? false
        : POLL_INTERVAL_MS,
    retry: MAX_CONSECUTIVE_POLL_ERRORS - 1,
  });

  const vm: ImportViewModel = (() => {
    if (submit.isPending) return { phase: "submitting", jobId: null, summary: null, error: null };
    if (submit.isError) {
      return viewModelFromError(
        submit.error instanceof Error ? submit.error.message : "Import failed.",
      );
    }
    if (jobId === null) return IDLE_VIEW_MODEL;
    if (job.isError) {
      return viewModelFromError(
        job.error instanceof Error ? job.error.message : "Could not check import status.",
        jobId,
      );
    }
    // Between the POST landing and the first poll answering there is no job row yet, but the run is real.
    if (!job.data) return { phase: "processing", jobId, summary: null, error: null };
    return viewModelFromJob(job.data);
  })();

  return {
    status: vm.phase,
    jobId: vm.jobId,
    summary: vm.summary,
    error: vm.error,
    busy: vm.phase === "submitting" || vm.phase === "processing",
    run: (args: RunArgs) => submit.mutate(args),
  };
}
