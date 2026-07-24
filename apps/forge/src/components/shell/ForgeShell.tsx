// ForgeShell.tsx — the operator console's TWO-STAGE gate (ADR-0011 / ADR-0034), wrapped around the shared
// AppShellFrame. Stage 1 (authn): resolve a token via silent refresh; with none, redirect to the auth origin
// via PKCE. Stage 2 (authz): verify the signed-in identity is platform staff by probing the forge-api `/bff/*`
// surface (verifyForgeStaff) — a non-staff caller (403) is shown an access-denied panel, NEVER the console.
// The forge-api is the gate; the client never trusts a self-set flag.
//
// The chrome (rail, top bar, pin, density, mobile overlay, ⌘K) is @leadwolf/app-shell, shared with apps/web
// and apps/admin — this file previously carried a near-verbatim copy of apps/admin's. What stays here is the
// gate, the operator destination list, and the console-only "Forge console" rail tag.
"use client";

import { fetchWithAuth, getAccessToken, logout, silentRefresh, startLogin } from "@/lib/authClient";
import { verifyForgeStaff } from "@/lib/forgeGate";
import { API_BASE } from "@/lib/publicConfig";
import { StaffMeProvider } from "@/lib/staffMe";
import {
  AppShellFrame,
  Brandmark,
  CommandPalette,
  DensityToggle,
  ShortcutsButton,
  ShortcutsDialog,
  Sidebar,
  TopBar,
  UserRow,
  paletteEntriesFrom,
} from "@leadwolf/app-shell";
import { Icon, TpButton } from "@leadwolf/ui";
import { Globe } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { DESTINATIONS, sectionTitleFor } from "./navConfig";

type GateState = "loading" | "redirecting" | "staff" | "forbidden" | "error";

export function ForgeShell({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("loading");
  const [userEmail, setUserEmail] = useState<string | null>(null);

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
          <Brandmark size={30} title="TruePoint" />
          <p className="app-muted">
            We couldn't reach the Forge API. Check your connection and try again.
          </p>
          <TpButton
            variant="primary"
            onClick={() => {
              setState("loading");
              void runGate();
            }}
          >
            Retry
          </TpButton>
        </div>
      </div>
    );
  }

  if (state !== "staff") {
    return (
      <div className="tp-center-screen">
        <div className="tp-boot">
          <Brandmark size={34} title="TruePoint" />
          <p className="app-muted">
            {state === "redirecting" ? "Redirecting to sign in…" : "Checking access…"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <StaffMeProvider>
      <AppShellFrame
        renderSidebar={({ isOpen, close }) => (
          <Sidebar
            destinations={DESTINATIONS}
            homeHref="/overview"
            badge="Forge console"
            isOpen={isOpen}
            onClose={close}
            footer={
              <UserRow
                email={userEmail}
                roleLabel="Platform staff"
                onSignOut={() => void logout()}
              />
            }
          />
        )}
        renderTopBar={({ toggleMenu, pinned, togglePin }) => (
          <ForgeTopBar toggleMenu={toggleMenu} pinned={pinned} togglePin={togglePin} />
        )}
        overlays={
          <>
            <CommandPalette
              navigate={paletteEntriesFrom(DESTINATIONS)}
              actions={[
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
    </StaffMeProvider>
  );
}

/** Split out so it can subscribe to the pathname for its section title. */
function ForgeTopBar({
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
          <DensityToggle />
          <ShortcutsButton />
          {/* Console-only: a quiet standing reminder that this surface reads across tenants. */}
          <span className="tp-scope-note">
            <Icon icon={Globe} size={14} />
            Cross-tenant view
          </span>
        </>
      }
    />
  );
}
