// Service-worker entry (02 §2/§4) — constructs the shared-runtime singletons, wires the RuntimeContext,
// registers the message bus + event manager, and does a first warm-up (config + silent auth refresh).
import { clearSession, getSession } from "../shared/storage.ts";
import { ApiClient } from "./api/client.ts";
import { classifyExternalMessage } from "./auth/companionTab.ts";
import { AuthModule } from "./auth/index.ts";
import { registerBus } from "./bus/index.ts";
import { RemoteConfig } from "./config/remoteConfig.ts";
import type { RuntimeContext } from "./context.ts";
import { CreditsStore } from "./credits/store.ts";
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
const credits = new CreditsStore(api);

const ctx: RuntimeContext = {
  api,
  auth,
  credits,
  queue,
  config,
  telemetry,
  async getState() {
    // Merge the SW-cached balance onto the auth state (auth.getState() carries a null credits placeholder).
    return {
      auth: { ...auth.getState(), credits: credits.balance },
      queueDepth: await queue.depth(),
    };
  },
  broadcast(message) {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
    // runtime.sendMessage reaches extension pages only — a content script never hears it. The one broadcast
    // the in-page card DEPENDS on (a queued capture resolving to the drain's real outcome) is therefore also
    // pushed to the LinkedIn tabs the content script runs in. Scoped to this one type on purpose: fanning
    // every STATE_CHANGED into pages would be needless chatter.
    if (message.type === "SUBJECT_STATUS") {
      void chrome.tabs
        .query({ url: "*://*.linkedin.com/*" })
        .then((tabs) => {
          for (const tab of tabs) {
            if (tab.id !== undefined) {
              void chrome.tabs.sendMessage(tab.id, message).catch(() => undefined);
            }
          }
        })
        .catch(() => undefined);
    }
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

// Persistent auth-handoff listener (ADR-0045 / doc 12): the companion tab on app.truepoint.in posts the
// verified token here. Registered at the top level so it WAKES the worker even if it died during a long
// interactive login — the transient in-Promise listener would have been lost. Every message is validated
// against the app origin + the pending state nonce (in classifyExternalMessage) before it is trusted.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void (async () => {
    const expected = await auth.pendingState();
    const classified = expected ? classifyExternalMessage(message, sender, expected) : null;
    if (!classified) {
      sendResponse({ ok: false });
      return;
    }
    if (classified.kind === "interactive") {
      await auth.activatePendingTab();
    } else {
      await auth.applyHandoff(classified.tokens);
      await credits.refresh(true); // pull the balance the moment we're signed in
      broadcastAuthState();
    }
    sendResponse({ ok: true });
  })();
  return true; // keep the channel open for the async sendResponse
});

// If the user closes the login tab before finishing, drop the pending marker.
chrome.tabs.onRemoved.addListener((tabId) => {
  void getSession<{ tabId: number | null }>("pending_auth").then((pending) => {
    if (pending?.tabId === tabId) {
      void clearSession("pending_auth");
    }
  });
});

void (async () => {
  await config.load();
  // No auth work on wake (X-0.5). Refreshing here rotated a token on every service-worker evaluation, and the
  // worker is woken by its own 1-minute alarm, so an idle install spent ~1440 rotations a day.
  //
  // The credits pre-warm went with it, for the same reason and one more: without a refresh there is no access
  // token yet, so `getState()` would report signed_out. Broadcasting THAT on wake would flash every open
  // surface to signed-out for the moment before the first real request refreshes. Saying nothing is correct —
  // the popup asks for state when it opens, and that request refreshes on demand.
})();
