// AppShell.tsx — the app chrome (11 §3) and the single auth gate for every signed-in surface. On mount it
// resolves a token (in-memory access token via a silent refresh against the auth origin, ADR-0016); with no
// token it redirects straight to the auth-origin login via PKCE (no interstitial screen). Signed in, it composes the
// left rail (with the session role) + top bar + the routed {children}, and mounts the Cmd/Ctrl-K command palette
// once. The section title is derived from the active route so each destination labels its own top bar without
// prop-drilling. (This replaces the per-page session logic that used to live in app/page.tsx.)
"use client";

import { fetchWithAuth, getAccessToken, silentRefresh, startLogin } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

interface Session {
  userId: string;
  tenantId: string;
  workspaceId: string | null;
  role: string | null;
  scope: string[];
}

type AuthState = "loading" | "redirecting" | "signed-in";

/** Map a pathname to its top-bar section title (matches the rail destinations). */
function sectionTitle(pathname: string): string {
  if (pathname.startsWith("/prospect")) return "Prospect";
  if (pathname.startsWith("/sequences")) return "Sequences";
  if (pathname.startsWith("/inbox")) return "Inbox";
  if (pathname.startsWith("/reports")) return "Reports";
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/home")) return "Home";
  return "TruePoint";
}

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
        <p className="app-muted">{auth === "redirecting" ? "Redirecting to sign in…" : "Loading…"}</p>
      </div>
    );
  }

  return (
    <div className="tp-shell">
      <Sidebar userEmail={session ? session.userId : null} role={session?.role ?? null} />
      <div className="tp-main">
        <TopBar title={sectionTitle(pathname)} />
        <main className="tp-content">{children}</main>
      </div>
      <CommandPalette />
    </div>
  );
}
