"use client";

// DocsSidebar.tsx — the reference index.
//
// Generated from the guide list and the endpoint contract, so adding either gives it navigation for free.
// Client-side only to read the pathname for `aria-current` — the same reason SiteHeader is a client
// component, and the same reason it matters: the highlight is the visual echo, the attribute is what a
// screen reader actually announces.

import { ENDPOINTS } from "@/content/endpoints/index.ts";
import { GUIDES } from "@/content/guides/index.ts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "../api-reference.module.css";

interface Entry {
  readonly href: string;
  readonly label: string;
}

const GUIDE_ENTRIES: readonly Entry[] = [
  { href: "/docs", label: "Quickstart" },
  ...GUIDES.map((guide) => ({ href: `/docs/${guide.slug}`, label: guide.title })),
  // Not a Guide: it renders a console rather than blocks, so it has no content module to be generated from.
  { href: "/docs/playground", label: "Playground" },
];

const ENDPOINT_ENTRIES: readonly Entry[] = ENDPOINTS.map((endpoint) => ({
  href: `/docs/api/${endpoint.slug}`,
  label: endpoint.title,
}));

function Group({
  heading,
  entries,
  pathname,
}: { heading: string; entries: readonly Entry[]; pathname: string }) {
  return (
    <div className={styles.sidebarGroup}>
      <h2 className={styles.sidebarHeading}>{heading}</h2>
      <ul className={styles.sidebarList}>
        {entries.map((entry) => (
          <li key={entry.href}>
            <Link
              href={entry.href}
              className={styles.sidebarLink}
              aria-current={pathname === entry.href ? "page" : undefined}
            >
              {entry.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DocsSidebar() {
  const pathname = usePathname();
  return (
    <nav className={styles.sidebar} aria-label="Documentation">
      <Group heading="Guides" entries={GUIDE_ENTRIES} pathname={pathname} />
      <Group heading="API reference" entries={ENDPOINT_ENTRIES} pathname={pathname} />
    </nav>
  );
}
