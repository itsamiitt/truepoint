// eventStream.ts — a fetch-based SSE reader (reveal-experience Phase 4). The api authenticates only the
// in-memory `Authorization: Bearer` access token, and native EventSource cannot set headers, so we stream over
// `fetch` + a body reader and parse text/event-stream frames by hand. Reconnects with a short backoff and a
// Last-Event-ID so a dropped connection resumes gap-free; a 404 (REALTIME_SSE_ENABLED off) stops permanently so
// a dark deployment never spam-reconnects. `stop()` cancels the loop.

import { getAccessToken, silentRefresh } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";

export interface StreamedEvent {
  id: string;
  event: string;
  /** The raw `data:` payload (the JSON RealtimeEvent). */
  data: string;
}

const RECONNECT_MS = 3000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  const run = async (): Promise<void> => {
    while (!stopped) {
      let token = getAccessToken();
      if (!token) {
        await silentRefresh();
        token = getAccessToken();
      }
      if (!token) {
        await delay(RECONNECT_MS);
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
        if (res.status === 404) return; // realtime disabled — don't reconnect
        if (!res.ok || !res.body) {
          await delay(RECONNECT_MS);
          continue;
        }
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
        // network drop / token expiry — reconnect after a short backoff.
      }
      if (!stopped) await delay(RECONNECT_MS);
    }
  };

  void run();
  return () => {
    stopped = true;
  };
}
