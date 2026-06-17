// TopBar.tsx — the always-on top bar: section title left (with hamburger on mobile), global search + density
// toggle + shortcuts + notifications + credit pill right. Sticky so it stays in view while content scrolls.
"use client";

import { Icon, TpIconButton } from "@leadwolf/ui";
import { HelpCircle, LayoutGrid, Menu, Rows3 } from "lucide-react";
import { CreditPill } from "./CreditPill";
import { useDensity } from "./DensityProvider";
import { GlobalSearch } from "./GlobalSearch";
import { NotificationsBell } from "./NotificationsBell";

function DensityToggle() {
  const { density, toggle } = useDensity();
  const compact = density === "compact";
  return (
    <TpIconButton label={compact ? "Switch to comfortable density" : "Switch to compact density"} onClick={toggle}>
      <Icon icon={compact ? LayoutGrid : Rows3} size={16} />
    </TpIconButton>
  );
}

export function TopBar({ title, onMenuToggle }: { title: string; onMenuToggle?: () => void }) {
  return (
    <header className="tp-topbar">
      <div className="tp-topbar-left">
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
        <h1 className="tp-topbar-title">{title}</h1>
      </div>
      <div className="tp-topbar-right">
        <GlobalSearch />
        <DensityToggle />
        <TpIconButton
          label="Keyboard shortcuts"
          onClick={() => window.dispatchEvent(new CustomEvent("command:shortcuts"))}
        >
          <Icon icon={HelpCircle} size={16} />
        </TpIconButton>
        <NotificationsBell />
        <CreditPill />
      </div>
    </header>
  );
}
