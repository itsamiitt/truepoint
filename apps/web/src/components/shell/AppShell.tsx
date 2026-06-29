// AppShell.tsx — the app chrome and the single auth gate for every signed-in surface. It authenticates with
// the smallest possible block: as soon as a token exists (from the just-completed login, or a silent refresh)
// it renders the chrome + children so the route's own data fetch can start, and resolves the session profile
// (sidebar email/role) in the BACKGROUND rather than holding the whole tree behind a full-screen "Loading…".
// With no token at all it redirects to the auth-origin login via PKCE. Manages mobile sidebar state
// (sidebarOpen), closes the rail on route change, and passes toggle/close callbacks to TopBar and Sidebar.
"use client";

import { AnnouncementBanner } from "@/features/announcements/AnnouncementBanner";
import {
  clearAccessToken,
  fetchWithAuth,
  getAccessToken,
  silentRefresh,
  startLogin,
} from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import { ToastProvider, TpButton } from "@leadwolf/ui";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { DensityProvider } from "./DensityProvider";
import { Brandmark, Logo } from "./Logo";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { sectionTitleFor } from "./navConfig";
import { useSidebarPin } from "./useSidebarPin";

// Interaction-only widgets: nothing on first paint needs them (they wake on a keypress / ⌘K). Loading them
// dynamically with ssr:false keeps cmdk and the dialog markup out of the synchronous first-paint bundle.
const CommandPalette = dynamic(() => import("./CommandPalette").then((m) => m.CommandPalette), {
  ssr: false,
});
const ShortcutsDialog = dynamic(() => import("./ShortcutsDialog").then((m) => m.ShortcutsDialog), {
  ssr: false,
});

interface Session {
  userId: string;
  tenantId: string;
  workspaceId: string | null;
  role: string | null;
  scope: string[];
}

// "authenticating" — no token yet, resolving one (cold load → silent refresh). "redirecting" — no session at
// all, bouncing to login. "ready" — a token exists; render the app (the session profile may still be loading
// in the background). "error" — we couldn't reach sign-in.
type AuthState = "authenticating" | "redirecting" | "ready" | "error";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [auth, setAuth] = useState<AuthState>("authenticating");
  const [session, setSession] = useState<Session | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { pinned, togglePinned } = useSidebarPin();

  // `live` lets a background probe that resolves after the shell unmounts skip its setState (the probe now
  // runs after first paint, so the component can be gone by the time it returns). Reset on each runGate.
  async function runGate(live: () => boolean = () => true) {
    try {
      // 1. Establish a token. If one was just minted by the login callback (in-memory, ADR-0016) this is free;
      //    on a cold load with only the refresh cookie, one silent refresh mints it. silentRefresh de-dups
      //    in-flight, so the route's first fetchWithAuth (firing as soon as we render) shares this round-trip.
      if (!getAccessToken()) await silentRefresh();
      if (!getAccessToken()) {
        if (live()) setAuth("redirecting");
        await startLogin();
        return;
      }
      // 2. We have a token — unblock the tree NOW so the route's primary data fetch runs concurrently with the
      //    session probe below (instead of after a serial refresh→/session chain).
      if (live()) setAuth("ready");
      // 3. Resolve the session profile in the background to fill the sidebar (email/role).
      const res = await fetchWithAuth(`${API_BASE}/api/v1/auth/session`);
      if (!live()) return;
      if (res.ok) {
        setSession((await res.json()) as Session);
        return;
      }
      // A 401/403 means the SERVER rejected the token even though it passed the client-side expiry check
      // (revoked session, kicked user). The client can't refresh past a revocation, so discard the in-memory
      // token and re-gate to a fresh login — otherwise the user would sit on a shell where every fetch 401s.
      if (res.status === 401 || res.status === 403) {
        clearAccessToken();
        setAuth("redirecting");
        await startLogin();
        return;
      }
      // Any other status (5xx, transient) is NOT an auth failure: the token is still valid, so keep the app
      // rendered and simply lack the sidebar identity until the next load.
    } catch (err: unknown) {
      console.warn(`[auth] gate failed: ${err instanceof Error ? err.message : "unknown"}`);
      // Only surface the blocking error screen if we never got a token; if we did, the app is already usable.
      if (live() && !getAccessToken()) setAuth("error");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run-once gate; Retry re-invokes runGate directly.
  useEffect(() => {
    let alive = true;
    void runGate(() => alive);
    return () => {
      alive = false;
    };
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
          <TpButton
            variant="primary"
            onClick={() => {
              setAuth("authenticating");
              void runGate();
            }}
          >
            Retry
          </TpButton>
        </div>
      </div>
    );
  }

  if (auth !== "ready") {
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
        <div className={`tp-shell${pinned ? " is-pinned" : ""}`}>
          {/* Mobile scrim — tap anywhere outside sidebar to close */}
          {sidebarOpen && (
            <button
              type="button"
              className="tp-sidebar-scrim"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
              style={{ border: "none", padding: 0, appearance: "none", cursor: "pointer" }}
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
              pinned={pinned}
              onTogglePin={togglePinned}
            />
            <AnnouncementBanner />
            <main className="tp-content">{children}</main>
          </div>
          <CommandPalette />
          <ShortcutsDialog />
        </div>
      </DensityProvider>
    </ToastProvider>
  );
}
