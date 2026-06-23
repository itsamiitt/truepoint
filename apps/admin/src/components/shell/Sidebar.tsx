// Sidebar.tsx — the staff-console left rail. Mirrors the apps/web rail chrome (dark text on the #f9fafb
// surface, a single hairline right border, subtle fill + cobalt icon on the active route). A muted "Staff
// console" tag under the brand keeps the operator aware this is the internal, cross-tenant surface (ADR-0011).
"use client";

import { logout } from "@/lib/authClient";
import { Avatar, DropdownMenu, Icon } from "@leadwolf/ui";
import { X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brandmark } from "./Brandmark";
import { DESTINATIONS, type NavDestination, isActive } from "./navConfig";

function NavItem({ dest, pathname }: { dest: NavDestination; pathname: string }) {
  const active = isActive(pathname, dest.match);
  return (
    <Link
      className={`tp-nav-item${active ? " is-active" : ""}`}
      href={dest.href}
      aria-current={active ? "page" : undefined}
    >
      <span className="tp-nav-glyph" aria-hidden="true">
        <Icon icon={dest.icon} size={16} />
      </span>
      <span className="tp-nav-label">{dest.label}</span>
    </Link>
  );
}

function UserRow({ userEmail }: { userEmail: string | null }) {
  return (
    <DropdownMenu
      align="start"
      side="top"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          className="tp-user-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          <Avatar name={userEmail} size={28} />
          <span className="tp-user-meta">
            <span className="tp-user-email">{userEmail ?? "Signed in"}</span>
            <span className="tp-user-role">Platform staff</span>
          </span>
        </button>
      )}
      items={[{ label: "Sign out", onSelect: () => void logout() }]}
    />
  );
}

export function Sidebar({
  userEmail,
  isOpen,
  onClose,
}: {
  userEmail: string | null;
  isOpen?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname() ?? "/";

  return (
    <aside className={`tp-sidebar${isOpen ? " is-open" : ""}`}>
      <div className="tp-brand">
        <Brandmark size={20} />
        <span className="tp-brand-name">
          <span style={{ fontWeight: 400 }}>True</span>
          <span style={{ fontWeight: 700 }}>Point</span>
        </span>
        {onClose ? (
          <button
            type="button"
            className="tp-sidebar-close"
            onClick={onClose}
            aria-label="Close navigation"
          >
            <Icon icon={X} size={16} />
          </button>
        ) : null}
      </div>
      <div className="tp-staff-tag">Staff console</div>

      <nav className="tp-nav" aria-label="Primary">
        {DESTINATIONS.map((dest) => (
          <NavItem key={dest.href} dest={dest} pathname={pathname} />
        ))}
      </nav>

      <div className="tp-sidebar-footer">
        <div className="tp-divider" />
        <UserRow userEmail={userEmail} />
      </div>
    </aside>
  );
}
