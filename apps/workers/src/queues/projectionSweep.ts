// projectionSweep.ts — the scheduled, leader-locked survivorship-projection SWEEP (prospect-database-platform I1 /
// Phase 05). It DRAINS projection_outbox: claim the oldest pending row → summarize the cluster's evidence
// (source_records) → compute the quality score → write the SHADOW seams (data_quality_score + prov_hwm) on the
// golden master_* row → mark done. A single repeatable job (registered in register.ts); leader-locked (mirrors the
// other sweeps) so exactly one worker drains per tick. Bounded per tick — a still-pending backlog drains next tick.
//
// SAFETY: ADDITIVE + flag-off-safe. The outbox only holds rows when INGESTION_EVIDENCE_ENABLED produced them
// (so an empty drain is a no-op), and the projection writes SHADOW seams ONLY — it NEVER touches the authoritative
// golden scalar columns (firstName/email/name/…). The projector becoming authoritative over those is a SEPARATE,
// CI-parity-gated flip. Each row's claim and its projection commit in their own withErTx, with a per-row
// try/markFailed so one bad cluster never stalls the sweep.

import { computeClusterQualityScore } from "@leadwolf/core";
import { projectorRepository, withErTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const PROJECTION_SWEEP_QUEUE = "projection_sweep";
const LEADER_KEY = "leader:projection_sweep";
const LEADER_TTL_MS = 5 * 60_000;
// Cap the rows drained per tick so one sweep can't run unbounded; a still-pending backlog drains next tick.
const MAX_PER_SWEEP = 2000;

export type ProjectionSweepJobData = Record<string, never>;

/**
 * Build the sweep processor. Takes the Redis leader lock (one worker drains per tick), then loops: claim a pending
 * outbox row (its own tx → the `processing` mark commits), project the cluster + mark done (a second tx), or mark
 * failed (a third tx) on error. Stops at the first empty claim or the per-tick cap.
 */
export function makeProcessProjectionSweep(redis: IORedis) {
  return async function processProjectionSweep(_job: Job<ProjectionSweepJobData>): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      let processed = 0;
      let failed = 0;
      for (let i = 0; i < MAX_PER_SWEEP; i++) {
        // Claim in its OWN tx so the `processing` mark commits independently of the projection write.
        const claim = await withErTx((tx) => projectorRepository.claimNextPending(tx));
        if (!claim) break;
        try {
          await withErTx(async (tx) => {
            const summary = await projectorRepository.summarizeClusterEvidence(
              tx,
              claim.clusterId,
              claim.entityType,
            );
            const score = computeClusterQualityScore({
              evidenceCount: summary.evidenceCount,
              latestIngestedAt: summary.latestIngestedAt,
              now: new Date(),
            });
            await projectorRepository.writeShadowProjection(tx, claim.entityType, claim.clusterId, {
              dataQualityScore: score,
              provHwm: summary.latestIngestedAt,
            });
            await projectorRepository.markDone(tx, claim.id);
          });
          processed += 1;
        } catch (e) {
          // The projection tx rolled back (the row is still `processing`); mark it failed in its own tx so the
          // sweep moves on instead of re-claiming it. A markFailed failure is logged + ignored (best-effort).
          await withErTx((tx) => projectorRepository.markFailed(tx, claim.id)).catch(() => {});
          failed += 1;
          log.error("projection sweep: cluster projection failed", {
            clusterId: claim.clusterId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (processed > 0 || failed > 0) {
        log.info("projection sweep: clusters projected", { processed, failed });
      }
    });
  };
}
