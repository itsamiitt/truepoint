// bulkProcessEnrichChunk.ts — the CHUNK step of the bulk (existing-contact) re-enrich pipeline
// (prospect-database-platform I3 / audit A3/P08). This is the ONLY slice that spends real provider credits, so it
// is braked TWICE, both in the same code as the spend call:
//   1. PER-RUN CAP — the confirmed worst-case ceiling (enrichment_jobs.credit_estimate_micros, set by the slice-1b
//      confirm gate; optionally tightened by options.maxProviderCostMicros). Before every paid contact the worker
//      reads the LIVE run spend (addRunSpendReturningTotal — atomic, sees sibling chunks) and STOPS the run the
//      moment the ceiling would be exceeded. A run with NO confirmed ceiling caps at 0 → it spends nothing.
//   2. DAILY BREAKER — inherited FREE by reusing enrichContact, which itself checks spendSince(day) against
//      ENRICH_DAILY_BUDGET_MICROS before any paid call and throws ProviderBudgetExceededError. We catch it and stop.
// Reuse-first is inherent: enrichContact answers a cached/fresh contact with NO call and NO cost. The shipped
// single-contact enrichContact is called UNCHANGED (no trigger → manual mode, exactly like processEnrichment).
// Providers are INJECTED (core stays vendor-free). DARK until BULK_ENRICHMENT_ENABLED — never reached while off.

import {
  type JobRowInsert,
  type TenantScope,
  enrichmentJobRepository,
} from "@leadwolf/db";
import {
  type BulkEnrichmentScope,
  type EnrichField,
  type MatchMethod,
  ProviderBudgetExceededError,
  enrichField,
} from "@leadwolf/types";
import { type EnrichContactResult, enrichContact } from "../enrichContact.ts";
import type { EnrichmentProvider } from "../providerPort.ts";

/** Fields a re-verify refreshes when the job does not specify its own — the full enrichable set. */
const DEFAULT_REVERIFY_FIELDS: EnrichField[] = [...enrichField.options];

export interface BulkProcessEnrichChunkInput {
  scope: BulkEnrichmentScope;
  jobId: string;
  chunkId: string;
  /** The vendor adapters, injected by the worker (defaultProviders) so core never imports packages/integrations. */
  providers: EnrichmentProvider[];
}

export interface BulkProcessEnrichChunkResult {
  /** false when the chunk was already completed, the job was not running, or it had no ceiling (nothing spent). */
  processed: boolean;
  /** contacts actually run before the chunk ended (may be < band size if a brake stopped the run mid-chunk). */
  processedRows: number;
  matched: number;
  enriched: number;
  charged: number;
  costMicros: number;
  /** true when a brake (per-run cap OR the daily breaker) stopped the run before the whole band was processed. */
  braked: boolean;
}

/** The parsed, trusted work-list slice for this chunk. */
interface RunOptions {
  contactIds: string[];
  fields: EnrichField[];
  maxProviderCostMicros: number | null;
}

/** Defensively parse the job's options jsonb into the work-list + fields + optional per-run cap override. */
function parseRunOptions(raw: unknown): RunOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const contactIds = Array.isArray(o.contactIds)
    ? o.contactIds.filter((x): x is string => typeof x === "string")
    : [];
  const fields =
    Array.isArray(o.fields) && o.fields.length > 0
      ? o.fields.filter((f): f is EnrichField => enrichField.safeParse(f).success)
      : DEFAULT_REVERIFY_FIELDS;
  const maxProviderCostMicros =
    typeof o.maxProviderCostMicros === "number" && o.maxProviderCostMicros >= 0
      ? Math.trunc(o.maxProviderCostMicros)
      : null;
  return { contactIds, fields: fields.length > 0 ? fields : DEFAULT_REVERIFY_FIELDS, maxProviderCostMicros };
}

/** Map one enrichContact outcome to its (matchOutcome, matchMethod) ledger facets. */
function ledgerFacets(r: EnrichContactResult): { matchOutcome: string; matchMethod: MatchMethod } {
  if (r.status === "enriched") return { matchOutcome: "matched_provider", matchMethod: "provider" };
  // cache_hit / unfilled / policy_skipped: the contact is known (matched) but no NEW provider data landed.
  return { matchOutcome: "matched_internal", matchMethod: "none" };
}

/**
 * Re-enrich this chunk's band of existing contacts, braked by the per-run cap AND the inherited daily breaker.
 * Idempotent: an already-`completed` chunk, a non-`running` job, or a missing ceiling is a no-op (processed:false).
 * Only a CONFIRMED job (status running, ceiling set) ever spends. Writes the per-row ledger + advances the job
 * counters + marks the chunk completed. Returns a non-PII summary.
 */
