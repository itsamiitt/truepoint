// outboxRelay.ts — the LEADERLESS outbox relay (ADR-0027; worker-platform plan 15 §5 — Phase 3, re-audit
// F1/F2). Drains `worker_outbox` on a continuous short poll and publishes each row to its topic's publisher
// (BullMQ). Leaderless by construction: concurrency safety comes from the repository's FOR UPDATE SKIP LOCKED
// claim, so N worker replicas each drain disjoint rows with no leader lock — deliberately NOT the
// projection_sweep shape (leader-locked, daily, capped): a money-path relay is latency-critical and
// continuous (F2). Delivery is AT-LEAST-ONCE: a crash between publish and settle re-publishes on a later
// claim; consumers dedupe by stable BullMQ jobId. Poison rows fail out via the repository's attempts cap.
//
// A recursive setTimeout (not setInterval) guarantees ticks never overlap; stop() halts the schedule and
// awaits the in-flight tick so shutdown never races a half-published batch.

import { outboxRepository } from "@leadwolf/db";
import { log } from "./logger.ts";

/** Publishes one claimed payload for a topic (throws to leave the row pending for a later re-claim). */
export type OutboxPublisher = (payload: unknown) => Promise<void>;

export interface OutboxRelayOptions {
  /** topic → publisher. A claimed row with no publisher is terminally failed (config bug, surfaced loudly). */
  publishers: Record<string, OutboxPublisher>;
  /** Poll interval between DRAINED ticks (a full batch re-polls immediately via the drain loop). */
  pollMs?: number;
  batchSize?: number;
  /** Injectable repository seam for unit tests (defaults to the real DB-backed repository). */
  repository?: Pick<typeof outboxRepository, "claimPendingBatch" | "markPublished" | "markFailed">;
}

export interface OutboxRelayHandle {
  /** Stop the schedule and await the in-flight tick. Safe to call more than once. */
  stop(): Promise<void>;
}

export function startOutboxRelay(options: OutboxRelayOptions): OutboxRelayHandle {
  const pollMs = options.pollMs ?? 1_000;
  const batchSize = options.batchSize ?? 25;
  const repository = options.repository ?? outboxRepository;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  async function tick(): Promise<void> {
    try {
      // Keep draining while full batches come back (a backlog clears at publish speed, not poll speed).
      for (;;) {
        const rows = await repository.claimPendingBatch(batchSize);
        for (const row of rows) {
          const publish = options.publishers[row.topic];
          if (!publish) {
            // No publisher = a wiring bug, not a transient — fail terminally so it can't spin the attempts cap.
            await repository.markFailed(row.id, `no publisher registered for topic "${row.topic}"`);
            log.error("outbox relay: unknown topic", { topic: row.topic, outboxId: row.id });
            continue;
          }
          try {
            await publish(row.payload);
            await repository.markPublished(row.id);
          } catch (e) {
            // Leave the row pending: the claim already counted the attempt, a later tick re-claims it, and
            // the repository fails it out after MAX_PUBLISH_ATTEMPTS. Never throw out of the loop — one bad
            // row must not stall its batch.
            log.error("outbox relay: publish failed", {
              topic: row.topic,
              outboxId: row.id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        if (stopped || rows.length < batchSize) break;
      }
    } catch (e) {
      // A claim failure (DB blip) is transient: log and let the next scheduled tick retry.
      log.error("outbox relay: tick failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (!stopped) timer = setTimeout(run, pollMs);
    }
  }

  function run(): void {
    inFlight = tick();
  }

  run();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
