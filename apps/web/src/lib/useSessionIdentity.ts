// useSessionIdentity.ts — resolves the signed-in user's id + active-workspace role from GET /api/v1/auth/session
// (the same probe useSessionRole reads, which returns { userId, role, … } — this variant keeps the userId so an
// attribution surface can say "You" vs a teammate, 10 §2.1). Presentation only + best-effort: a failed/late probe
// leaves both null (the UI fails closed — no "You" highlight, no elevated toggle). The server still enforces
// requireRole on every endpoint, so this is never a security gate. No TanStack in apps/web's shared lib layer.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
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
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session`);
        if (!alive || !res.ok) return;
        const body = (await res.json()) as { userId?: string | null; role?: string | null };
        setIdentity({ userId: body.userId ?? null, role: body.role ?? null });
      } catch {
        // best-effort: attribution stays generic; the server enforces the real gate
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return identity;
}
