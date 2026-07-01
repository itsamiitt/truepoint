// erSweep.ts — the scheduled, leader-locked probabilistic-ER SHADOW sweep (prospect-database-platform I5 / audit
// P02, A10). It scans master_persons in cursor batches; for each seed at a company it blocks on the shared company,
// scores each candidate pair (Fellegi-Sunter), and for a pending_review/auto_match PROPOSES a pending splink
// match_links row — the human-review queue the DB-Ops surface reads. A single repeatable job (register.ts);
// leader-locked so exactly one worker sweeps per tick; bounded per tick with a Redis cursor that RESUMES the scan
// across ticks (wraps to the start at the end of the dataset — no queue to drain, so the cursor is how it progresses).
//
// SHADOW-ONLY + flag-off-safe: GATED on env.ER_SHADOW_ENABLED — while off it returns immediately (proposes nothing).
// It NEVER auto-confirms/merges/re-points; a pending splink row is provably inert (the deterministic resolve ignores
// review_status; the projector counts source_records, not match_links). All reads/writes run under withErTx
// (leadwolf_er, master_* only); one seed's block+score+propose is its OWN tx, so a bad seed can't stall the sweep.

import { env } from "@leadwolf/config";
import { type ComparablePerson, compareRecords, scoreFellegiSunter } from "@leadwolf/core";
import { type ErCandidatePerson, erRepository, withErTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const ER_SWEEP_QUEUE = "er_sweep";
const LEADER_KEY = "leader:er_sweep";
const LEADER_TTL_MS = 5 * 60_000;
const CURSOR_KEY = "er_sweep:cursor";
// Seeds scored per tick (bounded); the Redis cursor resumes the scan next tick. Modest — each seed does a blocking
// query + candidate scoring + proposals.
const MAX_SEEDS_PER_SWEEP = 500;
const SEED_BATCH = 100;

export type ErSweepJobData = Record<string, never>;

/** Map a repo candidate row to the core comparison shape (current_company_id → companyId). */
function toComparable(p: ErCandidatePerson): ComparablePerson {
  return {
    linkedinPublicId: p.linkedinPublicId,
    fullName: p.fullName,
    firstName: p.firstName,
    lastName: p.lastName,
    companyId: p.currentCompanyId,
    jobTitle: p.jobTitle,
    seniorityLevel: p.seniorityLevel,
  };
}

/** Order-independent pair key so a pair is scored + proposed at most once per tick. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Block + score one seed's candidates and propose pending matches for the dups. One withErTx; returns #proposed. */
async function sweepSeed(seed: ErCandidatePerson, scoredPairs: Set<string>): Promise<number> {
  if (!seed.currentCompanyId) return 0; // guard + narrows the type for the blocking read
  const companyId = seed.currentCompanyId;
  return withErTx(async (tx) => {
    const candidates = await erRepository.findBlockingCandidates(tx, { id: seed.id, currentCompanyId: companyId });
    const seedCmp = toComparable(seed);
    let localProposed = 0;
    for (const cand of candidates) {
      const key = pairKey(seed.id, cand.id);
      if (scoredPairs.has(key)) continue; // score each pair once per tick
      scoredPairs.add(key);
      const result = scoreFellegiSunter(compareRecords(seedCmp, toComparable(cand)));
      if (result.disposition === "no_match") continue;
      // pending_review OR auto_match → PROPOSE (shadow: even auto_match is a proposal for review, NEVER a merge).
      // Stable survivor/loser by id so the proposal direction is deterministic across ticks (idempotent).
      const survivor = seed.id < cand.id ? seed.id : cand.id;
      const loser = seed.id < cand.id ? cand.id : seed.id;
      const loserSourceRecords = await erRepository.listSourceRecordIdsForPerson(tx, loser);
      for (const sourceRecordId of loserSourceRecords) {
        const inserted = await erRepository.proposePendingMatch(tx, {
          sourceRecordId,
          clusterId: survivor,
          matchProbability: result.probability,
        });
        if (inserted) localProposed += 1;
      }
    }
    return localProposed;
  });
}

/**
 * Build the ER sweep processor. Inert while ER_SHADOW_ENABLED is off. Otherwise takes the Redis leader lock (one
 * worker per tick), resumes the scan from the persisted cursor, and walks up to MAX_SEEDS_PER_SWEEP persons —
 * blocking, scoring, and proposing pending matches — then persists the cursor (wrapping to the start at the end).
 */
export function makeProcessErSweep(redis: IORedis) {
  return async function processErSweep(_job: Job<ErSweepJobData>): Promise<void> {
    if (!env.ER_SHADOW_ENABLED) return; // kill-switch: inert while shadow mode is off
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const scoredPairs = new Set<string>();
      let afterId = (await redis.get(CURSOR_KEY)) || null;
      let seedsSeen = 0;
      let proposed = 0;
      let reachedEnd = false;

      while (seedsSeen < MAX_SEEDS_PER_SWEEP) {
        const seeds = await withErTx((tx) => erRepository.listPersonsForEr(tx, afterId, SEED_BATCH));
        if (seeds.length === 0) {
          reachedEnd = true;
          break;
        }
        for (const seed of seeds) {
          seedsSeen += 1;
          afterId = seed.id;
          if (seed.currentCompanyId) proposed += await sweepSeed(seed, scoredPairs);
          if (seedsSeen >= MAX_SEEDS_PER_SWEEP) break;
        }
        if (seeds.length < SEED_BATCH) {
          reachedEnd = true; // last page — the dataset end
          break;
        }
      }

      // Persist the cursor so the next tick resumes; wrap to the start once the dataset end was reached.
      if (reachedEnd) await redis.del(CURSOR_KEY);
      else if (afterId) await redis.set(CURSOR_KEY, afterId);

      if (proposed > 0) log.info("er sweep: pending matches proposed", { seedsSeen, proposed });
    });
  };
}
