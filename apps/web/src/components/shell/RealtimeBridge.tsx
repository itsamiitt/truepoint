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
import { sharedKeys } from "@/lib/queryKeys";
import {
  EVENT_CREDITS_CHANGED,
  EVENT_NOTIFICATION_CREATED,
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
      // A notification landed for someone in this workspace (perf-audit P3.8a) — re-read the bell's feed.
      // The event is workspace-scoped, so occasionally another user's notification triggers a refetch of
      // one's own (correct, cheap); this is what lets the 60s poll drop to a 5-minute backstop.
      if (ev.event === EVENT_NOTIFICATION_CREATED) {
        void qc.invalidateQueries({ queryKey: sharedKeys.notifications() });
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
