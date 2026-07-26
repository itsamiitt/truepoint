// useSessionRole.ts — resolves the signed-in user's ACTIVE-workspace role from GET /api/v1/auth/session so a
// surface can show/hide a role-gated action (OD-8 workspace-admin gating). Presentation only + best-effort: a
// failed/late probe leaves role null (the action stays hidden), and the server still enforces requireRole on
// the endpoint, so the gate is never UI-only. Mirrors AppShell's session probe; no TanStack Query in apps/web.
"use client";

import { getSessionProbe } from "@/lib/sessionProbe";
import { useEffect, useState } from "react";

/** Workspace roles that may perform money/admin actions (OD-8 workspace-admin). */
const WORKSPACE_ADMIN_ROLES = new Set(["owner", "admin"]);

/** True when the role is a workspace admin (owner/admin). null/unknown → false (the UI fails closed). */
export function isWorkspaceAdmin(role: string | null): boolean {
  return role != null && WORKSPACE_ADMIN_ROLES.has(role);
}

export function useSessionRole(): string | null {
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Shared, de-duplicated read — see sessionProbe. Previously its own /auth/session request.
      const result = await getSessionProbe();
      if (!alive || !result.ok) return; // best-effort: the action stays hidden; the server is the real gate
      setRole(result.session.role);
    })();
    return () => {
      alive = false;
    };
  }, []);

  return role;
}
