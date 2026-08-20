// MessageBus (SW side) — validates every inbound message with Zod, routes to a handler, and returns a
// typed response (03 §1.8). Unknown/invalid messages are dropped. Returns `true` to keep the channel
// open for the async response.
import { type RequestMessage, requestMessage } from "../../shared/messages.ts";
import { ApiError } from "../api/client.ts";
import type { RuntimeContext } from "../context.ts";
import { lookupCache, lookupSubject } from "../lookup/resolver.ts";
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

    case "LOOKUP": {
      // The one-round-trip DB-first / vendor-fallback lookup (extension-intelligence-loop slice C): the
      // server canonicalizes the page URL (public AND Sales-Nav forms), answers from the workspace when it
      // can, and otherwise pulls the licensed document so a Save lands enriched.
      //
      // Wrapped in the warm cache so the nav + settle pair the observer fires for one profile — and a bounce
      // back to a just-seen profile — coalesce to a single request. The broadcast still fires on a cached hit
      // (a freshly-mounted panel/hover card needs the status regardless of who paid for it). Total failure
      // degrades to "unknown" and is NOT cached, so an offline blip never sticks.
      try {
        const status = await lookupSubject(ctx, msg.subjectKey, msg.sourceUrl);
        ctx.broadcast({ type: "SUBJECT_STATUS", subjectKey: msg.subjectKey, status });
        return { status };
      } catch {
        return { status: { contactId: null, known: false, owned: false, outcome: "unknown" } };
      }
    }

    case "CAPTURE": {
      await ctx.queue.enqueue(msg.record);
      // The subject's status will change once the capture lands; drop its warm entry so the next LOOKUP
      // re-resolves rather than serving the pre-capture status.
      lookupCache.invalidate(msg.record.subjectKey);
      await ctx.telemetry.event("capture_click", {
        adapterId: msg.record.adapter,
        pageType: msg.record.pageType,
      });
      void scheduler.drain();
      ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
      // QUEUED, not saved. The drain above is fire-and-forget: at this point the record is only in the local
      // IndexedDB queue, the POST has not been attempted, and it may still fail or back off. Reporting "saved"
      // (and `known: true`, asserting the server has a contact) told the user the capture had landed before a
      // single byte left the browser. The real outcome arrives later via the SUBJECT_STATUS broadcast the
      // scheduler emits once /ingest answers.
      return { status: { contactId: null, known: false, owned: false, outcome: "queued" } };
    }

    case "ADD_FROM_DATABASE": {
      // Materialize a database person into the workspace (Layer-0-as-database slice 4). Server-side verb;
      // degrade to "rejected" on any failure so the card shows the truth.
      try {
        const status = await ctx.api.addFromDatabase(msg.url, crypto.randomUUID());
        // The person is now a workspace contact — a later LOOKUP must return "found", not "in_database". We
        // don't hold the subjectKey here (only the URL), so clear the whole warm cache; it's a rare click.
        lookupCache.clear();
        await ctx.telemetry.event("database_add", {});
        ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
        return { status };
      } catch {
        return { status: { contactId: null, known: false, owned: false, outcome: "rejected" } };
      }
    }

    case "REVEAL": {
      await ctx.telemetry.event("reveal_click", { revealType: msg.revealType });
      try {
        const data = await ctx.api.reveal(msg.contactId, msg.revealType, crypto.randomUUID());
        // Distinguish a reveal that EXPOSED something from one that found the record empty (S-12). Reported
        // separately because "we hold nothing for this person" is the demand signal, and counting it as a
        // successful reveal is what made reveal-hit rate unmeasurable in the first place.
        await ctx.telemetry.event("reveal_result", {
          outcome: data.nothingToReveal ? "nothing_to_reveal" : "revealed",
        });
        // The reveal charged credits — update the pill from the server-authoritative post-charge balance.
        ctx.credits.applyReveal(data.balanceAfter);
        // Reveal changes owned/availability for this contact; the LOOKUP is keyed by subjectKey and we hold
        // only the contactId here, so clear the warm cache rather than guess the mapping.
        lookupCache.clear();
        ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
        return {
          ok: true,
          revealType: msg.revealType,
          email: data.email,
          phone: data.phone,
          verification: data.verification,
          nothingToReveal: data.nothingToReveal,
        };
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

    case "LINKS_CAPTURED": {
      // Sales-Nav URL harvest (docs/planning ecosystem): URLs only, posted to the fetch registry. Degrade
      // to zero on any failure so a signed-out/offline session never blocks browsing.
      try {
        const res = await ctx.api.captureLinks(msg.links, msg.sourceUrl);
        await ctx.telemetry.event("links_captured", { count: msg.links.length });
        return res;
      } catch {
        return { registered: 0, dropped: msg.links.length };
      }
    }

    case "VIEW_FETCH": {
      // Fetch-on-view: ensure the viewed profile/company is fresh, then hand back the resolved contact id.
      try {
        return await ctx.api.viewFetch(msg.entityKind, msg.url);
      } catch {
        return { outcome: "unavailable", contactId: null };
      }
    }

    case "AUTH_LOGIN": {
      try {
        const state = await ctx.auth.login();
        // Signing in establishes the scope every lookup answer is relative to — start from an empty cache.
        lookupCache.clear();
        ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
        return state;
      } catch {
        return ctx.auth.getState();
      }
    }

    case "AUTH_LOGOUT": {
      const state = await ctx.auth.logout();
      ctx.credits.clear();
      // Never serve one session's workspace-scoped lookups to the next.
      lookupCache.clear();
      ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
      return state;
    }

    case "SWITCH_WORKSPACE": {
      const state = await ctx.auth.switchWorkspace(msg.workspaceId);
      await ctx.credits.refresh(true); // balance is tenant-scoped — re-pull after a scope change
      // Lookup answers are workspace-scoped (found/in_database differ per workspace) — drop them on switch.
      lookupCache.clear();
      ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
      return state;
    }

    case "SWITCH_ORG": {
      const state = await ctx.auth.switchOrg(msg.tenantId);
      await ctx.credits.refresh(true);
      lookupCache.clear();
      ctx.broadcast({ type: "STATE_CHANGED", state: await ctx.getState() });
      return state;
    }

    case "LIST_ORGS":
      // The orgs list is a tenant-membership read on /api/v1 — route it through the SW API client (the one
      // HTTP client), not the auth module. The endpoint returns { orgs, activeTenantId } (chrome-extension/14 X04).
      return ctx.api.listOrgs();

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
