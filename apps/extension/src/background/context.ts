// The RuntimeContext every feature module borrows (09 §6, layer 3). Holds the shared-runtime singletons
// so modules stay thin and never touch chrome.* transport or providers directly.
import type { AppState, BroadcastMessage } from "../shared/messages.ts";
import type { ApiClient } from "./api/client.ts";
import type { AuthModule } from "./auth/module.ts";
import type { RemoteConfig } from "./config/remoteConfig.ts";
import type { CaptureQueue } from "./queue/captureQueue.ts";
import type { Telemetry } from "./telemetry/telemetry.ts";

export interface RuntimeContext {
  api: ApiClient;
  auth: AuthModule;
  queue: CaptureQueue;
  config: RemoteConfig;
  telemetry: Telemetry;
  getState(): Promise<AppState>;
  broadcast(msg: BroadcastMessage): void;
}
