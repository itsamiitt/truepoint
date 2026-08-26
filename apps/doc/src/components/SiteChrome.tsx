// SiteChrome.tsx — header, main landmark and footer, wrapped once so no page re-declares them.
//
// The skip link is the first tab stop on every page. With a sticky masthead carrying five nav links, a
// keyboard or screen-reader user would otherwise walk the same navigation before reaching content on every
// single page — WCAG 2.2 AA calls that a bypass-blocks failure, and it is the cheapest one to fix.
//
// The assistant provider wraps the chrome rather than sitting inside a route, for the same reason the skip
// link does: every page gets it, and no page has to remember to ask. It renders the floating panel after
// `children` so the panel is last in the DOM order — a reader tabbing through the page reaches the content
// before the assistant, not instead of it.

import type { ReactNode } from "react";
import { AssistantProvider } from "./AssistantContext.tsx";
import { SiteFooter } from "./SiteFooter.tsx";
import { SiteHeader } from "./SiteHeader.tsx";
import styles from "./site-chrome.module.css";

export function SiteChrome({ children }: { children: ReactNode }) {
  return (
    <AssistantProvider>
      <a href="#main" className="tp-skip-link">
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className={styles.main}>
        {children}
      </main>
      <SiteFooter />
    </AssistantProvider>
  );
}
