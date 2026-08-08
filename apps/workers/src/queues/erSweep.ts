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
import {
  type ComparablePerson,
  blockBudget,
  compareRecords,
  personBlockKey,
  scoreFellegiSunter,
} from "@leadwolf/core";
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

/** Block + score one seed's candidates and propose pending matches for the dups. One withErTx; returns #proposed.
 *
 * TWO blocking passes, unioned and deduped by pair key — they find DIFFERENT duplicates and neither subsumes
 * the other:
 *   • COMPANY block (original): colleagues, the natural dedup neighbourhood. High precision.
 *   • NAME block (`block_key`, indexed by migration 0106): the two cases company blocking CANNOT reach by
 *     construction — a person with NO current company, who previously yielded no candidates at all and was
 *     invisible to ER entirely; and the SAME person recorded at TWO companies, i.e. the job-change duplicate.
 *     That second case is outcomes S-09 and S-13, and a company-keyed block can never surface it because the
 *     two rows disagree on exactly the key it blocks on.
 *
 * The name pass is admitted only if its block is within `blockBudget`. A block of n members costs n(n-1)/2
 * comparisons, so an over-large block — usually a very common surname — is skipped and LOGGED rather than
 * silently dropped: that is precisely where real duplicates cluster, so a silent skip would read as "nothing
 * to resolve here" when the opposite is true.
 */
async function sweepSeed(seed: ErCandidatePerson, scoredPairs: Set<string>): Promise<number> {
  // A seed with neither a company nor a block key has no way to generate candidates at all.
  if (!seed.currentCompanyId && !seed.blockKey) return 0;
  const companyId = seed.currentCompanyId;
  return withErTx(async (tx) => {
    const candidates: ErCandidatePerson[] = companyId
      ? await erRepository.findBlockingCandidates(tx, { id: seed.id, currentCompanyId: companyId })
      : [];

    if (seed.blockKey) {
      const members = await erRepository.countBlockMembers(tx, seed.blockKey);
      const budget = blockBudget(members);
      if (budget.admit) {
        candidates.push(
          ...(await erRepository.findCandidatesByBlockKey(tx, {
            id: seed.id,
            blockKey: seed.blockKey,
          })),
        );
      } else {
        log.info("er sweep: name block skipped, over budget", {
          blockKey: seed.blockKey,
          members,
          comparisons: budget.comparisons,
        });
      }
    }

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
      // Seeds walked this tick that still have no block_key — backfilled once, after the scan, from rows
      // already in hand.
      const backfillQueue: ErCandidatePerson[] = [];
      let afterId = (await redis.get(CURSOR_KEY)) || null;
      let seedsSeen = 0;
      let proposed = 0;
      let reachedEnd = false;

      while (seedsSeen < MAX_SEEDS_PER_SWEEP) {
        const seeds = await withErTx((tx) =>
          erRepository.listPersonsForEr(tx, afterId, SEED_BATCH),
        );
        if (seeds.length === 0) {
          reachedEnd = true;
          break;
        }
        for (const seed of seeds) {
          seedsSeen += 1;
          afterId = seed.id;
          if (!seed.blockKey) backfillQueue.push(seed);
          proposed += await sweepSeed(seed, scoredPairs);
          if (seedsSeen >= MAX_SEEDS_PER_SWEEP) break;
        }
        if (seeds.length < SEED_BATCH) {
          reachedEnd = true; // last page — the dataset end
          break;
        }
      }

      // BACKFILL `block_key` for the seeds this tick just walked, so the name-blocked pass has something to
      // join on. The column has been RESERVED and unpopulated since the schema froze; 0106 indexed it and
      // nothing wrote it, which meant findCandidatesByBlockKey correctly returned nothing for every seed —
      // the safe failure, but not a useful one.
      //
      // Done HERE rather than as its own sweep because these rows are already loaded and already bounded by
      // the tick budget: a separate backfill would re-scan the same table to do strictly less. `setBlockKey`
      // is guarded on `block_key IS NULL`, so recomputing keys under a changed rule stays a deliberate
      // migration rather than a side effect of maintenance.
      const keyed = await withErTx(async (tx) => {
        let n = 0;
        for (const seed of backfillQueue) {
          const key = personBlockKey({
            lastName: seed.lastName,
            firstName: seed.firstName,
            countryCode: seed.locationCountry,
          });
          // A null key is the deliberate outcome for a record with too little to block on — it stays out of
          // the shared bucket rather than joining a quadratic one.
          if (key && (await erRepository.setBlockKey(tx, seed.id, key))) n += 1;
        }
        return n;
      });
      if (keyed > 0) log.info("er sweep: block keys backfilled", { keyed });

      // Persist the cursor so the next tick resumes; wrap to the start once the dataset end was reached.
      if (reachedEnd) await redis.del(CURSOR_KEY);
      else if (afterId) await redis.set(CURSOR_KEY, afterId);

      if (proposed > 0) log.info("er sweep: pending matches proposed", { seedsSeen, proposed });
    });
  };
}
