"use client";

// DocsSidebar.tsx — the reference index, as the design's grouped rail: a filter box, Tools above the prose,
// then the guides and the contract, each entry carrying a left cobalt indicator when it is the current page.
//
// Client-side for two reasons now. The pathname drives `aria-current` — the highlight is the visual echo, the
// attribute is what a screen reader actually announces — and the filter box holds state. The filter is a pure
// array scan over ~11 labels (sidebarEntries.ts), not a search: site search is the masthead combobox, which
// reads body text and reaches every page on the site. This only narrows a list already on screen, which is
// why it needs no listbox semantics — the links stay links, and there are simply fewer of them.

import { useAssistant } from "@/components/AssistantContext.tsx";
import { TpButton, TpInput } from "@leadwolf/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import styles from "../api-reference.module.css";
import { filterGroups } from "../sidebarEntries.ts";

export function DocsSidebar() {
  const pathname = usePathname();
  const assistant = useAssistant();
  const [query, setQuery] = useState("");
  const groups = filterGroups(query);

  return (
    <nav className={styles.sidebar} aria-label="Documentation">
      <div className={styles.sidebarHead}>
        <span className={styles.sidebarEyebrow}>Documentation</span>
        <span className={styles.sidebarStamp}>v1</span>
      </div>

      <TpInput
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter this list"
        aria-label="Filter documentation"
        className={styles.sidebarFilter}
      />

      {groups.map((group) => (
        <div key={group.heading} className={styles.sidebarGroup}>
          <h2 className={styles.sidebarHeading}>{group.heading}</h2>
          <ul className={styles.sidebarList}>
            {group.entries.map((entry) => (
              <li key={entry.href}>
                <Link
                  href={entry.href}
                  className={styles.sidebarLink}
                  aria-current={pathname === entry.href ? "page" : undefined}
                >
                  {entry.method ? (
                    <span
                      className={`${styles.sidebarMethod} ${
                        entry.method === "GET" ? styles.sidebarMethodGet : styles.sidebarMethodPost
                      }`}
                    >
                      {entry.method}
                    </span>
                  ) : null}
                  {entry.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {groups.length === 0 ? (
        <p className={styles.sidebarEmpty}>
          Nothing in this list matches that. The masthead search reads the body of every page — try
          it there, or ask the assistant.
        </p>
      ) : null}

      <div className={styles.sidebarFoot}>
        <TpButton variant="secondary" size="sm" full onClick={assistant.open}>
          Ask the assistant
        </TpButton>
      </div>
    </nav>
  );
}
