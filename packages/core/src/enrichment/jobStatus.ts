// jobStatus.ts — the customer-visible enrichment job-status query helper (G-ENR-4; 06 §4.1, 31 §8). READ-ONLY:
// it composes the workspace-scoped enrichment-jobs repository reads into the EnrichmentJobSummary DTO the status
// surface (list + detail endpoints / the polling web UI) renders. Pure mapping over the control row — no
// mutation, no provider calls, no per-row ledger read (the high-volume rows table is never touched here). The
// counts/progress are derived from the `enrichment_jobs` counters the worker maintains; timestamps are ISO'd at
// the edge. Mirrors buildHomeSummary's shape (compose scoped repo reads → a serialisable, PII-free DTO).

import {
  type JobRecord,
  type JobViewRow,
  type TenantScope,
  enrichmentJobRepository,
} from "@leadwolf/db";
import type { EnrichmentJobStatus, EnrichmentJobSummary, JobViewer } from "@leadwolf/types";

export interface EnrichmentJobStatusScope {
  scope: { tenantId: string; workspaceId: string };
  /** WHO is looking (import-redesign 10 §4): REQUIRED — the repo predicate narrows to the viewer (members
   *  see own + shared; elevated see all; dual gate off ⇒ workspace-wide, byte-identical). Built by the
   *  route from middleware outputs only. */
  viewer: JobViewer;
}

export interface ListEnrichmentJobsInput extends EnrichmentJobStatusScope {
  /** Cap on returned jobs (most-recent first); the repo clamps to [1, 200], default 50. */
  limit?: number;
}

export interface GetEnrichmentJobInput extends EnrichmentJobStatusScope {
  jobId: string;
}

/**
 * Fraction of rows processed (0–1). 0 when the job has no rows yet (avoids a divide-by-zero and reads as
 * "nothing done" rather than "complete"). Clamped to [0,1] so a stray over-count can never render > 100%.
 */
function progressFraction(processed: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, processed / total));
}

/** A job is settled once it reaches a terminal state — its counters no longer move. */
const TERMINAL_STATUSES = new Set<EnrichmentJobStatus>(["completed", "failed", "cancelled"]);

/**
 * Rows that finished but did NOT resolve to a match — the "failed to enrich" count the surface shows. Derived
 * from the control-row counters (processed − matched) and floored at 0, so it never reads the per-row ledger
 * just to display a tally. A row is "matched" when it resolved internally or via a provider; everything else
 * processed (unmatched / suppressed / error) is surfaced here as not-resolved.
 *
 * Only meaningful once the job is SETTLED: mid-run, `processed` advances ahead of `matched` because rows are
 * still in the waterfall (pending, not failed), so the bare difference would over-report failures on a healthy
 * in-flight job. We therefore report 0 until the job is terminal, then the true unresolved tally — matching the
 * documented contract ("once a job is settled") and avoiding a misleading live "Failed" count.
 */
function failedCount(status: EnrichmentJobStatus, processed: number, matched: number): number {
  if (!TERMINAL_STATUSES.has(status)) return 0;
  return Math.max(0, processed - matched);
}

/** Map a control-row record to the customer-facing summary DTO. Non-PII; safe to serialise + poll. Pure. */
export function toEnrichmentJobSummary(job: JobRecord): EnrichmentJobSummary {
  const status = job.status as EnrichmentJobStatus;
  return {
    jobId: job.id,
    sourceName: job.sourceName,
    status,
    progress: progressFraction(job.processedRows, job.totalRows),
    counts: {
      total: job.totalRows,
      processed: job.processedRows,
      matched: job.matchedRows,
      enriched: job.enrichedRows,
      charged: job.chargedRows,
      failed: failedCount(status, job.processedRows, job.matchedRows),
    },
    creditEstimateMicros: job.creditEstimateMicros,
    creditSpentMicros: job.creditSpentMicros,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    failedReason: job.failedReason,
  };
}

/** The viewer-read summary: the base DTO + creator attribution ONLY while scoping is active, so flag-off
 *  responses stay byte-identical (import-redesign 10 §2.1 attribution / 15 §2.4 parity). */
function toViewerSummary(job: JobViewRow, viewer: JobViewer): EnrichmentJobSummary {
  const summary = toEnrichmentJobSummary(job);
  if (!viewer.scoped) return summary;
  return {
    ...summary,
    createdBy: { userId: job.createdByUserId, displayName: job.createdByDisplayName },
  };
}

/** List the enrichment jobs visible to the viewer, most-recent first, as status summaries. Workspace-scoped
 *  via RLS; viewer-scoped via the repo's jobVisibility predicate (import-redesign 10 §2.1). */
export async function listEnrichmentJobs(
  input: ListEnrichmentJobsInput,
): Promise<EnrichmentJobSummary[]> {
  const scope: TenantScope = input.scope;
  const jobs = await enrichmentJobRepository.listJobs(scope, input.viewer, input.limit ?? 50);
  return jobs.map((job) => toViewerSummary(job, input.viewer));
}

/** One job's status summary by id. Null when not visible to the caller (RLS workspace wall + the viewer
 *  predicate — invisible is indistinguishable from absent, 10 §4.2 rule 2) — the route 404s. */
export async function getEnrichmentJobStatus(
  input: GetEnrichmentJobInput,
): Promise<EnrichmentJobSummary | null> {
  const scope: TenantScope = input.scope;
  const job = await enrichmentJobRepository.getJob(scope, input.viewer, input.jobId);
  return job ? toViewerSummary(job, input.viewer) : null;
}
