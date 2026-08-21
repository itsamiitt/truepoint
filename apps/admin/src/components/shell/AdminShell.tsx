// AdminShell.tsx — the staff console's TWO-STAGE gate (ADR-0011 / ADR-0034), wrapped around the shared
// AppShellFrame. Stage 1 (authn): resolve a token via silent refresh; with none, redirect to the auth origin
// via PKCE. Stage 2 (authz): verify the signed-in identity is platform staff by probing the api `/admin/*`
// surface (verifyPlatformAdmin) — a non-staff caller (403) is shown an access-denied panel, NEVER the console.
// The api is the gate; the client never trusts a self-set flag.
//
// The chrome (rail, top bar, pin, density, mobile overlay, ⌘K) is @leadwolf/app-shell, shared with apps/web
// and apps/forge — this file previously carried its own copy of all of it. What stays here is the gate, the
// staff destination list, and the console-only affordances: the "Staff console" rail tag and the cross-tenant
// notice, both deliberate reminders that this surface reads across tenants.
"use client";

import { type StaffMePayload, verifyPlatformAdmin } from "@/lib/adminGate";
import { getAccessToken, logout, silentRefresh, startLogin } from "@/lib/authClient";
import { StaffMeProvider } from "@/lib/staffMe";
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
import { usePathname } from "next/navigation";

// Cmd-K palette off the first load, via its own subpath (perf-checklist PA-3 — see apps/web AppShell).
const CommandPalette = dynamic(
  () => import("@leadwolf/app-shell/palette").then((m) => m.CommandPalette),
  { ssr: false },
);
import { type ReactNode, useEffect, useState } from "react";
import { ImpersonationBanner } from "../ImpersonationBanner";
import { DESTINATIONS, sectionTitleFor } from "./navConfig";

// "verifying" is the T-2.4 addition: a token is held and the chrome is ALREADY RENDERED while the staff check
// runs. Previously the two stages ran strictly serially — silentRefresh, then verifyPlatformAdmin — with the
// console blank for the sum of both round-trips, which was worse than apps/web.s already-fixed pattern.
//
// Rendering before the staff verdict is safe because the verdict was never the security boundary: the api
// `/admin/*` surface re-checks the signed `pa` claim on every request and 403s a non-staff caller regardless
// of what this component shows. The cost is a brief chrome flash for the rare non-staff visitor; the gain is
// that every staff visitor stops waiting on a serial probe, and the page.s own data fetches overlap it.
type GateState = "loading" | "redirecting" | "verifying" | "staff" | "forbidden" | "error";

export function AdminShell({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>("loading");
  const [staffMe, setStaffMe] = useState<StaffMePayload | null>(null);

  async function runGate() {
    try {
      if (!getAccessToken()) await silentRefresh();
      if (!getAccessToken()) {
        setState("redirecting");
        await startLogin();
        return;
      }
      // Stage 1 done — a token is held. Show the console NOW and verify staff underneath it.
      setState("verifying");
      // Authoritative staff check: the api `/admin/*` guard (signed `pa` claim), probed via `/admin/me` —
      // whose payload seeds StaffMeProvider below, so the console's identity read is not fetched twice
      // (and the old probe, the 22-queue system-health fan-out, is no longer paid per page load).
      let verdict = await verifyPlatformAdmin();
      // A 401 here means we DID hold a token but the api rejected it (expired, or an audience/JWKS
      // mismatch). Try ONE silent refresh + re-probe; only restart login if that yields a fresh token.
      // We never re-login on a still-rejected token — that would be a tight redirect loop (a fresh token
      // would keep failing the same way) — so we fall through to the error state instead, like apps/web.
      if (verdict.result === "unauthenticated") {
        const refreshed = await silentRefresh();
        if (refreshed) verdict = await verifyPlatformAdmin();
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
      if (verdict.result !== "staff") {
        setState("error");
        return;
      }
      setStaffMe(verdict.me ?? null);
      setState("staff");
    } catch (err: unknown) {
      console.warn(`[admin] gate failed: ${err instanceof Error ? err.message : "unknown"}`);
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
            We couldn't reach the admin API. Check your connection and try again.
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

  if (state !== "staff" && state !== "verifying") {
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
    <StaffMeProvider me={staffMe}>
      <AppShellFrame
        renderSidebar={({ isOpen, close }) => (
          <Sidebar
            destinations={DESTINATIONS}
            homeHref="/tenants"
            badge="Staff console"
            isOpen={isOpen}
            onClose={close}
            footer={
              <UserRow
                // The old label here was `/auth/session`'s userId rendered AS an email — a wrong value
                // bought with an extra round trip per load. The staff ROLE from the gate's own payload
                // is the honest identity this console has.
                email={staffMe?.staffRole ?? null}
                roleLabel="Platform staff"
                onSignOut={() => void logout()}
              />
            }
          />
        )}
        renderTopBar={({ toggleMenu, pinned, togglePin }) => (
          <AdminTopBar toggleMenu={toggleMenu} pinned={pinned} togglePin={togglePin} />
        )}
        banner={<ImpersonationBanner />}
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
function AdminTopBar({
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
