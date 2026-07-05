// Service-worker entry (02 §2/§4) — constructs the shared-runtime singletons, wires the RuntimeContext,
// registers the message bus + event manager, and does a first warm-up (config + silent auth refresh).
import { ApiClient } from "./api/client.ts";
import { AuthModule } from "./auth/module.ts";
import { registerBus } from "./bus/index.ts";
import { RemoteConfig } from "./config/remoteConfig.ts";
import type { RuntimeContext } from "./context.ts";
import { EventStream } from "./eventStream.ts";
import { BrowserEventManager } from "./events/manager.ts";
import { CaptureQueue } from "./queue/captureQueue.ts";
import { JobScheduler } from "./queue/scheduler.ts";
import { Telemetry } from "./telemetry/telemetry.ts";

const auth = new AuthModule();
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

const scheduler = new JobScheduler(ctx);
const eventStream = new EventStream(ctx);
const manager = new BrowserEventManager(ctx, scheduler, eventStream);

registerBus(ctx, scheduler);
manager.register();

void (async () => {
  await config.load();
  await auth.init();
})();
