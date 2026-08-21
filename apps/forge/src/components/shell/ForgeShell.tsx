// ForgeShell.tsx — the operator console's TWO-STAGE gate (ADR-0011 / ADR-0034), wrapped around the shared
// AppShellFrame. Stage 1 (authn): resolve a token via silent refresh; with none, redirect to the auth origin
// via PKCE. Stage 2 (authz): verify the signed-in identity is platform staff by probing the forge-api `/bff/*`
// surface (verifyForgeStaff) — a non-staff caller (403) is shown an access-denied panel, NEVER the console.
// The forge-api is the gate; the client never trusts a self-set flag.
//
// The chrome (rail, top bar, pin, density, mobile overlay, ⌘K) is @leadwolf/app-shell, shared with apps/web
// and apps/admin — this file previously carried a near-verbatim copy of apps/admin's. What stays here is the
// gate, the operator destination list, and the console-only "Forge console" rail tag. The rail identity
// (email) comes from /bff/me via StaffMeProvider — the old same-origin /api/v1/auth/session probe was a
// main-api route and 404'd forever under the same-origin BFF deployment.
"use client";

import { getAccessToken, logout, silentRefresh, startLogin } from "@/lib/authClient";
import { type StaffMePayload, verifyForgeStaff } from "@/lib/forgeGate";
import { StaffMeProvider, useStaffMe } from "@/lib/staffMe";
import {
  AppShellFrame,
  Brandmark,
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
import dynamic from "next/dynamic";

// Cmd-K palette off the first load, via its own subpath (perf-checklist PA-3 — see apps/web AppShell).
const CommandPalette = dynamic(
  () => import("@leadwolf/app-shell/palette").then((m) => m.CommandPalette),
  { ssr: false },
);
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { DESTINATIONS, sectionTitleFor } from "./navConfig";

type GateState = "loading" | "redirecting" | "staff" | "forbidden" | "misrouted" | "error";

export function ForgeShell({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("loading");
  // Seeded from the gate probe so StaffMeProvider does not repeat the /bff/me read it already performed
  // (T-2.5). Null until the gate resolves; the provider falls back to fetching if it stays null.
  const [staffMe, setStaffMe] = useState<StaffMePayload | null>(null);

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
      if (verdict.result === "unauthenticated") {
        const refreshed = await silentRefresh();
        if (refreshed) verdict = await verifyForgeStaff();
        if (verdict.result === "unauthenticated") {
          if (!getAccessToken()) {
            setState("redirecting");
            await startLogin();
            return;
          }
          setState("error");
          return;
        }
      }
      if (verdict.result === "forbidden") {
        setState("forbidden");
        return;
      }
      if (verdict.result === "misrouted") {
        setState("misrouted");
        return;
      }
      if (verdict.result !== "staff") {
        setState("error");
        return;
      }
      if (verdict.me) setStaffMe(verdict.me);
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

  if (state === "error" || state === "misrouted") {
    return (
      <div className="tp-center-screen">
        <div className="tp-signin-card">
          <Brandmark size={30} title="TruePoint" />
          <p className="app-muted">
            {state === "misrouted"
              ? "The Forge API returned an unexpected response (404). This usually means a deployment or routing issue on our side — not your connection."
              : "We couldn't reach the Forge API. Check your connection and try again."}
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
    <StaffMeProvider initial={staffMe}>
      <AppShellFrame
        renderSidebar={({ isOpen, close }) => (
          <Sidebar
            destinations={DESTINATIONS}
            homeHref="/overview"
            badge="Forge console"
            isOpen={isOpen}
            onClose={close}
            footer={<ForgeUserRow />}
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

/** Rail identity from the shared /bff/me read (StaffMeProvider wraps the frame) — one fetch, no side probe. */
function ForgeUserRow() {
  const { email } = useStaffMe();
  return <UserRow email={email} roleLabel="Platform staff" onSignOut={() => void logout()} />;
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
