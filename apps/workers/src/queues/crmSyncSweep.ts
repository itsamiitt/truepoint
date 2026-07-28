// crmSyncSweep.ts — the leader-locked CRM-sync scheduler (crm-sync 00 §3.2 / §3.3).
//
// One repeatable job fans out per-connection work: the DELTA tick enumerates connections whose next_poll_at
// is due and enqueues a pull for each; the REFRESH tick enumerates connections whose OAuth token is about
// to expire and enqueues a refresh. Both are leader-locked so exactly one worker fans out per tick, and
// both cap their fan-out so a single tick can never enqueue unbounded work — a connection still due after
// the cap is picked up next tick, because the enumeration only returns connections that are STILL due.
//
// L1 IS CHECKED HERE, BEFORE THE LEADER LOCK. With CRM_SYNC_ENABLED off the sweep does not contend for the
// lock at all: a dark engine should cost nothing, not spin a Redis lock every 60 seconds across every
// worker in the fleet. The runners re-check the same gate (a job can outlive a flag change), so skipping
// here is a cost optimisation, not the security boundary.
//
// The enumerations run on the OWNER connection (cross-tenant maintenance, like every other sweep here) and
// project IDS + SCOPE ONLY — never a credential. The per-connection work then re-enters withTenantTx, so
// the actual token decrypt stays RLS-enforced.
//
// Per-connection enqueue failures are logged and skipped, never fatal: one bad connection must not stop the
// fleet's sweep for everyone else.

import { env } from "@leadwolf/config";
import { crmConnectionRepository } from "@leadwolf/db";
import type { Job } from "bullmq";
import type IORedis from "ioredis";
import { withLeaderLock } from "../leaderLock.ts";
import { log } from "../logger.ts";

export const CRM_SYNC_SWEEP_QUEUE = "crm_sync_sweep";
const LEADER_KEY = "leader:crm_sync_sweep";
const LEADER_TTL_MS = 5 * 60_000;

/** How close to expiry a token must be before the refresh tick picks it up. */
const REFRESH_SKEW_MS = 10 * 60_000;

export interface CrmSyncSweepJobData {
  /** `delta` = the 60s poll tick; `refresh` = the token-refresh tick. */
  kind: "delta" | "refresh";
}

export interface CrmConnectionRef {
  id: string;
  tenantId: string;
  workspaceId: string;
  provider: string;
}

export interface CrmSweepEnqueuers {
  /** Enqueue an incremental pull for one connection. */
  enqueuePull(conn: CrmConnectionRef): Promise<unknown>;
  /** Enqueue a token refresh for one connection. */
  enqueueRefresh(conn: CrmConnectionRef): Promise<unknown>;
  /**
   * The two worklist reads. Injected with the repository's defaults rather than imported directly so the
   * processor can be exercised whole in a unit test — mocking @leadwolf/db would be process-global under
   * `bun test` and would leak into every other test file in the run.
   */
  listDueForPoll?(limit: number): Promise<CrmConnectionRef[]>;
  listDueForRefresh?(withinMs: number, limit: number): Promise<CrmConnectionRef[]>;
  /**
   * L1, as an INPUT rather than an env read inside the processor — the same shape the runners use.
   *
   * `env` is parsed once at module load, so a processor that read it directly could only ever be tested in
   * whichever state the test process happened to boot with. Passing it in means both directions of the gate
   * are exercised in every run. The composition root supplies `env.CRM_SYNC_ENABLED`.
   */
  enabled?: boolean;
}

/**
 * Build the sweep processor. The enqueuers are injected to avoid a circular import with register.ts — the
 * same shape makeProcessReverificationSweep uses.
 */
export function makeProcessCrmSyncSweep(redis: IORedis, enqueue: CrmSweepEnqueuers) {
  return async function processCrmSyncSweep(job: Job<CrmSyncSweepJobData>): Promise<void> {
    // L1, before the lock — see the header.
    if (!(enqueue.enabled ?? env.CRM_SYNC_ENABLED)) return;

    const kind = job.data?.kind ?? "delta";
    await withLeaderLock(redis, LEADER_KEY, LEADER_TTL_MS, async () => {
      const cap = env.CRM_SYNC_MAX_CONNECTIONS_PER_SWEEP;

      const listPoll = enqueue.listDueForPoll ?? crmConnectionRepository.listDueForPoll;
      const listRefresh = enqueue.listDueForRefresh ?? crmConnectionRepository.listDueForRefresh;

      const connections =
        kind === "refresh" ? await listRefresh(REFRESH_SKEW_MS, cap) : await listPoll(cap);

      if (connections.length === 0) return;

      let enqueued = 0;
      for (const conn of connections) {
        try {
          if (kind === "refresh") await enqueue.enqueueRefresh(conn);
          else await enqueue.enqueuePull(conn);
          enqueued += 1;
        } catch (e) {
          // Best-effort per connection: a single bad connection must not stop the fleet's sweep.
          log.error("crm sync sweep: per-connection enqueue failed", {
            kind,
            connectionId: conn.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      if (enqueued > 0) {
        log.info("crm sync sweep: per-connection jobs enqueued", { kind, count: enqueued });
      }
      if (connections.length === cap) {
        // Never silently truncate. Hitting the cap every tick is the signal that the fan-out limit needs
        // raising or that connections are not advancing their next_poll_at.
        log.warn("crm sync sweep: fan-out cap reached", { kind, cap });
      }
    });
  };
}
