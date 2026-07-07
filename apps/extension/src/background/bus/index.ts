// MessageBus (SW side) — validates every inbound message with Zod, routes to a handler, and returns a
// typed response (03 §1.8). Unknown/invalid messages are dropped. Returns `true` to keep the channel
// open for the async response.
import { type RequestMessage, requestMessage } from "../../shared/messages.ts";
import { ApiError } from "../api/client.ts";
import type { RuntimeContext } from "../context.ts";
import type { JobScheduler } from "../queue/scheduler.ts";

export function registerBus(ctx: RuntimeContext, scheduler: JobScheduler): void {
  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
    const parsed = requestMessage.safeParse(raw);
    if (!parsed.success) {
      sendResponse({ error: "bad_message" });
      return false;
    }
    handle(ctx, scheduler, parsed.data)
      .then(sendResponse)
      .catch((error: unknown) => sendResponse({ error: String(error) }));
    return true;
  });
}

async function handle(
  ctx: RuntimeContext,
  scheduler: JobScheduler,
  msg: RequestMessage,
): Promise<unknown> {
  switch (msg.type) {
    case "PING":
      return { pong: true };

    case "GET_STATE": {
      // Return the cached state now; if signed in, kick a staleness-bounded credits refresh and re-broadcast
      // when the balance changes (the popup/panel subscribe to STATE_CHANGED).
      if (ctx.auth.tenantId) {
        void ctx.credits
          .refresh()
          .then(async () => ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() }));
      }
      return ctx.getState();
    }

    case "LOOKUP":
      // TODO: wire POST /search/contacts for a real owned/known check
      // (import the ContactQuery schema from @leadwolf/types).
      return { status: { contactId: null, known: false, owned: false, outcome: "unknown" } };

    case "CAPTURE": {
      await ctx.queue.enqueue(msg.record);
      await ctx.telemetry.event("capture_click", {
        adapterId: msg.record.adapter,
        pageType: msg.record.pageType,
      });
      void scheduler.drain();
      ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
      return { status: { contactId: null, known: true, owned: false, outcome: "saved" } };
    }

    case "REVEAL": {
      await ctx.telemetry.event("reveal_click", { revealType: msg.revealType });
      try {
        const data = await ctx.api.reveal(msg.contactId, msg.revealType, crypto.randomUUID());
        await ctx.telemetry.event("reveal_result", { outcome: "revealed" });
        // The reveal charged credits — update the pill from the server-authoritative post-charge balance.
        ctx.credits.applyReveal(data.balanceAfter);
        ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
        return { ok: true, revealType: msg.revealType, email: data.email, phone: data.phone };
      } catch (error) {
        const errorClass = error instanceof ApiError ? error.errorClass : "unexpected";
        await ctx.telemetry.error(errorClass, {});
        return {
          ok: false,
          revealType: msg.revealType,
          errorClass,
          message: error instanceof Error ? error.message : "error",
        };
      }
    }

    case "AUTH_LOGIN": {
      try {
        const state = await ctx.auth.login();
        ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
        return state;
      } catch {
        return ctx.auth.getState();
      }
    }

    case "AUTH_LOGOUT": {
      const state = await ctx.auth.logout();
      ctx.credits.clear();
      ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
      return state;
    }

    case "SWITCH_WORKSPACE": {
      const state = await ctx.auth.switchWorkspace(msg.workspaceId);
      await ctx.credits.refresh(true); // balance is tenant-scoped — re-pull after a scope change
      ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
      return state;
    }

    case "SWITCH_ORG": {
      const state = await ctx.auth.switchOrg(msg.tenantId);
      await ctx.credits.refresh(true);
      ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
      return state;
    }

    case "LIST_ORGS":
      return ctx.auth.listOrgs();

    case "OPEN_PANEL": {
      try {
        const win = await chrome.windows.getCurrent();
        if (win.id !== undefined) {
          await chrome.sidePanel.open({ windowId: win.id });
        }
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }

    default:
      return { error: "unhandled" };
  }
}
