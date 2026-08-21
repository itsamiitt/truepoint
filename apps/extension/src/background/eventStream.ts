// EventStream — a single SW-held consumer of GET /events/stream, dark behind the realtimeSse flag
// (02 §4/§10). MV3 service workers have no `EventSource`, so we stream the response body with fetch and
// parse `text/event-stream` frames manually. Fanned to UI via broadcasts; falls back to alarm polling.
import { EVENT_CONTACT_LOOKUP_UPDATED, realtimeEventSchema } from "@leadwolf/types";
import { API_BASE } from "../shared/env.ts";
import type { RuntimeContext } from "./context.ts";
import { refreshSubjectFromEvent } from "./lookup/resolver.ts";

// In-life reconnect backoff (perf-checklist PA-11): 3s doubling to 60s with half-jitter — the same posture
// as the web client's eventStream. Without it, every LIVE service worker whose stream dropped (an API
// restart drops the whole fleet at once) either slammed an immediate retry or sat dark until the 1-minute
// wake alarm, and the fleet re-connected in one synchronized burst. The alarm remains the resurrection net
// for a KILLED worker — an in-SW timer dies with the worker, and that is fine.
const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 60_000;

export class EventStream {
  private controller: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly ctx: RuntimeContext) {}

  async start(): Promise<void> {
    if (!this.ctx.config.isEnabled("realtimeSse") || this.controller) {
      return;
    }
    this.stopped = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const token = await this.ctx.auth.getAccessToken();
    if (!token) {
      return;
    }
    this.controller = new AbortController();
    try {
      const res = await fetch(`${API_BASE}/events/stream`, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: this.controller.signal,
      });
      if (!res.ok || !res.body) {
        this.controller = null;
        this.scheduleRetry();
        return;
      }
      // Connected — a healthy stream resets the backoff ladder.
      this.attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let reading = true;
      while (reading) {
        const { value, done } = await reader.read();
        if (done) {
          reading = false;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          await this.dispatch(frame);
        }
      }
    } catch {
      // aborted or network drop — the alarm-driven poller keeps state fresh
    } finally {
      this.controller = null;
      this.scheduleRetry();
    }
  }

  /** Jittered reconnect while this worker lives; no-op after an explicit stop(). */
  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer || !this.ctx.config.isEnabled("realtimeSse")) {
      return;
    }
    this.attempt += 1;
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.attempt - 1));
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2)); // half-jitter, like the web client
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  private async dispatch(frame: string): Promise<void> {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(dataLine.slice("data:".length).trim());
    } catch {
      return; // malformed frame
    }
    const parsed = realtimeEventSchema.safeParse(raw);
    if (parsed.success && parsed.data.type === EVENT_CONTACT_LOOKUP_UPDATED) {
      // A profile the user viewed was refreshed by the background sweep (chrome-extension/15 P2): re-resolve
      // just that subject and push the fresh status so the hover card / panel update without a page reload.
      // A non-matching card ignores the broadcast; a missed push is covered by the next LOOKUP.
      const result = await refreshSubjectFromEvent(this.ctx, parsed.data.payload);
      if (result) {
        this.ctx.broadcast({
          type: "SUBJECT_STATUS",
          subjectKey: result.subjectKey,
          status: result.status,
        });
      }
      return;
    }
    // Any other server event (reveal.completed / credits.changed / job progress) refreshes derived state.
    this.ctx.broadcast({ type: "STATE_CHANGED", state: await this.ctx.getState() });
  }
}
