// Sidebar.tsx — the compact left rail (04 §1 north-star; 11 §2). Dark text on the #f9fafb surface, a single
// hairline right border, and a subtle fill on the active route (NO colored bar/glow). Destinations come from the
// central navConfig (lucide icons); Settings + the team/workspace switchers + the user row are pinned at the
// bottom. Active state derives from usePathname().
"use client";

import { logout } from "@/lib/authClient";
import { Avatar, DropdownMenu, Icon } from "@leadwolf/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type NavDestination, DESTINATIONS, SETTINGS_DESTINATION, isActive } from "./navConfig";
import { TeamSwitcher } from "./TeamSwitcher";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

/** "member" → "Member"; null/empty role falls back to a calm "Member" so the row never reads blank. */
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
        <Icon icon={dest.icon} size={16} />
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

export function Sidebar({ userEmail, role }: { userEmail: string | null; role: string | null }) {
  const pathname = usePathname() ?? "/";

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
        <NavItem dest={SETTINGS_DESTINATION} pathname={pathname} />
        <TeamSwitcher />
        <WorkspaceSwitcher />
        <UserRow userEmail={userEmail} role={role} />
      </div>
    </aside>
  );
}
