// NavItem.tsx — one rail destination: a fixed 20px glyph slot + a label that fades in with the rail. The glyph
// is 18px in every app (the staff consoles used to render 16px, which made the rails visibly different).
"use client";

import { Icon } from "@leadwolf/ui";
import Link from "next/link";
import type { NavDestination } from "./nav.ts";
import { isActive } from "./nav.ts";

export function NavItem({ dest, pathname }: { dest: NavDestination; pathname: string }) {
  const active = isActive(pathname, dest.match);
  return (
    <Link
      className={`tp-nav-item${active ? " is-active" : ""}`}
      href={dest.href}
      aria-current={active ? "page" : undefined}
    >
      <span className="tp-nav-glyph" aria-hidden="true">
        <Icon icon={dest.icon} size={18} />
      </span>
      <span className="tp-nav-label">{dest.label}</span>
    </Link>
  );
}
