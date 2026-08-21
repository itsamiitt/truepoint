"use client";

// SiteHeader.tsx — the public masthead.
//
// The one client component on the site, and only because marking the current section needs the pathname.
// Everything else renders on the server. `aria-current="page"` is what actually announces the active section
// to a screen reader; the cobalt tint in the stylesheet is the visual echo of it, never the only signal
// (truepoint-design: no meaning by colour alone).

import { PRIMARY_NAV } from "@/content/site.ts";
import { Logo } from "@leadwolf/app-shell";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./site-chrome.module.css";

/** A nav entry is current for its own page and everything beneath it, so /docs/errors still marks "Docs". */
function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className={styles.header}>
      <div className={`tp-ui-page-container ${styles.headerInner}`} data-width="default">
        <Link href="/" className={styles.brand}>
          <Logo markSize={22} wordSize={16} />
          <span className={styles.brandSuffix}>Data</span>
        </Link>
        <nav className={styles.nav} aria-label="Primary">
          {PRIMARY_NAV.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={styles.navLink}
              aria-current={isCurrent(pathname, link.href) ? "page" : undefined}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
