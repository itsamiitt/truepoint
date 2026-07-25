// AppShellFrame.tsx — the chrome every signed-in surface sits in: the rail column, the sticky top bar, and the
// internally-scrolling content column. It owns the shell MECHANICS that all three apps used to re-implement:
// mobile sidebar open/close (including closing on route change), the desktop rail pin, and the density context.
//
// It deliberately owns NO auth. Each app keeps its own gate — web's single token gate, admin's two-stage
// verifyPlatformAdmin, forge's forgeGate — and renders this frame only once the gate has passed. That keeps
// every authorization decision inside the app that owns it and out of a shared package.
"use client";

import { ToastProvider } from "@leadwolf/ui";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { DensityProvider } from "./DensityProvider.tsx";
import { useSidebarPin } from "./useSidebarPin.ts";

export interface SidebarRenderProps {
  isOpen: boolean;
  close: () => void;
}

export interface TopBarRenderProps {
  toggleMenu: () => void;
  pinned: boolean;
  togglePin: () => void;
}

export function AppShellFrame({
  renderSidebar,
  renderTopBar,
  banner,
  overlays,
  children,
}: {
  renderSidebar: (props: SidebarRenderProps) => ReactNode;
  renderTopBar: (props: TopBarRenderProps) => ReactNode;
  /** Optional strip above the content (announcements, impersonation notice). */
  banner?: ReactNode;
  /** Mounted-once widgets: the command palette, the shortcuts dialog, realtime bridges. */
  overlays?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { pinned, togglePinned } = useSidebarPin();

  // Close the mobile sidebar whenever the route changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — only pathname triggers close.
  useEffect(() => {
    setSidebarOpen(false);
  }, [pathname]);

  return (
    <ToastProvider>
      <DensityProvider>
        <div className={`tp-shell${pinned ? " is-pinned" : ""}`}>
          {/* Mobile scrim — tap anywhere outside the sidebar to close. */}
          {sidebarOpen && (
            <button
              type="button"
              className="tp-sidebar-scrim"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
              style={{ border: "none", padding: 0, appearance: "none", cursor: "pointer" }}
            />
          )}
          {renderSidebar({ isOpen: sidebarOpen, close: () => setSidebarOpen(false) })}
          <div className="tp-main">
            {renderTopBar({
              toggleMenu: () => setSidebarOpen((v) => !v),
              pinned,
              togglePin: togglePinned,
            })}
            {banner}
            <main className="tp-content">{children}</main>
          </div>
          {overlays}
        </div>
      </DensityProvider>
    </ToastProvider>
  );
}
