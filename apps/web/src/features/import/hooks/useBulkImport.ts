// useBulkImport.ts — tracking ONE bulk import: keyed by job id, polls getBulkImportJob until the job settles.
// Polling STOPS on a terminal status (completed | partial | failed | cancelled); `paused` is NOT terminal (an
// ops/budget hold can resume), so polling continues through it. A 403 bulk_import_disabled surfaces as the
// `disabled` flag — a clear "not enabled" state, not a generic error. Holds no business logic — the import
// runs server-side in apps/workers; the shape is the @leadwolf/types contract so producer and consumer cannot
// drift.
//
// `refetchInterval` replaces the self-rescheduling timeout, and RQ's retry replaces the hand-counted error
// streak: both express "tolerate a few consecutive transient failures, reset on success", except RQ also
// backs off between attempts and keeps the last good job rendered throughout. The `active` cancel token is
// unnecessary once results are keyed by job id — a poll that resolves after the id changed lands on the old
// job's entry, not on the one being displayed.
"use client";

import type { BulkImportJobStatus, BulkImportJobStatusResponse } from "@leadwolf/types";
import { useQuery } from "@tanstack/react-query";
import { BulkImportDisabledError, getBulkImportJob } from "../api";
import { importKeys } from "../keys";

/** Poll cadence while a bulk job is in flight (ms) — these run for minutes, so a calm cadence (cf. enrichment). */
const POLL_INTERVAL_MS = 3_000;
/** Tolerate a few CONSECUTIVE transient poll failures (a dropped connection / 5xx) before giving up. */
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

/** Statuses at which polling STOPS — the job will not change further from the client's view. */
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
  const query = useQuery<BulkImportJobStatusResponse>({
    queryKey: importKeys.bulkJob(jobId ?? ""),
    enabled: jobId !== null,
    queryFn: () => getBulkImportJob(jobId as string),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status && TERMINAL.has(status) ? false : POLL_INTERVAL_MS;
    },
    // "Not enabled" is a settled answer, not a blip — retrying it would just repeat the same 403.
    retry: (failureCount, err) =>
      !(err instanceof BulkImportDisabledError) && failureCount < MAX_CONSECUTIVE_POLL_ERRORS,
  });

  const disabled = query.error instanceof BulkImportDisabledError;
  const settled = query.data ? TERMINAL.has(query.data.status) : false;

  return {
    job: jobId ? (query.data ?? null) : null,
    // The disabled case owns its own flag; surfacing it as an error too would render both messages.
    error:
      query.error && !disabled
        ? query.error instanceof Error
          ? query.error.message
          : "Could not check the bulk import status."
        : null,
    loading: jobId !== null && !settled && !disabled && !query.isError,
    disabled,
  };
}
