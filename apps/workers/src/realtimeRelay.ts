// realtimeRelay.ts — drains the domain-event outbox → Redis pub/sub (ADR-0027 relay). A self-scheduling loop
// (each tick's next timer is `.unref()`-ed so the relay NEVER blocks a clean process shutdown; an in-flight
// row simply stays `pending` and the next process/instance picks it up). LEADERLESS: `claimBatch` uses
// FOR UPDATE SKIP LOCKED, so multiple worker instances can drain concurrently with no double-publish. It only
// PUBLISHes (no subscribe), so a plain Redis client is fine. The base `db` connection is the OWNER → it bypasses
// the event_outbox ENABLE-not-FORCE RLS and reads pending rows across ALL workspaces. Started only when
// REALTIME_SSE_ENABLED (register.ts); dark otherwise.

import { db, eventOutboxRepository } from "@leadwolf/db";
import { type RealtimeEvent, workspaceEventChannel } from "@leadwolf/types";
import type Redis from "ioredis";
import { log } from "./logger.ts";

const RELAY_INTERVAL_MS = 750;
const RELAY_BATCH = 200;

/** Start the outbox→pub/sub relay loop. `publisher` is a dedicated Redis client used only for PUBLISH. */
export function startRealtimeRelay(publisher: Redis): void {
  const tick = async (): Promise<void> => {
    try {
      await db.transaction(async (tx) => {
        const events = await eventOutboxRepository.claimBatch(tx, RELAY_BATCH);
        if (events.length === 0) return;
        // PIPELINED, not awaited one at a time. The publishes must stay INSIDE this transaction —
        // `claimBatch` is a bare SELECT ... FOR UPDATE SKIP LOCKED that does not change `status`, so the row
        // lock held until COMMIT is the *only* thing stopping a second relay instance from claiming the same
        // still-'pending' rows and publishing them twice. Moving the publish out would need a real claimed
        // state plus a reclaim timeout, which is a schema change, not a refactor.
        //
        // What was actually costing us is that the loop awaited each PUBLISH in turn, so a full batch held a
        // transaction — and one of the pool's 10 connections — across up to 200 sequential Redis round-trips.
        // A pipeline sends all of them in one write and waits once, so the transaction is open for a single
        // round-trip regardless of batch size, with the double-publish guarantee untouched.
        const pipeline = publisher.pipeline();
        for (const ev of events) {
          const msg: RealtimeEvent = {
            id: ev.id,
            type: ev.eventType,
            workspaceId: ev.workspaceId,
            payload: ev.payload,
          };
          pipeline.publish(workspaceEventChannel(ev.workspaceId), JSON.stringify(msg));
        }
        const results = await pipeline.exec();
        // `exec()` resolves null if the pipeline itself was aborted, and otherwise reports per-command errors
        // WITHOUT rejecting. Either case must throw: rolling back leaves the rows 'pending' and unlocked, so
        // the next tick redelivers them. That is at-least-once — the same guarantee the previous code gave
        // when a mid-loop publish threw, and consumers already dedupe on the event id.
        if (results === null) throw new Error("realtime relay: publish pipeline aborted");
        const failure = results.find(([err]) => err !== null)?.[0];
        if (failure) throw failure;
        await eventOutboxRepository.markPublished(
          tx,
          events.map((ev) => ev.id),
        );
      });
    } catch (e) {
      log.error("realtime relay: drain failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTimeout(() => void tick(), RELAY_INTERVAL_MS).unref();
    }
  };
  setTimeout(() => void tick(), RELAY_INTERVAL_MS).unref();
}
