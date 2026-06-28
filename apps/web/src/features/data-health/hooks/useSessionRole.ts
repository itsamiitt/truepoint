// useSessionRole.ts — resolves the signed-in user's ACTIVE-workspace role from GET /api/v1/auth/session, so a
// surface can show/hide a role-gated action (here: the owner/admin-only "Re-verify now" trigger). Presentation
// only + best-effort: a failed/late probe leaves role null (the action stays hidden), and the server still
// enforces requireRole on the endpoint, so the gate is never UI-only. Mirrors AppShell's session probe; no
// TanStack Query in apps/web.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { useEffect, useState } from "react";

export function useSessionRole(): string | null {
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session`);
        if (!alive || !res.ok) return;
        const body = (await res.json()) as { role: string | null };
        setRole(body.role ?? null);
      } catch {
        // best-effort: the action stays hidden; the server enforces the real gate
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return role;
}
