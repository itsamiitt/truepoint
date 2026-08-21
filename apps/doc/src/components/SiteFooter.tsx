// SiteFooter.tsx — the public footer: navigation, the one-line pitch, and the routes out of here.
//
// The privacy address is in the footer of every page on purpose. Someone who has found their own name in a
// database and wants it gone should not have to hunt for how — that is outcome A-02 expressed as information
// architecture rather than as a queue.

import { CONTACT, FOOTER_NAV, SITE_TAGLINE } from "@/content/site.ts";
import Link from "next/link";
import styles from "./site-chrome.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className="tp-ui-page-container" data-width="default">
        <div className={styles.footerGrid}>
          <div>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--tp-ink)" }}>
              TruePoint Data
            </p>
            <p className={styles.footerNote}>{SITE_TAGLINE}</p>
          </div>
          {FOOTER_NAV.map((column) => (
            <div key={column.heading}>
              <h2 className={styles.footerHeading}>{column.heading}</h2>
              <ul className={styles.footerList}>
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className={styles.footerLink}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className={styles.footerLegal}>
          <p style={{ margin: 0 }}>
            To ask what we hold about you, correct it, or have it removed, write to{" "}
            <a href={CONTACT.privacy}>privacy@truepoint.in</a>. No account needed.
          </p>
          <p style={{ margin: "var(--tp-space-2) 0 0" }}>
            Looking for the TruePoint prospecting app instead?{" "}
            <a href={CONTACT.app}>app.truepoint.in</a>
          </p>
        </div>
      </div>
    </footer>
  );
}
