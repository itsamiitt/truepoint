// TopBar.tsx — the staff-console top bar: section title left (with hamburger on mobile) + a quiet
// cross-tenant notice on the right. Sticky so it stays in view while content scrolls. Deliberately lean
// (no global search / credit pill): this is an internal ops surface, not the customer app.
"use client";

import { Icon } from "@leadwolf/ui";
import { Globe, Menu } from "lucide-react";

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
        <span className="tp-scope-note">
          <Icon icon={Globe} size={14} />
          Cross-tenant view
        </span>
      </div>
    </header>
  );
}
