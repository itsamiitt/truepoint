// runCrmPull.ts — the two bulk CRM→TP readers (crm-sync 00 §3.3 backfill + inbound sweep).
//
//   runCrmBackfillPage — the one-shot initial load, page by page, resumable from a cursor.
//   runCrmDelta        — the incremental poll: everything modified since the watermark.
//
// Both share the same body: fetch a page, apply each record, then persist progress. What differs is where
// "where do I resume from" lives — a page cursor for backfill, a timestamp watermark for delta.
//
// THE WATERMARK ADVANCES ONLY AFTER A PAGE IS FULLY APPLIED, and only to the value the PROVIDER reported.
// Two failure modes that ordering prevents:
//   - Advancing per record would lose the tail of a page on a crash: records after the failure point sit
//     below a watermark that claims they were applied, and no later poll ever asks for them again. Silent
//     data loss, invisible until a customer notices a stale contact.
//   - Advancing to OUR clock rather than the provider's high-watermark bakes in clock skew. If our clock
//     runs fast, every record the CRM writes in that gap is skipped forever.
// Combined with the repository's GREATEST comparison, the watermark is monotonic and never optimistic.
//
// A PARTIAL PAGE IS REPORTED, NOT HIDDEN. If some records in a page fail, the page returns `partial` and
// does NOT advance the watermark: re-processing a page is cheap (the link table and content hashes make
// re-application a no-op) and losing records is not.
//
// RATE LIMITING STOPS THE RUN CLEANLY. The caller re-enqueues with the provider's own delay. A throttle is
// not a failure and must not consume the job's retry budget.

import type { CrmObjectType, CrmProvider } from "@leadwolf/types";
import type { ApplyInboundEventResult } from "./applyInboundEvent.ts";
import type { CrmConnector, CrmTokenBundle } from "./port.ts";

/** Per-record application, supplied by the caller — in practice a bound applyInboundEvent. */
export type ApplyRecord = (record: unknown) => Promise<ApplyInboundEventResult>;

export interface CrmPullDeps {
  loadTokenBundle(): Promise<CrmTokenBundle>;
  applyRecord: ApplyRecord;
  addCounts(counts: Record<string, number>): Promise<void>;
  /** Persist the resume point. Called ONLY after every record in the page has been applied. */
  saveProgress(args: {
    cursor?: string | null;
    watermark?: Date | null;
    backfillStatus?: "running" | "completed";
  }): Promise<void>;
}

export interface CrmPullGates {
  envEnabled: boolean;
  tenantFlagEnabled: boolean;
  syncMode: "disabled" | "shadow" | "enforce";
}

export interface CrmPullInputBase {
  provider: CrmProvider;
  objectType: CrmObjectType;
  pageSize: number;
  gates: CrmPullGates;
  connector: CrmConnector;
  deps: CrmPullDeps;
}

export type CrmPullOutcomeKind =
  | "completed" // the page applied cleanly (backfill: and there is no next cursor)
  | "more" // the page applied cleanly and another page is waiting
  | "partial" // some records failed; progress deliberately NOT advanced
  | "rate_limited"
  | "gated"
  | "failed";

export interface CrmPullResult {
  outcome: CrmPullOutcomeKind;
  applied: number;
  failed: number;
  /** The next page token — the caller enqueues the follow-up job with it. */
  nextCursor?: string;
  /** The watermark actually persisted, when one was. */
  watermark?: Date;
  retryAfterMs?: number;
  reason?: string;
}

function gateCheck(gates: CrmPullGates): CrmPullResult | null {
  if (!gates.envEnabled) return { outcome: "gated", applied: 0, failed: 0, reason: "env_disabled" };
  if (!gates.tenantFlagEnabled)
    return { outcome: "gated", applied: 0, failed: 0, reason: "tenant_flag_off" };
  if (gates.syncMode === "disabled")
    return { outcome: "gated", applied: 0, failed: 0, reason: "connection_disabled" };
  return null;
}

/**
 * Apply every record in a page.
 *
 * Per-record isolation is the point: one poisonous record must not abort the other 199. A record that
 * throws is counted as failed and the loop continues, because the alternative — aborting the page — means
 * a single malformed CRM row can wedge a connection permanently, retry after retry.
 */
async function applyPage(
  records: unknown[],
  applyRecord: ApplyRecord,
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (const record of records) {
    try {
      const result = await applyRecord(record);
      if (result.outcome === "failed") failed++;
      else applied++;
    } catch {
      failed++;
    }
  }
  return { applied, failed };
}

export interface RunCrmBackfillPageInput extends CrmPullInputBase {
  /** Resume token from the previous page; absent on the first page. */
  cursor?: string;
}

/**
 * One page of the initial bulk load.
 *
 * Returns `more` with the next cursor while pages remain — the caller enqueues the follow-up rather than
 * looping here, so a long backfill cannot monopolise a worker or starve real-time jobs (00 §8).
 */
