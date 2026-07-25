// TopBar.tsx — the sticky top bar: the rail pin + mobile hamburger + section title on the left, and an
// app-supplied cluster on the right. Sticky so it stays in view while the content column scrolls.
//
// The right cluster is a slot: web fills it with global search, notifications and the credit pill; the staff
// consoles fill it with the density toggle, the shortcuts button and their cross-tenant notice. The pin and
// hamburger are shell mechanics and therefore live here, not in any app.
"use client";

import { Icon, TpIconButton } from "@leadwolf/ui";
import { HelpCircle, LayoutGrid, Menu, PanelLeftClose, PanelLeftOpen, Rows3 } from "lucide-react";
import type { ReactNode } from "react";
import { useDensity } from "./DensityProvider.tsx";

/** Comfortable/compact switch. Reads the DensityProvider the frame already mounts. */
export function DensityToggle() {
  const { density, toggle } = useDensity();
  const compact = density === "compact";
  return (
    <TpIconButton
      label={compact ? "Switch to comfortable density" : "Switch to compact density"}
      onClick={toggle}
    >
      <Icon icon={compact ? LayoutGrid : Rows3} size={16} />
    </TpIconButton>
  );
}

/** Opens the ShortcutsDialog via the same window event the "?" key uses. */
export function ShortcutsButton() {
  return (
    <TpIconButton
      label="Keyboard shortcuts"
      onClick={() => window.dispatchEvent(new CustomEvent("command:shortcuts"))}
    >
      <Icon icon={HelpCircle} size={16} />
    </TpIconButton>
  );
}

export function TopBar({
  title,
  onMenuToggle,
  pinned,
  onTogglePin,
  actions,
}: {
  title: string;
  onMenuToggle?: () => void;
  /** Desktop sidebar pin state — drives the rail toggle's icon + pressed state. */
  pinned?: boolean;
  onTogglePin?: () => void;
  /** The app's right-hand cluster. */
  actions?: ReactNode;
}) {
  return (
    <header className="tp-topbar">
      <div className="tp-topbar-left">
        {onTogglePin ? (
          <button
            type="button"
            className="tp-rail-toggle"
            onClick={onTogglePin}
            aria-pressed={pinned}
            aria-label={pinned ? "Collapse sidebar" : "Pin sidebar open"}
          >
            <Icon icon={pinned ? PanelLeftClose : PanelLeftOpen} size={18} />
          </button>
        ) : null}
        {onMenuToggle ? (
          <button
            type="button"
            className="tp-menu-btn"
            onClick={onMenuToggle}
            aria-label="Open navigation"
          >
            <Icon icon={Menu} size={18} />
          </button>
        ) : null}
        {/* NOTE: pages that render a <PageHeader> end up with two h1s (this one + the page title). That is
            apps/web's long-standing pattern and not a WCAG 2.2 AA failure, so it is preserved here rather
            than changed under a consistency refactor — demoting it would leave headingless the one page
            (web's Prospect surface) that renders no PageHeader of its own. */}
        <h1 className="tp-topbar-title">{title}</h1>
      </div>
      <div className="tp-topbar-right">{actions}</div>
    </header>
  );
}