export async function bulkProcessEnrichChunk(
  input: BulkProcessEnrichChunkInput,
): Promise<BulkProcessEnrichChunkResult> {
  const { scope, jobId, chunkId, providers } = input;
  const repoScope: TenantScope = scope;
  const empty: BulkProcessEnrichChunkResult = {
    processed: false,
    processedRows: 0,
    matched: 0,
    enriched: 0,
    charged: 0,
    costMicros: 0,
    braked: false,
  };

  const job = await enrichmentJobRepository.getJob(repoScope, jobId);
  if (!job || job.status !== "running") return empty; // only a confirmed, still-running job is processed
  const chunk = await enrichmentJobRepository.getChunk(repoScope, chunkId);
  if (!chunk || chunk.status === "completed") return empty; // idempotent: never double-process a chunk

  const options = parseRunOptions(job.options);
  const band = options.contactIds.slice(chunk.rowStart, chunk.rowEnd);

  // PER-RUN CAP = the confirmed ceiling, tightened by any explicit override. A job with NO ceiling caps at 0 → it
  // spends nothing (defense in depth: the worker never spends without a human-confirmed budget).
  const cap = Math.min(
    job.creditEstimateMicros ?? 0,
    options.maxProviderCostMicros ?? Number.POSITIVE_INFINITY,
  );

  let runSpent = job.creditSpentMicros; // baseline: spend from sibling chunks at this chunk's start
  let matched = 0;
  let enriched = 0;
  let charged = 0;
  let chunkCost = 0;
  let processedRows = 0;
  let braked = false;
  const ledger: JobRowInsert[] = [];

  for (let i = 0; i < band.length; i += 1) {
    // PER-RUN CAP — checked BEFORE every contact against the live run total. A hard stop: the run can never exceed
    // the confirmed ceiling (bar at most one in-flight contact per chunk).
    if (runSpent >= cap) {
      braked = true;
      break;
    }
    const contactId = band[i]!;
    const rowIndex = chunk.rowStart + i;
    processedRows += 1;

    let result: EnrichContactResult;
    try {
      // Reuse the shipped single-contact path UNCHANGED (manual mode — no trigger). Cache/fresh → 0 cost.
      result = await enrichContact({ scope, contactId, fields: options.fields, providers });
    } catch (err) {
      if (err instanceof ProviderBudgetExceededError) {
        // DAILY breaker tripped inside enrichContact — stop the run. This contact was NOT charged.
        processedRows -= 1;
        braked = true;
        break;
      }
      // Any other per-contact failure is isolated: record an error row and keep going (one bad contact must not
      // fail the whole chunk).
      ledger.push({
        jobId,
        chunkId,
        rowIndex,
        workspaceId: scope.workspaceId,
        matchOutcome: "error",
        matchedContactId: contactId,
      });
      continue;
    }

    const cost = Math.max(0, result.costMicros);
    chunkCost += cost;
    matched += 1; // the contact is a known match by construction (re-enrich of an existing contact)
    if (result.status === "enriched") enriched += 1;
    if (cost > 0) charged += 1;
    const { matchOutcome, matchMethod } = ledgerFacets(result);
    ledger.push({
      jobId,
      chunkId,
      rowIndex,
      workspaceId: scope.workspaceId,
      matchMethod,
      matchOutcome,
      matchedContactId: contactId,
      enrichedFields: { fields: result.filled },
      providerSource: result.provider,
      costMicros: cost,
      charged: cost > 0,
    });

    // Accumulate spend atomically + read back the LIVE run total (incl. sibling chunks) so the next cap check is
    // current. Only paid contacts touch the DB here — cache hits (cost 0) never write.
    if (cost > 0) {
      runSpent = await enrichmentJobRepository.addRunSpendReturningTotal(repoScope, jobId, cost);
    }
  }

  // Persist the per-row ledger (one batch), advance the job's counters (NOT creditSpentMicros — already accrued
  // per paid contact above), and mark the chunk completed.
  await enrichmentJobRepository.insertJobRows(repoScope, ledger);
  await enrichmentJobRepository.updateJobProgress(repoScope, jobId, {
    processedRows,
    matchedRows: matched,
    enrichedRows: enriched,
    chargedRows: charged,
  });
  await enrichmentJobRepository.updateChunk(repoScope, chunkId, {
    status: "completed",
    processedRows,
    completedAt: new Date(),
  });

  // If a brake stopped the run, pause the JOB so sibling chunks wind down (they see status ≠ running and skip).
  if (braked) {
    await enrichmentJobRepository.updateJobStatus(repoScope, jobId, { status: "paused" });
    return { processed: true, processedRows, matched, enriched, charged, costMicros: chunkCost, braked };
  }

  // FINALIZE (best-effort): when THIS was the last chunk to complete, flip the job terminal so a finished run never
  // sits stuck in `running`. Re-read the status and only advance running → completed, so a sibling that braked (set
  // `paused`) is never overridden back to completed. NOTE: a chunk-completion COUNTER (like import_jobs) would make
  // this fully race-free; the status re-read is the pragmatic v1 (a benign completed↔paused race converges to
  // paused whenever any chunk braked, which is the correct outcome).
  const chunks = await enrichmentJobRepository.listChunks(repoScope, jobId);
  if (chunks.length > 0 && chunks.every((c) => c.status === "completed")) {
    const fresh = await enrichmentJobRepository.getJob(repoScope, jobId);
    if (fresh?.status === "running") {
      await enrichmentJobRepository.updateJobStatus(repoScope, jobId, {
        status: "completed",
        completedAt: new Date(),
      });
    }
  }

  return { processed: true, processedRows, matched, enriched, charged, costMicros: chunkCost, braked };
}
