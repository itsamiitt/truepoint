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
    chrome.alarms.create("drain", { periodInMinutes: 1 });
    chrome.alarms.create("flush", { periodInMinutes: 5 });
  }

  private async onWake(): Promise<void> {
    await this.ctx.config.load();
    await this.ctx.auth.init();
    void this.eventStream.start();
  }

  private async onAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
    if (alarm.name === "drain") {
      await this.scheduler.drain();
    } else if (alarm.name === "flush") {
      await this.ctx.telemetry.flush();
    }
  }
}
