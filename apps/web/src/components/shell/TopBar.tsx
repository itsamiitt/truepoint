// TopBar.tsx — the always-on top bar (11 §3): the section title at the left; on the right the global search, a
// density toggle, a keyboard-shortcuts trigger, the notifications bell, and the credit pill. The title is derived
// by the shell from the active route (navConfig). Quiet + monochrome so every destination reads as one system.
"use client";

import { Icon, TpIconButton } from "@leadwolf/ui";
import { HelpCircle, LayoutGrid, Rows3 } from "lucide-react";
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

export function TopBar({ title }: { title: string }) {
  return (
    <header className="tp-topbar">
      <h1 className="tp-topbar-title">{title}</h1>
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
