// ForgeShell.tsx — the operator-console chrome and its TWO-STAGE gate for every internal surface (ADR-0011 /
// ADR-0034), the Forge counterpart to apps/admin's AdminShell. Stage 1 (authn): resolve a token via silent
// refresh; with none, redirect to the auth origin via PKCE. Stage 2 (authz): verify the signed-in identity is
// platform staff by probing the forge-api `/bff/*` surface (verifyForgeStaff) — a non-staff caller (403) is
// shown an access-denied panel, NEVER the console. The forge-api is the gate; the client never trusts a self-set
// flag. Manages the mobile sidebar overlay.
"use client";

import { fetchWithAuth, getAccessToken, silentRefresh, startLogin } from "@/lib/authClient";
import { verifyForgeStaff } from "@/lib/forgeGate";
import { API_BASE } from "@/lib/publicConfig";
import { StaffMeProvider } from "@/lib/staffMe";
import { ToastProvider } from "@leadwolf/ui";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { sectionTitleFor } from "./navConfig";

type GateState = "loading" | "redirecting" | "staff" | "forbidden" | "error";

export function ForgeShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [state, setState] = useState<GateState>("loading");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function runGate() {
    try {
      if (!getAccessToken()) await silentRefresh();
      if (!getAccessToken()) {
        setState("redirecting");
        await startLogin();
        return;
      }
      // Authoritative staff check: the forge-api `/bff/*` guard (signed `pa` claim).
      let verdict = await verifyForgeStaff();
      // A 401 here means we DID hold a token but the api rejected it (expired, or an audience/JWKS mismatch).
      // Try ONE silent refresh + re-probe; only restart login if that yields a fresh token. We never re-login on
      // a still-rejected token — that would be a tight redirect loop — so we fall through to the error state.
      if (verdict === "unauthenticated") {
        const refreshed = await silentRefresh();
        if (refreshed) verdict = await verifyForgeStaff();
        if (verdict === "unauthenticated") {
          if (!getAccessToken()) {
            setState("redirecting");
            await startLogin();
            return;
          }
          setState("error");
          return;
        }
      }
      if (verdict === "forbidden") {
        setState("forbidden");
        return;
      }
      if (verdict !== "staff") {
        setState("error");
        return;
      }
      // Best-effort identity for the rail (the gate above already authorized the session).
      try {
        const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session`);
        if (res.ok) {
          const session = (await res.json()) as { userId?: string };
          setUserEmail(session.userId ?? null);
        }
      } catch {
        // Non-fatal: the console still renders without the identity label.
      }
      setState("staff");
    } catch (err: unknown) {
      console.warn(`[forge] gate failed: ${err instanceof Error ? err.message : "unknown"}`);
      setState("error");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run-once gate; Retry re-invokes runGate directly.
  useEffect(() => {
    void runGate();
  }, []);

  // Close the mobile sidebar whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only pathname triggers close.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  if (state === "forbidden") {
    return (
      <div className="tp-center-screen">
        <div className="tp-signin-card">
          <p className="tp-signin-title">Access denied</p>
          <p className="app-muted">
            Your account is signed in but is not a platform staff account. This console is
            restricted to TruePoint staff.
          </p>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="tp-center-screen">
        <div className="tp-signin-card">
          <p className="app-muted">
            We couldn't reach the Forge API. Check your connection and try again.
          </p>
          <button
            className="app-button"
            type="button"
            onClick={() => {
              setState("loading");
              void runGate();
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (state !== "staff") {
    return (
      <div className="tp-center-screen">
        <p className="app-muted">
          {state === "redirecting" ? "Redirecting to sign in…" : "Checking access…"}
        </p>
      </div>
    );
  }

  return (
    <ToastProvider>
      <StaffMeProvider>
        <div className="tp-shell" data-density="comfortable">
          {sidebarOpen && (
            <button
              type="button"
              className="tp-sidebar-scrim"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
            />
          )}
          <Sidebar
            userEmail={userEmail}
            isOpen={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
          />
          <div className="tp-main">
            <TopBar
              title={sectionTitleFor(pathname)}
              onMenuToggle={() => setSidebarOpen((v) => !v)}
            />
            <main className="tp-content">{children}</main>
          </div>
        </div>
      </StaffMeProvider>
    </ToastProvider>
  );
}
