// AppShell.tsx — the app chrome and the single auth gate for every signed-in surface. Resolves a token via
// silent refresh; with no token it redirects to the auth-origin login via PKCE. Manages mobile sidebar state
// (sidebarOpen), closes the rail on route change, and passes toggle/close callbacks to TopBar and Sidebar.
"use client";

import { fetchWithAuth, getAccessToken, silentRefresh, startLogin } from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { ToastProvider } from "@leadwolf/ui";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { CommandPalette } from "./CommandPalette";
import { DensityProvider } from "./DensityProvider";
import { Brandmark, Logo } from "./Logo";
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
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function runGate() {
    try {
      if (!getAccessToken()) await silentRefresh();
      if (!getAccessToken()) {
        setAuth("redirecting");
        await startLogin();
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

  // Close the mobile sidebar whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only pathname triggers close.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  if (auth === "error") {
    return (
      <div className="tp-center-screen">
        <div className="tp-signin-card">
          <Logo markSize={30} wordSize={22} />
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

  if (auth !== "signed-in") {
    return (
      <div className="tp-center-screen">
        <div className="tp-boot">
          <Brandmark size={34} title="TruePoint" />
          <p className="app-muted">
            {auth === "redirecting" ? "Redirecting to sign in…" : "Loading…"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <DensityProvider>
        <div className="tp-shell">
          {/* Mobile scrim — tap anywhere outside sidebar to close */}
          {sidebarOpen && (
            <div
              className="tp-sidebar-scrim"
              onClick={() => setSidebarOpen(false)}
              aria-hidden="true"
            />
          )}
          <Sidebar
            userEmail={session ? session.userId : null}
            role={session?.role ?? null}
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
          <CommandPalette />
          <ShortcutsDialog />
        </div>
      </DensityProvider>
    </ToastProvider>
  );
}
