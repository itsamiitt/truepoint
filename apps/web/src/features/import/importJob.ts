// importJob.ts — the PURE view-model policy for an async import job (16 §3.2). The backend returns 202 + a
// job ref, then the real ImportSummary arrives later via polling GET /imports/:jobId. This maps one poll
// result (an ImportJobStatusResponse) to a discriminated UI view model so the component never has to reach
// into a possibly-job-ref-shaped value: `summary` is ONLY ever set on a completed job. Pure + injectable so
// the terminal-state decision is unit-tested without React or the network; useImport wraps it for view state.

import type { ImportJobStatusResponse, ImportSummary } from "@leadwolf/types";

/** Where the wizard is in the upload → background-process → settle lifecycle. */
export type ImportPhase = "idle" | "submitting" | "processing" | "done" | "failed";

/** The flattened view model the wizard renders. `summary` is non-null ONLY when phase === "done". */
export interface ImportViewModel {
  phase: ImportPhase;
  /** The background job's id, shown while processing so the user can correlate. */
  jobId: string | null;
  /** A real ImportSummary — present only on a completed job. Never a job ref (that invariant prevents the crash). */
  summary: ImportSummary | null;
  /** A human-readable failure/error message — present only when phase === "failed". */
  error: string | null;
}

/**
 * A view model is terminal once the wizard should STOP polling: `done` (summary in hand) or `failed`. This is
 * derived from the mapped PHASE, not the raw status, so it can never disagree with `viewModelFromJob` — a
 * "completed" status whose summary hasn't materialized maps to `processing`, so polling correctly continues
 * (the old status-based check stopped on "completed" and froze the UI on a null summary).
 */
export function isTerminalPhase(phase: ImportPhase): boolean {
  return phase === "done" || phase === "failed";
}

/**
 * Map one poll result to the view model. A completed job with a real summary → `done` (the only path that
 * exposes `summary`); a failed job → `failed` (with its reason); anything else (queued/active/unknown, or a
 * "completed" status whose summary hasn't materialized yet) → `processing`, so a job-ref-shaped or in-flight
 * value can never reach the summary render path and throw.
 */
export function viewModelFromJob(job: ImportJobStatusResponse): ImportViewModel {
  const jobId = job.jobId;
  if (job.status === "failed") {
    return { phase: "failed", jobId, summary: null, error: job.failedReason ?? "Import failed." };
  }
  if (job.status === "completed" && job.summary) {
    return { phase: "done", jobId, summary: job.summary, error: null };
  }
  // queued / active / unknown — or completed-but-summary-not-yet-readable: still processing.
  return { phase: "processing", jobId, summary: null, error: null };
}

/** The view model for a thrown error (network failure, non-ok status, or a polling timeout). */
export function viewModelFromError(message: string, jobId: string | null = null): ImportViewModel {
  return { phase: "failed", jobId, summary: null, error: message };
}

export const IDLE_VIEW_MODEL: ImportViewModel = {
  phase: "idle",
  jobId: null,
  summary: null,
  error: null,
};
