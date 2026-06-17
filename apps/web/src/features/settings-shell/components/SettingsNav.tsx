"use client";
// SettingsNav.tsx — the left scope-nav for Settings (User · Workspace · Tenant · Developer). Driven entirely by
// SETTINGS_NAV from the central navConfig, so adding a settings route updates the nav in one place. Active link
// derives from usePathname().
import { SETTINGS_NAV, isActive } from "@/components/shell/navConfig";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function SettingsNav() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="tp-settings-nav" aria-label="Settings">
      {SETTINGS_NAV.map((group) => (
        <div key={group.scope} className="tp-settings-group">
          <div className="tp-settings-scope">{group.scope}</div>
          {group.items.map((item) => {
            const active = isActive(pathname, item.match);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`tp-settings-link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
