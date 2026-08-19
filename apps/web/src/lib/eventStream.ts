// eventStream.ts — a fetch-based SSE reader (reveal-experience Phase 4). The api authenticates only the
// in-memory `Authorization: Bearer` access token, and native EventSource cannot set headers, so we stream over
// `fetch` + a body reader and parse text/event-stream frames by hand. Reconnects with EXPONENTIAL backoff +
// jitter (perf-audit P0.10): the old fixed 3 s timer meant any drop that wasn't a 404 — a proxy idle timeout,
// a 502 mid-deploy — had every connected tab retrying in lockstep every 3 s against a service that was already
// unhealthy (a synchronized thundering herd, each attempt possibly triggering a silentRefresh too). Backoff
// resets once a connection actually streams, a hidden tab holds off reconnecting until it is visible again,
// and a Last-Event-ID keeps the resume gap-free. A 404 (REALTIME_SSE_ENABLED off) still stops permanently so
// a dark deployment never spam-reconnects. `stop()` cancels the loop.

import { getAccessToken, silentRefresh } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";

export interface StreamedEvent {
  id: string;
  event: string;
  /** The raw `data:` payload (the JSON RealtimeEvent). */
  data: string;
}

const RECONNECT_MIN_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

// ── Stream liveness signal (perf-audit P3.8a) ────────────────────────────────────────────────────────────
// Pollers use this to pick a cadence: while the stream is LIVE, pushed events are the primary signal and a
// poll can drop to a slow backstop; while it is DARK (REALTIME_SSE_ENABLED off → the stream 404s, permanent)
// or not yet known, the poll IS the signal and keeps its short cadence. "active" is sticky across reconnect
// gaps on purpose — the backoff re-establishes within a bounded window and the backstop poll covers the gap.
type RealtimeStreamState = "unknown" | "active" | "disabled";
let streamState: RealtimeStreamState = "unknown";

/** Whether the SSE stream is live, permanently dark, or not yet known this session. */
export function realtimeStreamState(): RealtimeStreamState {
  return streamState;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Half-jittered backoff: 50-100% of the current step, so a fleet of tabs dropped by the same proxy blip
 *  spreads its retries instead of arriving in lockstep. */
function jittered(ms: number): number {
  return Math.round(ms / 2 + Math.random() * (ms / 2));
}

/** Parse one SSE frame (fields separated by \n, frames by \n\n). Returns null for a comment/heartbeat frame. */
function parseFrame(frame: string): StreamedEvent | null {
  let id = "";
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // blank or comment (heartbeat)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { id, event, data: dataLines.join("\n") };
}

/** Connect + stream events to `onEvent` until the returned `stop()` is called. */
export function connectEventStream(onEvent: (ev: StreamedEvent) => void): () => void {
  let stopped = false;
  let lastEventId: string | null = null;
  let reconnectMs = RECONNECT_MIN_MS;

  // A hidden tab must not burn reconnect attempts (or silentRefresh calls) against a struggling service —
  // hold here until it is visible again. Bounded 5 s wake-checks instead of a visibilitychange listener so
  // stop() always wins within one tick and nothing leaks.
  const waitUntilVisible = async (): Promise<void> => {
    while (!stopped && typeof document !== "undefined" && document.visibilityState === "hidden") {
      await delay(5_000);
    }
  };

  const run = async (): Promise<void> => {
    while (!stopped) {
      await waitUntilVisible();
      if (stopped) return;
      let token = getAccessToken();
      if (!token) {
        await silentRefresh();
        token = getAccessToken();
      }
      if (!token) {
        await delay(jittered(reconnectMs));
        reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
        continue;
      }
      try {
        const res = await fetch(`${API_BASE}/api/v1/events/stream`, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "text/event-stream",
            ...(lastEventId ? { "last-event-id": lastEventId } : {}),
          },
        });
        if (res.status === 404) {
          streamState = "disabled"; // realtime dark — don't reconnect; pollers keep their short cadence
          return;
        }
        if (!res.ok || !res.body) {
          await delay(jittered(reconnectMs));
          reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
          continue;
        }
        // Streaming for real — the service is healthy, so the next drop starts from the short step again.
        reconnectMs = RECONNECT_MIN_MS;
        streamState = "active";
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf("\n\n");
          while (idx >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const ev = parseFrame(frame);
            if (ev) {
              if (ev.id) lastEventId = ev.id;
              onEvent(ev);
            }
            idx = buffer.indexOf("\n\n");
          }
        }
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
      } catch {
        // network drop / token expiry — fall through to the backoff below and reconnect.
      }
      if (!stopped) {
        await delay(jittered(reconnectMs));
        reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
      }
    }
  };

  void run();
  return () => {
    stopped = true;
  };
}
