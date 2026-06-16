// QuickActionsRow.tsx — a row of one-click deep-links into the primary workflows (Prospect, Import,
// Sequences). Pure presentation + navigation: no data, no PII. The hrefs are the (shell) destinations the
// Sidebar already routes. Public slice component.
"use client";

import Link from "next/link";
import styles from "./HomePage.module.css";

const ACTIONS: { label: string; href: string; glyph: string }[] = [
  { label: "Find prospects", href: "/prospect", glyph: "◇" },
  { label: "Import contacts", href: "/import", glyph: "⤓" },
  { label: "Build a sequence", href: "/sequences", glyph: "▤" },
];

export function QuickActionsRow() {
  return (
    <nav className={styles.quickActions} aria-label="Quick actions">
      {ACTIONS.map((action) => (
        <Link key={action.href} href={action.href} className={styles.quickAction}>
          <span className={styles.quickActionGlyph} aria-hidden="true">
            {action.glyph}
          </span>
          {action.label}
        </Link>
      ))}
    </nav>
  );
}
