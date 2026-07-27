// BrowserEventManager — the only place that touches chrome.* lifecycle events (02 §5). Normalises
// startup/install/alarm events; every handler rehydrates from storage first (the worker may be cold).
// Periodic work uses chrome.alarms (never setInterval, which dies with the worker).
import type { RuntimeContext } from "../context.ts";
import type { EventStream } from "../eventStream.ts";
import type { JobScheduler } from "../queue/scheduler.ts";

export class BrowserEventManager {
  constructor(
    private readonly ctx: RuntimeContext,
    private readonly scheduler: JobScheduler,
    private readonly eventStream: EventStream,
  ) {}

  register(): void {
    chrome.runtime.onInstalled.addListener(() => {
      void this.onWake();
    });
    chrome.runtime.onStartup.addListener(() => {
      void this.onWake();
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
      void this.onAlarm(alarm);
    });
    // Create each alarm ONLY if it does not already exist. chrome.alarms.create() on an existing name replaces
    // it and restarts its period from zero — and register() runs on every service-worker evaluation, which the
    // 1-minute `drain` alarm itself triggers. So the old unconditional create meant every drain wake reset the
    // 5-minute `flush` countdown before it could elapse: `flush` never fired, and the IndexedDB telemetry store
    // was never trimmed. Fire-and-forget is fine — a missed create is recovered on the next wake.
    void this.ensureAlarm("drain", 1);
    void this.ensureAlarm("flush", 5);
  }

  private async ensureAlarm(name: string, periodInMinutes: number): Promise<void> {
    const existing = await chrome.alarms.get(name);
    if (!existing) {
      chrome.alarms.create(name, { periodInMinutes });
    }
  }

  private async onWake(): Promise<void> {
    await this.ctx.config.load();
    // No auth.init() here either (X-0.5). It was a DUPLICATE of the module-level wake path — the service
    // worker re-evaluates the whole module on wake, so this ran a second eager refresh on top of that one.
    void this.eventStream.start();
  }

  private async onAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
    if (alarm.name === "drain") {
      await this.scheduler.drain();
    } else if (alarm.name === "flush") {
      await this.ctx.telemetry.flush();
    } else if (alarm.name === "auth-refresh") {
      // Silent pre-refresh: wakes the worker if needed and re-mints before the token expires (doc 10 §4.3).
      await this.ctx.auth.refreshNow();
      this.ctx.broadcast({ type: "STATE_CHANGED", state: await this.ctx.getState() });
    }
  }
}
