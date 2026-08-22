// useIntel.ts — the panel's two hooks: what is on screen, and what we know about it.
//
// HYDRATE ON OPEN, THEN FOLLOW. The old Reveal tab was purely push-driven: it listened for SUBJECT_STATUS and
// showed an empty state until the user navigated, so opening the panel on a profile they were already reading
// showed nothing. `usePanelSubject` asks the service worker instead (GET_SUBJECT reads the active tab's URL),
// and then follows SUBJECT_VIEWED broadcasts plus tab activation for the rest of the session.
//
// Every fetch is a message; the panel holds no token and makes no HTTP call (architecture rule 1).
import { useCallback, useEffect, useState } from "react";
import type { ViewedSubject } from "../../shared/linkedinUrl.ts";
import { onBroadcast, send } from "../../shared/client.ts";
import type { ErrorClass } from "../../shared/types.ts";
import type { IntelPayload } from "../../shared/messages.ts";

/** Which subject the panel is showing, or null when the active tab is not a profile/company page. */
export function usePanelSubject(): ViewedSubject | null {
  const [subject, setSubject] = useState<ViewedSubject | null>(null);

  useEffect(() => {
    let live = true;
    const ask = (): void => {
      void send({ type: "GET_SUBJECT" }).then((r) => {
        if (live) setSubject(r.subject);
      });
    };
    ask();

    // The content script's VIEW_FETCH is rebroadcast as SUBJECT_VIEWED for both page kinds, so an in-page
    // navigation moves the panel without polling.
    const off = onBroadcast((msg) => {
      if (msg.type === "SUBJECT_VIEWED") setSubject(msg.subject);
    });

    // Switching browser tabs fires no content-script event at all — the panel is shared across tabs, so it
    // must re-ask. Guarded because `chrome.tabs` events are unavailable in a plain page context (tests).
    const onTab = (): void => ask();
    chrome.tabs?.onActivated?.addListener(onTab);
    chrome.tabs?.onUpdated?.addListener(onTab);
    return () => {
      live = false;
      off();
      chrome.tabs?.onActivated?.removeListener(onTab);
      chrome.tabs?.onUpdated?.removeListener(onTab);
    };
  }, []);

  return subject;
}

export type IntelState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; payload: IntelPayload }
  | { phase: "error"; errorClass: ErrorClass };

export interface UseIntel {
  state: IntelState;
  /** Re-read from the server, dropping the warm cache (the header's ↻). */
  recapture: () => void;
  /** Re-read WITHOUT the vendor refresh — used after our own mutations (save, reveal, add-to-list). */
  refresh: () => void;
}

/**
 * Everything the panel renders for `subject`, with the four states wired.
 *
 * A `silent` refetch keeps the last good payload on screen rather than flashing a skeleton: after a Save the
 * card should change in place, not blink. Only the first load for a subject shows the loading state.
 */
export function useIntel(subject: ViewedSubject | null): UseIntel {
  const [state, setState] = useState<IntelState>({ phase: "idle" });

  const read = useCallback(
    (target: ViewedSubject | null, opts: { force?: boolean; silent?: boolean } = {}) => {
      if (!target) {
        setState({ phase: "idle" });
        return;
      }
      if (!opts.silent) setState({ phase: "loading" });
      void send({
        type: "INTEL",
        subjectKey: target.subjectKey,
        sourceUrl: target.sourceUrl,
        force: opts.force,
      }).then((r) => {
        if (r.ok) {
          setState({ phase: "ready", payload: r.payload });
        } else if (!opts.silent) {
          // A silent refetch that fails leaves the good payload up: the user asked for a save, not a reload,
          // and replacing their card with an error would lose the thing they were reading.
          setState({ phase: "error", errorClass: r.errorClass });
        }
      });
    },
    [],
  );

  useEffect(() => {
    read(subject);
  }, [subject, read]);

  return {
    state,
    recapture: () => read(subject, { force: true }),
    refresh: () => read(subject, { silent: true }),
  };
}
