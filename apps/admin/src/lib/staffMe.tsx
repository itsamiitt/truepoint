// staffMe.tsx — the caller's staff role + capabilities (13a F3), fetched once from `/admin/me` and shared via
// context so any surface can hide actions the operator can't perform. This is defence-in-depth + UX only — the
// api enforces every capability server-side (requireCapability), so a stale/forged client value can never grant
// access. `loaded` lets callers render optimistically (show an action until we know it's denied) to avoid a
// flash for the common authorized case.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import type { StaffCapability } from "@leadwolf/types";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

interface StaffMeState {
  staffRole: string | null;
  capabilities: StaffCapability[];
  loaded: boolean;
}

const StaffMeContext = createContext<StaffMeState>({
  staffRole: null,
  capabilities: [],
  loaded: false,
});

export function StaffMeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StaffMeState>({
    staffRole: null,
    capabilities: [],
    loaded: false,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/me`);
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as {
            staffRole: string | null;
            capabilities: StaffCapability[];
          };
          setState({
            staffRole: data.staffRole ?? null,
            capabilities: data.capabilities ?? [],
            loaded: true,
          });
        } else {
          setState((s) => ({ ...s, loaded: true }));
        }
      } catch {
        // Non-fatal: the api still enforces every capability; treat as "loaded, no extra info".
        if (!cancelled) setState((s) => ({ ...s, loaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return <StaffMeContext.Provider value={state}>{children}</StaffMeContext.Provider>;
}

export function useStaffMe() {
  const me = useContext(StaffMeContext);
  return {
    staffRole: me.staffRole,
    capabilities: me.capabilities,
    loaded: me.loaded,
    /** Strict: true only once we've confirmed the capability. */
    has: (cap: StaffCapability) => me.capabilities.includes(cap),
    /** Optimistic: true until we've loaded and confirmed it's NOT granted (avoids an action flashing out). */
    canMaybe: (cap: StaffCapability) => !me.loaded || me.capabilities.includes(cap),
  };
}
