// AppShell.tsx — the app chrome (11 §3) and the single auth gate for every signed-in surface. On mount it
// resolves a token (in-memory access token via a silent refresh against the auth origin, ADR-0016); with no
// token it redirects straight to the auth-origin login via PKCE (no interstitial). Signed in, it composes the
// left rail + top bar + the routed {children}, and mounts the command palette, shortcuts help, the toast host,
// and the density provider once. The section title is derived from the active route via the central navConfig.
// The gate runs in a try/catch: startLogin() can throw (crypto.subtle is undefined on insecure origins;
// sessionStorage can be blocked) and the session fetch can throw on a network/CORS error — either way, and on a
// non-ok session response, we surface an "error" state with a Retry button instead of hanging on a spinner
// (mirrors auth/callback/page.tsx).
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

type AuthState = "loading" | "redirecting" | "signed-in" | "error";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [auth, setAuth] = useState<AuthState>("loading");
  const [session, setSession] = useState<Session | null>(null);

  // The single auth gate. Wrapped in try/catch so a throwing startLogin() (insecure-origin crypto, blocked
  // sessionStorage) or a failed session fetch (network/CORS) lands on "error" instead of hanging forever. Only a
  // successful res.ok + parsed session reaches "signed-in" — a non-ok response is an error, not a half-signed-in state.
  // Extracted as a named function so the Retry button can re-run it. silentRefresh() catches internally (returns false).
  async function runGate() {
    try {
      if (!getAccessToken()) await silentRefresh();
      if (!getAccessToken()) {
        setAuth("redirecting");
        await startLogin(); // no interstitial — PKCE redirect straight to the auth-origin login
        return;
      }
      const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session`);
      if (!res.ok) {
        setAuth("error");
        return;
      }
      setSession((await res.json()) as Session);
      setAuth("signed-in");
    } catch (err: unknown) {
      console.warn(`[auth] gate failed: ${err instanceof Error ? err.message : "unknown"}`);
      setAuth("error");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run-once gate; Retry re-invokes runGate directly.
  useEffect(() => {
    void runGate();
  }, []);

  // The gate failed (unreachable sign-in / network error / non-ok session). Offer a clear message and a Retry that
  // resets to "loading" and re-runs the gate, rather than dead-ending on a spinner.
  if (auth === "error") {
    return (
      <div className="tp-center-screen">
        <div className="tp-signin-card">
          <p className="app-muted">
            We couldn't reach sign-in. Check your connection and try again.
          </p>
          <button
            className="app-button"
            type="button"
            onClick={() => {
              setAuth("loading");
              void runGate();
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

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
