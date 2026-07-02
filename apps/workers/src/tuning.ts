// tuning.ts — per-queue Worker options for failure containment (worker-platform plan 15 §3). Before this
// module every worker ran BullMQ defaults: concurrency 1 (one hung job wedges the whole queue behind it),
// 30s lock with a single stalled reclaim (a crashed worker's job recovers slowly and unpredictably). Pure
// data with no env/Redis import so it is unit-testable; register.ts spreads these into `new Worker(...)`.
//
// Concurrency is raised ONLY for IO-bound, idempotent event queues. The SPEND path stays serial — re-audit
// F3 is a hard gate: the daily budget breaker is a racy read-check-act (enrichContact), so N concurrent
// spend workers could each pass it and overshoot a tenant's daily cap by up to N paid calls. Do not raise
// `enrichment` (or the dark bulk drive/chunk workers) until the atomic breaker + per-batch credit lease land
// (plan 15 §7 Phase-5 entry gate). tuning.test.ts is the tripwire.

import type { WorkerOptions } from "bullmq";

/** The containment-relevant slice of BullMQ worker options register.ts spreads into each constructor. */
export type WorkerTuning = Pick<
  WorkerOptions,
  "concurrency" | "lockDuration" | "stalledInterval" | "maxStalledCount"
>;

/** Lock/stall settings shared by every event worker: a crashed worker's job is reclaimed predictably
 *  (60s lock, checked every 30s, failed after 2 stalls → dead-lettered via deadLetter.ts) instead of the
 *  30s/1 defaults. BullMQ auto-renews the lock for live long-running jobs, so 60s is a crash bound, not a
 *  job-duration bound. */
const EVENT_LOCK: Omit<WorkerTuning, "concurrency"> = {
  lockDuration: 60_000,
  stalledInterval: 30_000,
  maxStalledCount: 2,
};

/** Event-queue tuning, keyed by queue name. Concurrency rationale per queue:
 *  - imports 1 — whole-CSV payloads in memory; the scalable path is the chunked bulk-imports pipeline.
 *  - enrichment 1 — SPEND PATH (F3 hard gate; see header). Serial until the atomic budget breaker lands.
 *  - dsar 1 — privileged compliance deletes/exports; keep strictly serial.
 *  - scoring/dedup/firmographics/outreach 4 — IO-bound and idempotent; outreach's per-mailbox SEND rate is
 *    still governed by the Redis token bucket (mailboxThrottle), concurrency only parallelizes across
 *    mailboxes/tenants.
 *  - master-backfill/reverification 2 — batched, vendor/DB-bound; modest parallelism, gentle on the pool. */
export const EVENT_WORKER_TUNING: Readonly<Record<string, WorkerTuning>> = {
  imports: { concurrency: 1, ...EVENT_LOCK },
  enrichment: { concurrency: 1, ...EVENT_LOCK },
  scoring: { concurrency: 4, ...EVENT_LOCK },
  dsar: { concurrency: 1, ...EVENT_LOCK },
  outreach: { concurrency: 4, ...EVENT_LOCK },
  dedup: { concurrency: 4, ...EVENT_LOCK },
  firmographics: { concurrency: 4, ...EVENT_LOCK },
  "master-backfill": { concurrency: 2, ...EVENT_LOCK },
  reverification: { concurrency: 2, ...EVENT_LOCK },
};

/** Sweep workers stay explicitly serial: they are leader-locked singletons by design (one repeatable job,
 *  one lock winner per tick) — parallelism there would be a bug, not a throughput win. */
export const SWEEP_WORKER_TUNING: WorkerTuning = { concurrency: 1 };

/** Per-queue processor deadlines (plan 15 §3.1): the whole processor is raced against this bound so a hung
 *  upstream (vendor call with no timeout, wedged DB) fails the ATTEMPT into the Phase-0 retry→DLQ path
 *  instead of holding the lock forever. Coarser than per-call aborts (those come with circuit breakers);
 *  generous enough that only a genuine hang trips it. CAVEAT: the orphaned work continues past the deadline
 *  (no cancellation) — safe because these consumers are idempotent; for outreach the attempts=2 double-send
 *  bound (retryPolicies.ts) is the containment. Sweeps carry no deadline: their containment is the leader
 *  TTL + internal caps + the daily re-run. */
export const PROCESSOR_DEADLINE_MS: Readonly<Record<string, number>> = {
  imports: 15 * 60_000, // large (but bounded) CSVs are legitimate
  enrichment: 2 * 60_000,
  scoring: 60_000,
  dsar: 5 * 60_000,
  outreach: 2 * 60_000,
  dedup: 5 * 60_000,
  firmographics: 5 * 60_000,
  "master-backfill": 5 * 60_000,
  reverification: 5 * 60_000,
};

/** Queues whose processors spend money per unit of work — pinned serial until F3's gates land. */
export const SPEND_PATH_QUEUES: readonly string[] = ["enrichment"];

/** Tuning lookup that throws on an unregistered queue — a typo must fail loudly at boot (register.ts runs
 *  at module load), never silently fall back to defaults. */
export function eventTuning(queue: string): WorkerTuning {
  const tuning = EVENT_WORKER_TUNING[queue];
  if (!tuning) throw new Error(`tuning.ts: no event tuning registered for queue "${queue}"`);
  return tuning;
}

/** Deadline lookup with the same fail-loud contract as eventTuning. */
export function deadlineMs(queue: string): number {
  const ms = PROCESSOR_DEADLINE_MS[queue];
  if (!ms) throw new Error(`tuning.ts: no processor deadline registered for queue "${queue}"`);
  return ms;
}
