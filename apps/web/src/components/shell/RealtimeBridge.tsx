// RealtimeBridge.tsx — app-wide realtime (reveal-experience Phase 4). Opens the SSE stream and re-broadcasts
// domain events onto the window-event bus the shell + reveal store already listen to: `credits:changed`
// (balance moved → the CreditPill / bulk bar re-read) and `reveal:changed` {contactId} (a reveal committed,
// possibly by a teammate or another tab → the reveal store refreshes that row). Renders nothing. Inert while
// realtime is dark (the stream 404s → the reader stops without reconnecting), so the existing polling/refetch
// remains the source of truth until REALTIME_SSE_ENABLED is flipped.
"use client";

import { connectEventStream } from "@/lib/eventStream";
import {
  EVENT_CREDITS_CHANGED,
  EVENT_REVEAL_COMPLETED,
  EVENT_REVEAL_JOB_COMPLETED,
} from "@leadwolf/types";
import { useEffect } from "react";

export function RealtimeBridge() {
  useEffect(() => {
    const stop = connectEventStream((ev) => {
      if (
        ev.event === EVENT_CREDITS_CHANGED ||
        ev.event === EVENT_REVEAL_COMPLETED ||
        ev.event === EVENT_REVEAL_JOB_COMPLETED
      ) {
        window.dispatchEvent(new Event("credits:changed"));
      }
      if (ev.event === EVENT_REVEAL_COMPLETED) {
        try {
          const parsed = JSON.parse(ev.data) as { payload?: { contactId?: string } };
          const contactId = parsed.payload?.contactId;
          if (contactId) {
            window.dispatchEvent(new CustomEvent("reveal:changed", { detail: { contactId } }));
          }
        } catch {
          /* ignore a malformed frame */
        }
      }
    });
    return stop;
  }, []);
  return null;
}
