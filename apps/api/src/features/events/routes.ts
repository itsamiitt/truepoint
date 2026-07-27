// routes.ts — the authenticated SSE gateway (reveal-experience Phase 4, ADR-0027). GET /events/stream opens a
// long-lived text/event-stream scoped to the caller's WORKSPACE: it attaches to the process-wide subscriber
// (hub.ts) for the workspace pub/sub channel the relay publishes to, and forwards each event as an SSE frame
// (`event:` = the domain type, `id:` = the outbox event_id for Last-Event-ID resume). RLS/visibility scoping =
// the channel is keyed by the verified-token workspace, never the body. Dark until REALTIME_SSE_ENABLED (else
// 404). Mounted in app.ts BEFORE compress() so the stream is never buffered by the compressor.
//
// It used to open a DEDICATED Redis client per connection; see hub.ts for why one shared subscriber with
// per-channel refcounting replaced that, and why it is SUBSCRIBE rather than PSUBSCRIBE.

import { env } from "@leadwolf/config";
import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  type RealtimeEvent,
  workspaceEventChannel,
} from "@leadwolf/types";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import IORedis from "ioredis";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";
import { type RealtimeHub, createConnectionCap, createRealtimeHub } from "./hub.ts";

const HEARTBEAT_MS = 15_000;

/** Concurrent streams one user may hold on this process. A browser opens one per tab; a script can open
 *  thousands, and without a cap one caller can consume the process's entire stream budget. */
const MAX_STREAMS_PER_USER = 5;

/** ONE subscriber connection for the whole process, created on first use so a process that never serves a
 *  stream never opens it. Replaces a dedicated IORedis client per connection — at 10k connected dashboards
 *  that was 10k Redis connections from one process, against a default `maxclients` of 10000, so the failure
 *  mode was not slowness but "no further connections", including the queues'. */
let hub: RealtimeHub | undefined;
function realtimeHub(): RealtimeHub {
  if (!hub) {
    hub = createRealtimeHub(new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }));
  }
  return hub;
}

const streamCap = createConnectionCap(MAX_STREAMS_PER_USER);

export const eventsRoutes = new Hono<{ Variables: TenancyVariables }>();

eventsRoutes.use("*", authn);
eventsRoutes.use("*", tenancy);

eventsRoutes.get("/stream", (c) => {
  if (!env.REALTIME_SSE_ENABLED) throw new NotFoundError("Realtime delivery is not enabled.");
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to subscribe.");
  const channel = workspaceEventChannel(workspaceId);

  // Per-user cap BEFORE the stream opens — refusing with a status is honest, whereas accepting and then
  // starving is not (ADR-0027 "cap + scale SSE connections").
  const release = streamCap.acquire(c.get("claims").sub);
  if (!release) {
    // 429 with a Retry-After the client can act on, rather than a silent hang or an accepted-then-starved stream.
    throw new RateLimitedError(30);
  }

  return streamSSE(c, async (stream) => {
    // Attach to the PROCESS-WIDE subscriber rather than opening a connection of our own. The hub refcounts
    // per channel, so N streams on one workspace cost one Redis SUBSCRIBE.
    const messages: string[] = [];
    let notify: (() => void) | null = null;
    let closed = false;

    const wake = () => {
      const n = notify;
      notify = null;
      n?.();
    };

    const detach = await realtimeHub().subscribe(channel, (message) => {
      messages.push(message);
      wake();
    });

    stream.onAbort(() => {
      closed = true;
      wake();
      // Detach from the shared subscriber and give the user's slot back. Both are idempotent, because abort
      // can fire more than once and a double release would inflate the cap for everyone else.
      detach();
      release();
    });

    await stream.writeSSE({ event: "ready", data: "{}" });

    try {
      while (!closed) {
        // Drain everything buffered, in order.
        while (messages.length > 0 && !closed) {
          const m = messages.shift();
          if (!m) break;
          try {
            const ev = JSON.parse(m) as RealtimeEvent;
            await stream.writeSSE({ id: ev.id, event: ev.type, data: m });
          } catch {
            // skip a malformed payload — never break the stream on one bad message
          }
        }
        if (closed) break;
        // Wait for the next message OR a heartbeat tick (keeps the connection alive through proxies).
        await Promise.race([
          new Promise<void>((resolve) => {
            notify = resolve;
          }),
          stream.sleep(HEARTBEAT_MS),
        ]);
        if (!closed && messages.length === 0) {
          await stream.writeSSE({ event: "ping", data: "{}" });
        }
      }
    } finally {
      // Belt-and-braces cleanup for any exit that is not an abort (a write that throws, say). Both are
      // idempotent, so running them here as well as in onAbort is safe — and leaking either a hub listener or
      // a cap slot is a slow resource leak that only shows up under sustained load.
      detach();
      release();
    }
  });
});