export async function runCrmBackfillPage(input: RunCrmBackfillPageInput): Promise<CrmPullResult> {
  const gated = gateCheck(input.gates);
  if (gated) return gated;

  const bundle = await input.deps.loadTokenBundle();
  const page = await input.connector.pullPage({
    bundle,
    object: input.objectType,
    cursor: input.cursor,
    pageSize: input.pageSize,
  });
  await input.deps.addCounts({ apiCalls: 1 });

  if (page.kind === "rate_limited") {
    await input.deps.addCounts({ rateLimitedCt: 1 });
    return {
      outcome: "rate_limited",
      applied: 0,
      failed: 0,
      retryAfterMs: page.retryAfterMs,
      reason: page.daily ? "daily_cap" : "rate_limited",
    };
  }
  if (page.kind !== "ok") {
    return { outcome: "failed", applied: 0, failed: 0, reason: page.kind };
  }

  const { records, nextCursor, highWatermark } = page.value;
  await input.deps.addCounts({ recordsSeen: records.length });
  const { applied, failed } = await applyPage(records, input.deps.applyRecord);
  await input.deps.addCounts({ recordsFailed: failed });

  if (failed > 0) {
    // Progress is NOT saved: the page is re-tried whole. Re-application is a no-op thanks to the link
    // table and the content hash, so replaying is cheap; skipping records is not recoverable.
    return { outcome: "partial", applied, failed, reason: "records_failed" };
  }

  const isLast = !nextCursor;
  await input.deps.saveProgress({
    cursor: nextCursor ?? null,
    backfillStatus: isLast ? "completed" : "running",
    // The watermark is set ONLY when the backfill finishes. Setting it mid-backfill would let the delta
    // sweep start from a mark the backfill has not reached yet, and everything between would never be read.
    ...(isLast && highWatermark ? { watermark: new Date(highWatermark) } : {}),
  });

  return {
    outcome: isLast ? "completed" : "more",
    applied,
    failed,
    ...(nextCursor ? { nextCursor } : {}),
    ...(isLast && highWatermark ? { watermark: new Date(highWatermark) } : {}),
  };
}

export interface RunCrmDeltaInput extends CrmPullInputBase {
  /**
   * Where to read from — the stored watermark MINUS the overlap window, produced by
   * crmSyncStateRepository.readWithOverlap. Null means no watermark exists yet, which is a caller error:
   * an un-backfilled stream must run the backfill, not a delta since the epoch.
   */
  since: Date | null;
}

/** The incremental poll: everything the CRM modified since the watermark. */
export async function runCrmDelta(input: RunCrmDeltaInput): Promise<CrmPullResult> {
  const gated = gateCheck(input.gates);
  if (gated) return gated;

  if (!input.since) {
    // Refused rather than defaulted to the epoch: "pull everything since 1970" on a large CRM is an
    // accidental full-table scan against a rate-limited API, and it is what a missing backfill looks like.
    return { outcome: "failed", applied: 0, failed: 0, reason: "no_watermark_run_backfill_first" };
  }

  const bundle = await input.deps.loadTokenBundle();
  const page = await input.connector.pullDelta({
    bundle,
    object: input.objectType,
    sinceWatermark: input.since.toISOString(),
    pageSize: input.pageSize,
  });
  await input.deps.addCounts({ apiCalls: 1 });

  if (page.kind === "rate_limited") {
    await input.deps.addCounts({ rateLimitedCt: 1 });
    return {
      outcome: "rate_limited",
      applied: 0,
      failed: 0,
      retryAfterMs: page.retryAfterMs,
      reason: page.daily ? "daily_cap" : "rate_limited",
    };
  }
  if (page.kind !== "ok") {
    return { outcome: "failed", applied: 0, failed: 0, reason: page.kind };
  }

  const { records, highWatermark } = page.value;
  await input.deps.addCounts({ recordsSeen: records.length });
  const { applied, failed } = await applyPage(records, input.deps.applyRecord);
  await input.deps.addCounts({ recordsFailed: failed });

  if (failed > 0) {
    return { outcome: "partial", applied, failed, reason: "records_failed" };
  }

  // The PROVIDER's high-watermark, never our clock — see the header. An empty page still advances, which
  // is correct and important: a quiet stream should not keep re-asking for the same window forever.
  const watermark = highWatermark ? new Date(highWatermark) : null;
  if (watermark && !Number.isNaN(watermark.getTime())) {
    await input.deps.saveProgress({ watermark });
    return { outcome: "completed", applied, failed, watermark };
  }

  // A provider that returned no usable high-watermark leaves the mark alone. The overlap window means the
  // next poll re-reads the same window rather than skipping it.
  return { outcome: "completed", applied, failed, reason: "no_high_watermark" };
}
