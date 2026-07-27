// staffMe.tsx — the caller's staff role, capabilities and identity (email), fetched once from the forge-api
// `/bff/me` read and shared via context so any surface can hide actions the operator can't perform. This is
// defence-in-depth + UX only — the forge-api enforces every capability server-side, so a stale/forged client
// value can never grant access. `loaded` lets callers render optimistically (show an action until we know it's denied) to avoid a
// flash for the common authorized case.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import type { StaffMePayload } from "@/lib/forgeGate";
import { API_BASE } from "@/lib/publicConfig";
import type { StaffCapability } from "@leadwolf/types";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";

interface StaffMeState {
  staffRole: string | null;
  capabilities: StaffCapability[];
  email: string | null;
  loaded: boolean;
}

const StaffMeContext = createContext<StaffMeState>({
  staffRole: null,
  capabilities: [],
  email: null,
  loaded: false,
});

/** `initial` is the payload the shell.s gate probe already fetched from `/bff/me` (T-2.5). When present the
 *  provider adopts it and performs NO request: the gate and this provider were both reading the same endpoint
 *  on every cold load, so one of the two round-trips — and one uncached `platform_staff` lookup — was pure
 *  duplication. It stays optional so any other mount point still works standalone. */
export function StaffMeProvider({
  children,
  initial = null,
}: { children: ReactNode; initial?: StaffMePayload | null }) {
  const [state, setState] = useState<StaffMeState>(() =>
    initial
      ? { ...initial, loaded: true }
      : { staffRole: null, capabilities: [], email: null, loaded: false },
  );

  useEffect(() => {
    // Seeded by the gate — nothing to fetch. Adopt any later seed too (the gate resolves after first paint).
    if (initial) {
      setState({ ...initial, loaded: true });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/bff/me`);
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as {
            staffRole: string | null;
            capabilities: StaffCapability[];
            email?: string | null;
          };
          setState({
            staffRole: data.staffRole ?? null,
            capabilities: data.capabilities ?? [],
            email: data.email ?? null,
            loaded: true,
          });
        } else {
          setState((s) => ({ ...s, loaded: true }));
        }
      } catch {
        // Non-fatal: the forge-api still enforces every capability; treat as "loaded, no extra info".
        if (!cancelled) setState((s) => ({ ...s, loaded: true }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initial]);

  return <StaffMeContext.Provider value={state}>{children}</StaffMeContext.Provider>;
}

export function useStaffMe() {
  const me = useContext(StaffMeContext);
  return {
    staffRole: me.staffRole,
    capabilities: me.capabilities,
    email: me.email,
    loaded: me.loaded,
    /** Strict: true only once we've confirmed the capability. */
    has: (cap: StaffCapability) => me.capabilities.includes(cap),
    /** Optimistic: true until we've loaded and confirmed it's NOT granted (avoids an action flashing out). */
    canMaybe: (cap: StaffCapability) => !me.loaded || me.capabilities.includes(cap),
  };
}
