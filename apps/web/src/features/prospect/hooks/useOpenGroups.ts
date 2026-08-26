// useOpenGroups.ts — which filter accordions are open, remembered across visits (decisions.md 2026-08-25).
//
// Presentation preference, not search state: it never rides in the URL (a colleague opening your link gets
// their own layout), so localStorage owns it — the same posture as the drawer's collapsed state. Read in an
// effect, never during render (SSR: server and client markup must agree; the first paint is the defaults).
// Losing it is harmless.
"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "tp.search.groups";

type OpenMap = Record<string, boolean>;

function readStored(): OpenMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as OpenMap) : {};
  } catch {
    // Private mode / storage disabled / a corrupt value — the preference simply does not persist.
    return {};
  }
}

export function useOpenGroups(defaults: OpenMap = {}) {
  const [open, setOpen] = useState<OpenMap>(defaults);

  useEffect(() => {
    setOpen((prev) => ({ ...prev, ...readStored() }));
  }, []);

  const isOpen = useCallback((id: string) => open[id] ?? false, [open]);

  const toggle = useCallback((id: string) => {
    setOpen((prev) => {
      const next = { ...prev, [id]: !(prev[id] ?? false) };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // See readStored — a storage failure costs the preference, never the interaction.
      }
      return next;
    });
  }, []);

  return { isOpen, toggle };
}
