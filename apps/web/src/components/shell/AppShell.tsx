// AppShell.tsx — the customer app's auth gate, wrapped around the shared AppShellFrame. It authenticates with
// the smallest possible block: as soon as a token exists (from the just-completed login, or a silent refresh)
// it renders the chrome + children so the route's own data fetch can start, and resolves the session profile
// (sidebar email/role) in the BACKGROUND rather than holding the whole tree behind a full-screen "Loading…".
// With no token at all it redirects to the auth-origin login via PKCE.
//
// The chrome itself (rail, top bar, pin, density, mobile overlay) is @leadwolf/app-shell, shared with
// apps/admin and apps/forge. What stays here is what is genuinely web's: this gate, the customer destination
// list, and the customer-only top-bar widgets (global search, notifications, credit pill) and rail switchers.
"use client";

import { AnnouncementBanner } from "@/features/announcements/AnnouncementBanner";
import {
  clearAccessToken,
  fetchWithAuth,
  getAccessToken,
  logout,
  silentRefresh,
  startLogin,
} from "@/lib/authClient";
import { API_BASE } from "@/lib/publicConfig";
import {
  AppShellFrame,
  Brandmark,
  CommandPalette,
  DensityToggle,
  Logo,
  NavItem,
  ShortcutsButton,
  ShortcutsDialog,
  Sidebar,
  TopBar,
  UserRow,
} from "@leadwolf/app-shell";
import { TpButton } from "@leadwolf/ui";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { CreditPill } from "./CreditPill";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationsBell } from "./NotificationsBell";
import { OrgSwitcher } from "./OrgSwitcher";
import { TeamSwitcher } from "./TeamSwitcher";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import {
  DESTINATIONS,
  PALETTE_NAVIGATE,
  PALETTE_QUICK,
  SETTINGS_DESTINATION,
  sectionTitleFor,
} from "./navConfig";

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

function roleLabel(role: string | null): string {
  if (!role) return "Member";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function AppShell({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>("authenticating");
  const [session, setSession] = useState<Session | null>(null);

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
    <AppShellFrame
      renderSidebar={({ isOpen, close }) => (
        <Sidebar
          destinations={DESTINATIONS}
          homeHref="/home"
          isOpen={isOpen}
          onClose={close}
          footer={
            <>
              <NavItemSettings />
              <div className="tp-sidebar-switchers">
                <TeamSwitcher />
                <OrgSwitcher />
                <WorkspaceSwitcher />
              </div>
              <UserRow
                email={session ? session.userId : null}
                roleLabel={roleLabel(session?.role ?? null)}
                onSignOut={() => void logout()}
              />
            </>
          }
        />
      )}
      renderTopBar={({ toggleMenu, pinned, togglePin }) => (
        <TopBarWithTitle toggleMenu={toggleMenu} pinned={pinned} togglePin={togglePin} />
      )}
      banner={<AnnouncementBanner />}
      overlays={
        <>
          <CommandPalette
            navigate={PALETTE_NAVIGATE}
            quick={PALETTE_QUICK}
            actions={[
              {
                id: "switch-workspace",
                label: "Switch workspace",
                keywords: ["team", "tenant"],
                onSelect: () => window.dispatchEvent(new CustomEvent("command:switch-workspace")),
              },
              {
                id: "log-out",
                label: "Log out",
                keywords: ["sign out", "logout"],
                onSelect: () => void logout(),
              },
            ]}
          />
          <ShortcutsDialog />
        </>
      }
    >
      {children}
    </AppShellFrame>
  );
}

/** The settings destination sits below the divider rather than in the primary nav list. */
function NavItemSettings() {
  const pathname = usePathname() ?? "/";
  return <NavItem dest={SETTINGS_DESTINATION} pathname={pathname} />;
}

/** Splits the top bar out so it can subscribe to the pathname for its section title. */
function TopBarWithTitle({
  toggleMenu,
  pinned,
  togglePin,
}: {
  toggleMenu: () => void;
  pinned: boolean;
  togglePin: () => void;
}) {
  const pathname = usePathname() ?? "/";
  return (
    <TopBar
      title={sectionTitleFor(pathname)}
      onMenuToggle={toggleMenu}
      pinned={pinned}
      onTogglePin={togglePin}
      actions={
        <>
          <GlobalSearch />
          <DensityToggle />
          <ShortcutsButton />
          <NotificationsBell />
          <CreditPill />
        </>
      }
    />
  );
}
