// EventStream — a single SW-held consumer of GET /events/stream, dark behind the realtimeSse flag
// (02 §4/§10). MV3 service workers have no `EventSource`, so we stream the response body with fetch and
// parse `text/event-stream` frames manually. Fanned to UI via broadcasts; falls back to alarm polling.
import { API_BASE } from "../shared/env.ts";
import type { RuntimeContext } from "./context.ts";

export class EventStream {
  private controller: AbortController | null = null;

  constructor(private readonly ctx: RuntimeContext) {}

  async start(): Promise<void> {
    if (!this.ctx.config.isEnabled("realtimeSse") || this.controller) {
      return;
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
        return;
      }
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
    }
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private async dispatch(frame: string): Promise<void> {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) {
      return;
    }
    try {
      JSON.parse(dataLine.slice("data:".length).trim());
      // Any server event (reveal.completed / credits.changed / job progress) refreshes derived state.
      this.ctx.broadcast({ type: "STATE_CHANGED", state: await this.ctx.getState() });
    } catch {
      // ignore malformed frame
    }
  }
}
