// AppShell.tsx — the app chrome (11 §3) and the single auth gate for every signed-in surface. On mount it
// resolves a token (in-memory access token via a silent refresh against the auth origin, ADR-0016); with no
// token it renders a centered "Sign in" screen that starts the PKCE redirect. Signed in, it composes the
// left rail + top bar + the routed {children}. The section title is derived from the active route so each
// destination labels its own top bar without prop-drilling. (This replaces the per-page session logic that
// used to live in app/page.tsx.)
"use client";

import { fetchWithAuth, getAccessToken, silentRefresh, startLogin } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

interface Session {
  userId: string;
  tenantId: string;
  workspaceId: string | null;
  scope: string[];
}

type AuthState = "loading" | "signed-out" | "signed-in";

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
        setAuth("signed-out");
        return;
      }
      const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session`);
      if (res.ok) setSession((await res.json()) as Session);
      setAuth("signed-in");
    })();
  }, []);

  if (auth === "loading") {
    return (
      <div className="tp-center-screen">
        <p className="app-muted">Loading…</p>
      </div>
    );
  }

  if (auth === "signed-out") {
    return (
      <div className="tp-center-screen">
        <div className="tp-signin-card">
          <span className="tp-brand-mark tp-brand-mark--lg" aria-hidden="true" />
          <h1 className="tp-signin-title">TruePoint</h1>
          <p className="app-muted">Sign in to continue to your workspace.</p>
          <button className="app-button" type="button" onClick={() => void startLogin()}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="tp-shell">
      <Sidebar userEmail={session ? session.userId : null} />
      <div className="tp-main">
        <TopBar title={sectionTitle(pathname)} />
        <main className="tp-content">{children}</main>
      </div>
    </div>
  );
}
