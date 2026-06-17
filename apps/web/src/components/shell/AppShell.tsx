// AppShell.tsx — the app chrome (11 §3) and the single auth gate for every signed-in surface. On mount it
// resolves a token (in-memory access token via a silent refresh against the auth origin, ADR-0016); with no
// token it redirects straight to the auth-origin login via PKCE (no interstitial). Signed in, it composes the
// left rail + top bar + the routed {children}, and mounts the command palette, shortcuts help, the toast host,
// and the density provider once. The section title is derived from the active route via the central navConfig.
"use client";

import { fetchWithAuth, getAccessToken, silentRefresh, startLogin } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { ToastProvider } from "@leadwolf/ui";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { DensityProvider } from "./DensityProvider";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { sectionTitleFor } from "./navConfig";

interface Session {
  userId: string;
  tenantId: string;
  workspaceId: string | null;
  role: string | null;
  scope: string[];
}

type AuthState = "loading" | "redirecting" | "signed-in";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [auth, setAuth] = useState<AuthState>("loading");
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    void (async () => {
      if (!getAccessToken()) await silentRefresh();
      if (!getAccessToken()) {
        setAuth("redirecting");
        await startLogin(); // no interstitial — PKCE redirect straight to the auth-origin login
        return;
      }
      const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session`);
      if (res.ok) setSession((await res.json()) as Session);
      setAuth("signed-in");
    })();
  }, []);

  // Until the session resolves, render a neutral placeholder. Signed-out users are redirected to the
  // auth-origin login by the effect above (no interstitial), so "redirecting" only shows briefly.
  if (auth !== "signed-in") {
    return (
      <div className="tp-center-screen">
        <p className="app-muted">
          {auth === "redirecting" ? "Redirecting to sign in…" : "Loading…"}
        </p>
      </div>
    );
  }

  return (
    <ToastProvider>
      <DensityProvider>
        <div className="tp-shell">
          <Sidebar userEmail={session ? session.userId : null} role={session?.role ?? null} />
          <div className="tp-main">
            <TopBar title={sectionTitleFor(pathname)} />
            <main className="tp-content">{children}</main>
          </div>
          <CommandPalette />
          <ShortcutsDialog />
        </div>
      </DensityProvider>
    </ToastProvider>
  );
}
