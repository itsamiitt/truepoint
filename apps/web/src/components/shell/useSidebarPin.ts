"use client";
// useSidebarPin.ts — desktop sidebar pin state for the collapsible rail. The rail is collapsed (icon-only)
// by default and expands on hover/focus; clicking the top-bar toggle PINS it open persistently. The pin
// choice is persisted to localStorage and hydrated after mount (SSR-safe), mirroring DensityProvider's
// proven pattern. Default is un-pinned so the shell honors "collapsed by default".
import { useEffect, useState } from "react";

const STORAGE_KEY = "tp-sidebar-pinned";

export interface SidebarPinApi {
  pinned: boolean;
  togglePinned: () => void;
}

export function useSidebarPin(): SidebarPinApi {
  const [pinned, setPinned] = useState(false);

  // Hydrate from localStorage after mount (avoids SSR/client mismatch). Default stays collapsed.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setPinned(true);
    } catch {
      // localStorage unavailable (private mode / blocked) — keep the collapsed default.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, pinned ? "1" : "0");
    } catch {
      // Non-fatal: persistence is a convenience, not a requirement.
    }
  }, [pinned]);

  return { pinned, togglePinned: () => setPinned((v) => !v) };
}
