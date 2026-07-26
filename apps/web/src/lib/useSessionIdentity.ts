// useSessionIdentity.ts — resolves the signed-in user's id + active-workspace role from GET /api/v1/auth/session
// (the same probe useSessionRole reads, which returns { userId, role, … } — this variant keeps the userId so an
// attribution surface can say "You" vs a teammate, 10 §2.1). Presentation only + best-effort: a failed/late probe
// leaves both null (the UI fails closed — no "You" highlight, no elevated toggle). The server still enforces
// requireRole on every endpoint, so this is never a security gate. No TanStack in apps/web's shared lib layer.
"use client";

import { getSessionProbe } from "@/lib/sessionProbe";
import { useEffect, useState } from "react";

export interface SessionIdentity {
  userId: string | null;
  role: string | null;
}

export function useSessionIdentity(): SessionIdentity {
  const [identity, setIdentity] = useState<SessionIdentity>({ userId: null, role: null });

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Shared, de-duplicated read: this used to issue its own /auth/session request, so a page mounting this
      // alongside the shell and the workspace switcher fetched the same endpoint several times over.
      const result = await getSessionProbe();
      if (!alive || !result.ok) return; // best-effort: attribution stays generic on a miss
      setIdentity({ userId: result.session.userId, role: result.session.role });
    })();
    return () => {
      alive = false;
    };
  }, []);

  return identity;
}
