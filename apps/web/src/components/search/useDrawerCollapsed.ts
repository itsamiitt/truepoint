// useDrawerCollapsed.ts — the Search filter drawer's open/closed state, remembered across visits.
//
// Two things deliberately NOT in the URL: this is a presentation preference, not part of the search, so it
// must not ride along when a view is shared (a colleague opening your link should get their own drawer
// preference, not yours). localStorage is the right owner, and losing it is harmless.
//
// SSR SAFETY: the stored value is read in an effect, never during render. Reading localStorage while
// rendering makes the server and client markup disagree and React throws a hydration mismatch. The server
// therefore always renders the OPEN state — the majority case — and a user who prefers collapsed sees one
// frame of the rail before it closes. That is the correct trade: the alternative (rendering collapsed by
// default) shows the wrong thing to most users on every load.
//
// The overlay breakpoint is read with matchMedia rather than a width state, because the design skill's
// responsive rules are CSS-driven and JS only needs the boolean for the behaviours CSS cannot do: closing
// on Escape, and forcing the drawer shut when the viewport crosses into overlay territory.
"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "tp.search.drawer";
/** Must stay in step with the `max-width: 768px` overlay breakpoint in search.module.css + globals.css. */
const OVERLAY_QUERY = "(max-width: 768px)";

export interface DrawerState {
  collapsed: boolean;
  toggle: () => void;
  close: () => void;
  /** True when the viewport renders the rail as an overlay drawer rather than an inline column. */
  isOverlay: boolean;
}

function readStored(): boolean | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "collapsed" ? true : raw === "open" ? false : null;
  } catch {
    // Private mode / storage disabled — the preference simply does not persist. Never a thrown error on a
    // surface whose primary job is unrelated to it.
    return null;
  }
}

export function useDrawerCollapsed(): DrawerState {
  const [collapsed, setCollapsed] = useState(false);
  const [isOverlay, setIsOverlay] = useState(false);

  // Restore the preference + track the breakpoint. One effect, because the two interact: on an overlay
  // viewport the drawer always starts CLOSED regardless of the stored preference — a rail that covers the
  // results on load is a worse first frame than one the user opens deliberately.
  useEffect(() => {
    const mql = window.matchMedia(OVERLAY_QUERY);
    const apply = (overlay: boolean) => {
      setIsOverlay(overlay);
      setCollapsed(overlay ? true : (readStored() ?? false));
    };
    apply(mql.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const persist = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "collapsed" : "open");
    } catch {
      // See readStored — a storage failure costs the preference, never the interaction.
    }
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      // The overlay open/close is a transient gesture, not a preference: persisting it would leave the
      // rail collapsed on desktop just because the user opened and closed it once on a phone.
      if (!isOverlay) persist(next);
      return next;
    });
  }, [isOverlay, persist]);

  const close = useCallback(() => {
    setCollapsed((prev) => {
      if (prev) return prev;
      if (!isOverlay) persist(true);
      return true;
    });
  }, [isOverlay, persist]);

  // Escape closes the overlay drawer. Bound only while it is actually open as an overlay, so the key stays
  // free for the dialogs and drawers layered above it.
  useEffect(() => {
    if (!isOverlay || collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOverlay, collapsed, close]);

  return { collapsed, toggle, close, isOverlay };
}
