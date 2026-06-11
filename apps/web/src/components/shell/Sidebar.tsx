// Sidebar.tsx — the compact left rail (04 §1 north-star spec; 11 §2 "6 destinations"). Dark text on the
// #f9fafb surface, a single hairline right border, and a subtle --tp-surface-3 fill for the active route
// (NO colored bar/glow). Settings + the workspace switcher + the user row are pinned at the bottom. Active
// state derives from usePathname(): a destination is active when the path matches or sits under its href.
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

interface Destination {
  label: string;
  href: string;
  /** The path prefix that marks this destination active (so nested routes still highlight it). */
  match: string;
  glyph: string;
}

const DESTINATIONS: Destination[] = [
  { label: "Home", href: "/home", match: "/home", glyph: "◆" },
  { label: "Prospect", href: "/prospect", match: "/prospect", glyph: "◇" },
  { label: "Sequences", href: "/sequences", match: "/sequences", glyph: "▤" },
  { label: "Inbox", href: "/inbox", match: "/inbox", glyph: "▦" },
  { label: "Reports", href: "/reports", match: "/reports", glyph: "▧" },
];

const SETTINGS: Destination = {
  label: "Settings",
  href: "/settings/billing",
  match: "/settings",
  glyph: "⚙",
};

function isActive(pathname: string, match: string): boolean {
  return pathname === match || pathname.startsWith(`${match}/`);
}

function NavItem({ dest, pathname }: { dest: Destination; pathname: string }) {
  const active = isActive(pathname, dest.match);
  return (
    <Link
      className={`tp-nav-item${active ? " is-active" : ""}`}
      href={dest.href}
      aria-current={active ? "page" : undefined}
    >
      <span className="tp-nav-glyph" aria-hidden="true">
        {dest.glyph}
      </span>
      <span className="tp-nav-label">{dest.label}</span>
    </Link>
  );
}

export function Sidebar({ userEmail }: { userEmail: string | null }) {
  const pathname = usePathname() ?? "/";
  const initials = (userEmail ?? "?").slice(0, 2).toUpperCase();

  return (
    <aside className="tp-sidebar">
      <div className="tp-brand">
        <span className="tp-brand-mark" aria-hidden="true" />
        <span className="tp-brand-name">TruePoint</span>
      </div>

      <nav className="tp-nav" aria-label="Primary">
        {DESTINATIONS.map((dest) => (
          <NavItem key={dest.href} dest={dest} pathname={pathname} />
        ))}
      </nav>

      <div className="tp-sidebar-footer">
        <div className="tp-divider" />
        <NavItem dest={SETTINGS} pathname={pathname} />
        <WorkspaceSwitcher />
        <div className="tp-user-row">
          <span className="tp-avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="tp-user-meta">
            <span className="tp-user-email">{userEmail ?? "Signed in"}</span>
            <span className="tp-user-role">Member</span>
          </span>
        </div>
      </div>
    </aside>
  );
}
