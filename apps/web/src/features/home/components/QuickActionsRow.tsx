// QuickActionsRow.tsx — a row of one-click deep-links into the primary workflows (New search, Import, Start
// sequence). Pure presentation + navigation: no data, no PII. Each link carries a lucide glyph and routes to
// a (shell) destination the Sidebar already serves. Anchor-based so it stays keyboard- and screen-reader-
// navigable (a button can't host an href). Public slice component.
"use client";

import { Icon, type IconComponent } from "@leadwolf/ui";
import { Download, Search, Send } from "lucide-react";
import Link from "next/link";
import styles from "./HomePage.module.css";

const ACTIONS: { label: string; href: string; icon: IconComponent }[] = [
  { label: "New search", href: "/prospect", icon: Search },
  { label: "Import contacts", href: "/import", icon: Download },
  { label: "Start sequence", href: "/sequences", icon: Send },
];

export function QuickActionsRow() {
  return (
    <nav className={styles.quickActions} aria-label="Quick actions">
      {ACTIONS.map((action) => (
        <Link key={action.href} href={action.href} className={styles.quickAction}>
          <span className={styles.quickActionGlyph}>
            <Icon icon={action.icon} size={15} />
          </span>
          {action.label}
        </Link>
      ))}
    </nav>
  );
}
