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
        const publishedIds: string[] = [];
        for (const ev of events) {
          const msg: RealtimeEvent = {
            id: ev.id,
            type: ev.eventType,
            workspaceId: ev.workspaceId,
            payload: ev.payload,
          };
          await publisher.publish(workspaceEventChannel(ev.workspaceId), JSON.stringify(msg));
          publishedIds.push(ev.id);
        }
        await eventOutboxRepository.markPublished(tx, publishedIds);
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
