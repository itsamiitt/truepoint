// RealtimeBridge.tsx — app-wide realtime (reveal-experience Phase 4). Opens the SSE stream and re-broadcasts
// domain events into the query cache and onto the window bus: a balance move INVALIDATES the shared credit
// and notification keys (so the CreditPill and bulk bar re-read from one request), and `reveal:changed`
// {contactId} still goes out as a window event for the reveal store, which tracks per-row client state
// rather than a server read. Renders nothing. Inert while
// realtime is dark (the stream 404s → the reader stops without reconnecting), so the existing polling/refetch
// remains the source of truth until REALTIME_SSE_ENABLED is flipped.
"use client";

import { invalidateCreditSignals } from "@/lib/credits";
import { connectEventStream } from "@/lib/eventStream";
import {
  EVENT_CREDITS_CHANGED,
  EVENT_REVEAL_COMPLETED,
  EVENT_REVEAL_JOB_COMPLETED,
} from "@leadwolf/types";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function RealtimeBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    const stop = connectEventStream((ev) => {
      if (
        ev.event === EVENT_CREDITS_CHANGED ||
        ev.event === EVENT_REVEAL_COMPLETED ||
        ev.event === EVENT_REVEAL_JOB_COMPLETED
      ) {
        invalidateCreditSignals(qc);
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
  }, [qc]);
  return null;
}
