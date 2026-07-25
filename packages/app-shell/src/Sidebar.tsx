// Sidebar.tsx — the collapsible left rail, shared by every app. Dark text on the --tp-surface-2 rail, a single
// hairline right border, and a subtle fill + cobalt glyph on the active route. Collapsed to an icon rail by
// default; expands on hover/focus or when pinned (the width lives in shell.css, driven by the grid column).
// On mobile it becomes a fixed overlay driven by isOpen/onClose from AppShellFrame.
//
// The rail is deliberately slot-based: every app supplies its own destinations and its own footer content
// (web adds the settings link and the team/org/workspace switchers; the staff consoles add only the user row),
// so one rail serves all three without a per-app copy.
"use client";

import { Icon } from "@leadwolf/ui";
import { X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Brandmark, Wordmark } from "./Logo.tsx";
import { NavItem } from "./NavItem.tsx";
import type { NavDestination } from "./nav.ts";

export function Sidebar({
  destinations,
  homeHref,
  badge,
  footer,
  isOpen,
  onClose,
}: {
  destinations: NavDestination[];
  /** Where the brand lockup links to (each app's landing destination). */
  homeHref: string;
  /** Optional muted tag under the brand — the staff consoles use it to flag the internal surface. */
  badge?: ReactNode;
  /** Everything below the divider: the settings link, switchers, and the user row. */
  footer?: ReactNode;
  isOpen?: boolean;
  onClose?: () => void;
}) {
  const pathname = usePathname() ?? "/";

  return (
    <aside className={`tp-sidebar${isOpen ? " is-open" : ""}`}>
      <div className="tp-brand">
        <Link className="tp-brand-lockup" href={homeHref} aria-label="TruePoint — Home">
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
      {badge ? <div className="tp-staff-tag">{badge}</div> : null}

      <nav className="tp-nav" aria-label="Primary">
        {destinations.map((dest) => (
          <NavItem key={dest.href} dest={dest} pathname={pathname} />
        ))}
      </nav>

      {footer ? (
        <div className="tp-sidebar-footer">
          <div className="tp-divider" />
          {footer}
        </div>
      ) : null}
    </aside>
  );
}
