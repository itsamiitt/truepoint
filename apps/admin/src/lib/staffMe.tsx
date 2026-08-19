// staffMe.tsx — the caller's staff role + capabilities (13a F3), shared via context so any surface can hide
// actions the operator can't perform. This is defence-in-depth + UX only — the api enforces every capability
// server-side (requireCapability), so a stale/forged client value can never grant access. `loaded` lets
// callers render optimistically (show an action until we know it's denied) to avoid a flash for the common
// authorized case.
//
// The provider no longer fetches: AdminShell's gate already probes `GET /admin/me` to authorize the console
// (adminGate.ts) and seeds this provider from that verdict — the provider's own fetch was the SAME read a
// second time on every load (perf-audit P0.9). While the gate is still verifying, `me` is null and `loaded`
// stays false, which is exactly the optimistic window `canMaybe` was designed for.
"use client";

import type { StaffCapability } from "@leadwolf/types";
import { type ReactNode, createContext, useContext, useMemo } from "react";
import type { StaffMePayload } from "./adminGate";

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

export function StaffMeProvider({
  children,
  me,
}: {
  children: ReactNode;
  /** The gate's `/admin/me` payload; null while the gate is still verifying. */
  me: StaffMePayload | null;
}) {
  const state = useMemo<StaffMeState>(
    () =>
      me
        ? { staffRole: me.staffRole, capabilities: me.capabilities, loaded: true }
        : { staffRole: null, capabilities: [], loaded: false },
    [me],
  );
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
