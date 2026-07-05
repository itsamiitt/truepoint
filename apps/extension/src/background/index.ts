// Service-worker entry (02 §2/§4) — constructs the shared-runtime singletons, wires the RuntimeContext,
// registers the message bus + event manager, and does a first warm-up (config + silent auth refresh).
import { ApiClient } from "./api/client.ts";
import { AuthModule } from "./auth/index.ts";
import { registerBus } from "./bus/index.ts";
import { RemoteConfig } from "./config/remoteConfig.ts";
import type { RuntimeContext } from "./context.ts";
import { EventStream } from "./eventStream.ts";
import { BrowserEventManager } from "./events/manager.ts";
import { CaptureQueue } from "./queue/captureQueue.ts";
import { JobScheduler } from "./queue/scheduler.ts";
import { Telemetry } from "./telemetry/telemetry.ts";

const REFRESH_LEAD_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 30_000;

// Late-bound state broadcaster: wired after `ctx` exists (the async account lookup fires onStateChanged).
let broadcastAuthState: () => void = () => {};

// Silent re-auth pre-refresh (doc 10 §4.3): schedule a one-shot alarm ~60s before the token expires.
// chrome.alarms survives MV3 worker death (setTimeout does not); the manager routes it to auth.refreshNow().
const auth = new AuthModule({
  onTokenChanged(expiresAtMs) {
    if (expiresAtMs && expiresAtMs > Date.now()) {
      // Floor the delay so a short/edge TTL can't schedule an immediate, tight refresh loop.
      const when = Math.max(expiresAtMs - REFRESH_LEAD_MS, Date.now() + MIN_REFRESH_DELAY_MS);
      chrome.alarms.create("auth-refresh", { when });
    } else {
      void chrome.alarms.clear("auth-refresh");
    }
  },
  onStateChanged() {
    broadcastAuthState();
  },
});
const queue = new CaptureQueue();
const config = new RemoteConfig();
const telemetry = new Telemetry();
const api = new ApiClient(auth);

const ctx: RuntimeContext = {
  api,
  auth,
  queue,
  config,
  telemetry,
  async getState() {
    return { auth: auth.getState(), queueDepth: await queue.depth() };
  },
  broadcast(message) {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  },
};

// Now that ctx exists, let the auth module trigger a state re-broadcast when the async account resolves.
broadcastAuthState = () => {
  void ctx.getState().then((state) => ctx.broadcast({ type: "STATE_CHANGED", state }));
};

const scheduler = new JobScheduler(ctx);
const eventStream = new EventStream(ctx);
const manager = new BrowserEventManager(ctx, scheduler, eventStream);

registerBus(ctx, scheduler);
manager.register();

void (async () => {
  await config.load();
  await auth.init();
})();
