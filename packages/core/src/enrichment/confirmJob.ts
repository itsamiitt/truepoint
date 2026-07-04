// confirmJob.ts — the human confirm-before-spend gate for bulk CSV enrichment (prospect-database-platform I3 /
// audit A3/P08). This is the ONE mutation that lets a bulk-enrich run begin: it drives the GUARDED
// awaiting_confirmation → running transition (enrichmentJobRepository.confirmAwaitingJob) after a workspace
// owner/admin has SEEN and accepted the persisted worst-case credit CEILING. Transport calls this; the repo owns
// the atomic, status-pinned transition (only the caller that finds the job awaiting confirmation wins). Additive +
// spend-safe: the endpoint that reaches here is dark while BULK_ENRICHMENT_ENABLED is off, and even once confirmed
// a job only sits in `running` until the workers consumer lands — this mutation itself spends nothing.

import { type TenantScope, enrichmentJobRepository } from "@leadwolf/db";
import type { EnrichmentJobSummary } from "@leadwolf/types";
import { type GetEnrichmentJobInput, toEnrichmentJobSummary } from "./jobStatus.ts";

/** The result of a confirm attempt — the endpoint maps each arm to an HTTP status. */
export type ConfirmBulkEnrichmentResult =
  | { outcome: "confirmed"; job: EnrichmentJobSummary }
  | { outcome: "not_found" }
  | { outcome: "not_awaiting"; job: EnrichmentJobSummary };

/**
 * Confirm a bulk-enrichment job's worst-case spend and release it to run. Drives the guarded
 * `awaiting_confirmation → running` transition; only the caller that finds the job in `awaiting_confirmation` wins
 * (idempotent + race-safe in the repo — a duplicate/concurrent confirm loses and reports `not_awaiting`). Returns:
 *   - `confirmed`     THIS call promoted the job to `running` (→ 200 + the updated summary);
 *   - `not_found`     no such job in the caller's workspace (→ 404 — never leak existence);
 *   - `not_awaiting`  the job exists but is not awaiting confirmation (→ 409 — already running/settled, or never armed).
 * Workspace-scoped via RLS. Enables NO spend by itself: the worker (a later slice) is what would spend, and it is
 * gated behind the same BULK_ENRICHMENT_ENABLED kill-switch as the endpoint that calls this.
 */
export async function confirmBulkEnrichmentJob(
  input: GetEnrichmentJobInput,
): Promise<ConfirmBulkEnrichmentResult> {
  const scope: TenantScope = input.scope;
  // GUARDED transition — true iff THIS call moved the job awaiting_confirmation → running.
  const promoted = await enrichmentJobRepository.confirmAwaitingJob(scope, input.jobId);
  // Read the job back so the response reflects the (possibly just-changed) status, or reports the conflict state.
  const job = await enrichmentJobRepository.getJobSystem(scope, input.jobId);
  if (!job) return { outcome: "not_found" };
  const summary = toEnrichmentJobSummary(job);
  return promoted
    ? { outcome: "confirmed", job: summary }
    : { outcome: "not_awaiting", job: summary };
}
