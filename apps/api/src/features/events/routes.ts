// routes.ts — the authenticated SSE gateway (reveal-experience Phase 4, ADR-0027). GET /events/stream opens a
// long-lived text/event-stream scoped to the caller's WORKSPACE: it subscribes a DEDICATED Redis client to the
// workspace pub/sub channel the relay publishes to, and forwards each event as an SSE frame (`event:` = the
// domain type, `id:` = the outbox event_id for Last-Event-ID resume). RLS/visibility scoping = the channel is
// keyed by the verified-token workspace, never the body. Dark until REALTIME_SSE_ENABLED (else 404). Mounted in
// app.ts BEFORE compress() so the stream is never buffered by the compressor.

import { env } from "@leadwolf/config";
import {
  ForbiddenError,
  NotFoundError,
  type RealtimeEvent,
  workspaceEventChannel,
} from "@leadwolf/types";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import IORedis from "ioredis";
import { authn } from "../../middleware/authn.ts";
import { type TenancyVariables, tenancy } from "../../middleware/tenancy.ts";

const HEARTBEAT_MS = 15_000;

export const eventsRoutes = new Hono<{ Variables: TenancyVariables }>();

eventsRoutes.use("*", authn);
eventsRoutes.use("*", tenancy);

eventsRoutes.get("/stream", (c) => {
  if (!env.REALTIME_SSE_ENABLED) throw new NotFoundError("Realtime delivery is not enabled.");
  const workspaceId = c.get("workspaceId");
  if (!workspaceId) throw new ForbiddenError("no_workspace", "Select a workspace to subscribe.");
  const channel = workspaceEventChannel(workspaceId);

  return streamSSE(c, async (stream) => {
    // A dedicated subscriber per connection (a client in subscribe-mode can't run other commands). Capping +
    // sharing per-workspace is a scale follow-up (ADR-0027 "cap + scale SSE connections").
    const sub = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const messages: string[] = [];
    let notify: (() => void) | null = null;
    let closed = false;

    const wake = () => {
      const n = notify;
      notify = null;
      n?.();
    };

    sub.on("message", (_ch, message) => {
      messages.push(message);
      wake();
    });

    stream.onAbort(() => {
      closed = true;
      wake();
      void sub.quit();
    });

    await sub.subscribe(channel);
    await stream.writeSSE({ event: "ready", data: "{}" });

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
  });
});
