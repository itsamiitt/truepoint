// dsarDeadlineSweep.ts — the DSAR breach probe (09-compliance §DSAR; A-01).
//
// `dsarRequestRepository.findOverdue` has existed, with an itest, since the DSAR work landed. Its own doc
// comment reads "This is the query the breach probe runs" — and nothing ran it. A repository method with no
// caller was found by auditing repository methods for call sites (853 scanned, 54 with no non-test caller),
// and this one mattered more than the rest: the others are dark FEATURES behind a flag, while this is the
// only thing that would notice a statutory clock running out.
//
// What existed instead: apps/api/src/features/admin/compliance.ts computes `overdue` per row when a staff
// user loads the compliance page. That is a PULL — it tells you the deadline was missed only if somebody
// happens to look, and nobody looks at a queue that is usually empty. The 72h SLA in findOverdue's coalesce
// is the product's own promise; a promise whose breach is invisible until someone opens a page is not
// operable. This is the push half: a gauge a collector scrapes and an alert can fire on.
//
// COMPLIANCE IMPACT (CLAUDE.md rule 3, checklist in docs/strategy/09-compliance.md). Reads only. It writes
// nothing, stores nothing, exports nothing, and shows nothing to an end user. The query returns ids and
// timings ONLY — `findOverdue` deliberately selects id/request_type/status/requested_at/due_at and never
// `subject_email_blind_index`, so the person behind the request cannot appear in a log line or a metric label
// here. Metric names are static strings and carry no id (the zero-dep renderer has no label support anyway).
// Net effect on data subjects is positive: it shortens the time an unanswered access/erasure request can sit
// past its deadline unnoticed. No new collection, storage, display, or export of personal data.
//
// Runs HOURLY, not daily: against a 72h clock a daily probe can report a breach up to 24h after it happened,
// which is a quarter of the whole budget spent on detection latency.

import { dsarRequestRepository, withPrivilegedTx } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";
import { setComplianceGauge } from "../metrics.ts";

export const DSAR_DEADLINE_SWEEP_QUEUE = "dsar_deadline_sweep";
const LEADER_KEY = "leader:dsar_deadline_sweep";
const LEADER_TTL_MS = 5 * 60_000;

/** Cap on rows pulled per tick. The gauge is a "how bad is it" signal, not a worklist; 500 breaches is
 *  already a five-alarm number and the page shows the full set. */
const MAX_ROWS = 500;

/** How many ids to name in the log line. Enough to start on without turning a log into a report. */
const LOGGED_IDS = 10;

export type DsarDeadlineSweepJobData = Record<string, never>;

/** The one repository call, injectable so the sweep is unit-testable without Postgres (same seam shape as
 *  outboxRelay's `Pick<typeof outboxRepository, …>`). */
export interface DsarDeadlineSweepDeps {
  findOverdue?: (now: Date) => Promise<
    Array<{
      id: string;
      requestType: string;
      status: string;
      requestedAt: Date;
      dueAt: Date;
    }>
  >;
  /**
   * The clock, injectable for tests.
   *
   * Added because the first version of the test was FLAKY and CI caught it: the fixture built its `dueAt`
   * inside the `findOverdue` callback, which runs AFTER the sweep has already read the wall clock, so the
   * measured age was 28h minus however many milliseconds separated the two reads. It floored to 28 locally
   * (same millisecond) and to 27 on the runner. Worse, the sibling branch carrying the identical test passed
   * — so it was intermittent, not broken, which is the harder kind to ever diagnose again.
   *
   * Padding the fixture would have hidden it. Handing the test the clock removes wall-time from the
   * assertion altogether, so an age assertion is exact rather than probable.
   */
  now?: () => Date;
}

export function makeProcessDsarDeadlineSweep(redis: IORedis, deps: DsarDeadlineSweepDeps = {}) {
  const findOverdue =
    deps.findOverdue ??
    ((now: Date) => withPrivilegedTx((tx) => dsarRequestRepository.findOverdue(tx, now, MAX_ROWS)));
  const clock = deps.now ?? (() => new Date());

  return async function processDsarDeadlineSweep(
    _job: Job<DsarDeadlineSweepJobData>,
  ): Promise<void> {
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const now = clock();
      const overdue = await findOverdue(now);

      // Both gauges are written on EVERY tick, including the zero case. A gauge that is only set when
      // something is wrong is indistinguishable from a dead sweep: the series just stops, the alert stops
      // firing, and silence reads as health. Writing 0 is what makes "no breaches" an observation rather
      // than an absence.
      setComplianceGauge("dsar_overdue", overdue.length);

      if (overdue.length === 0) {
        setComplianceGauge("dsar_oldest_overdue_seconds", 0);
        return;
      }

      // findOverdue orders by due_at ASC, so the first row is the longest overdue. Recomputed rather than
      // trusted: a sort that changes upstream would otherwise silently under-report the worst breach.
      let oldestMs = 0;
      for (const row of overdue) {
        const overdueBy = now.getTime() - row.dueAt.getTime();
        if (overdueBy > oldestMs) oldestMs = overdueBy;
      }
      setComplianceGauge("dsar_oldest_overdue_seconds", Math.floor(oldestMs / 1000));

      // Request ids and types only — never the subject. See the compliance note in the header.
      log.warn("dsar deadline breach: requests past their SLA", {
        count: overdue.length,
        oldestOverdueHours: Math.floor(oldestMs / 3_600_000),
        truncated: overdue.length === MAX_ROWS,
        requests: overdue.slice(0, LOGGED_IDS).map((r) => ({
          id: r.id,
          requestType: r.requestType,
          status: r.status,
        })),
      });
    });
  };
}
