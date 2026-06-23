// ImpersonationBanner.tsx — a persistent, high-visibility banner shown while a staff impersonation session
// is active (ADR-0011, 13 §11). It polls GET /admin/impersonation/active (the api is the source of truth for
// what's live — never a client-held flag) and, when a session exists, renders a fixed danger banner naming
// the target tenant with an "End" action that calls DELETE /admin/impersonation/:id. When nothing is active
// it renders null (no chrome). The lead mounts this once inside AdminShell so it overlays every console
// surface. Self-contained on the shared fetch seam (fetchWithAuth + API_BASE).
//
// NOTE: the actual "login-as" token mint is WIRE-deferred on the api, so today this banner is the visible
// consent/justification indicator for an OPEN session record — it does not by itself mean the staff member's
// requests are running as the target. It still gives staff a one-click "End" and an always-on reminder.
"use client";

import { fetchWithAuth } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { TpButton } from "@leadwolf/ui";
import { ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface ActiveSession {
  id: string;
  targetTenantId: string;
  targetUserId: string | null;
  reason: string;
  expiresAt: string;
}

const POLL_MS = 30_000; // re-check ~every 30s so an expired/ended session clears without a reload.

export function ImpersonationBanner() {
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [ending, setEnding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/impersonation/active`);
      if (!res.ok) {
        // A 403 (not super_admin/support) or any error simply means "no banner" — never block the console.
        setSession(null);
        return;
      }
      const body = (await res.json()) as { sessions: ActiveSession[] };
      setSession(body.sessions[0] ?? null);
    } catch {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function onEnd() {
    if (!session) return;
    setEnding(true);
    try {
      await fetchWithAuth(
        `${API_BASE}/api/v1/admin/impersonation/${encodeURIComponent(session.id)}`,
        {
          method: "DELETE",
        },
      );
    } catch {
      // Best-effort: a failed end leaves the banner; the next poll re-evaluates.
    } finally {
      setEnding(false);
      await refresh();
    }
  }

  if (!session) return null;

  return (
    <output
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 16px",
        background: "var(--danger-700, var(--danger, #b91c1c))",
        color: "#fff",
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      <ShieldAlert size={16} aria-hidden />
      <span>
        Impersonating tenant{" "}
        <code style={{ fontFamily: "var(--tp-font-mono, monospace)" }}>
          {session.targetTenantId}
        </code>
        {session.targetUserId ? (
          <>
            {" "}
            · user{" "}
            <code style={{ fontFamily: "var(--tp-font-mono, monospace)" }}>
              {session.targetUserId}
            </code>
          </>
        ) : null}{" "}
        · {session.reason}
      </span>
      <TpButton
        variant="secondary"
        size="sm"
        onClick={() => void onEnd()}
        disabled={ending}
        style={{ marginLeft: "auto" }}
      >
        {ending ? "Ending…" : "End"}
      </TpButton>
    </output>
  );
}
