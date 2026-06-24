// Sidebar.tsx — the compact left rail. Dark text on the #f9fafb surface, a single hairline right border,
// and a subtle fill + cobalt icon on the active route (fills allowed per 04 §3; no colored glow). Responsive:
// on mobile the rail is a fixed overlay driven by isOpen / onClose from AppShell.
"use client";

import { logout } from "@/lib/authClient";
import { Avatar, DropdownMenu, Icon } from "@leadwolf/ui";
import { X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brandmark, Wordmark } from "./Logo";
import { OrgSwitcher } from "./OrgSwitcher";
import { TeamSwitcher } from "./TeamSwitcher";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { DESTINATIONS, type NavDestination, SETTINGS_DESTINATION, isActive } from "./navConfig";

function roleLabel(role: string | null): string {
  if (!role) return "Member";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function NavItem({ dest, pathname }: { dest: NavDestination; pathname: string }) {
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

function UserRow({ userEmail, role }: { userEmail: string | null; role: string | null }) {
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
            <span className="tp-user-role">{roleLabel(role)}</span>
          </span>
        </button>
      )}
      items={[{ label: "Sign out", onSelect: () => void logout() }]}
    />
  );
}

export function Sidebar({
  userEmail,
  role,
  isOpen,
  onClose,
}: {
  userEmail: string | null;
  role: string | null;
  isOpen?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname() ?? "/";

  return (
    <aside className={`tp-sidebar${isOpen ? " is-open" : ""}`}>
      <div className="tp-brand">
        <Link className="tp-brand-lockup" href="/home" aria-label="TruePoint — Home">
          <Brandmark size={22} />
          <span className="tp-brand-word">
            <Wordmark size={16} />
          </span>
        </Link>
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

      <nav className="tp-nav" aria-label="Primary">
        {DESTINATIONS.map((dest) => (
          <NavItem key={dest.href} dest={dest} pathname={pathname} />
        ))}
      </nav>

      <div className="tp-sidebar-footer">
        <div className="tp-divider" />
        <NavItem dest={SETTINGS_DESTINATION} pathname={pathname} />
        <div className="tp-sidebar-switchers">
          <TeamSwitcher />
          <OrgSwitcher />
          <WorkspaceSwitcher />
        </div>
        <UserRow userEmail={userEmail} role={role} />
      </div>
    </aside>
  );
}
