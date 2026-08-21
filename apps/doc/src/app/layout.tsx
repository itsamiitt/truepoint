// layout.tsx — root layout for the public developer portal (doc.truepoint.in; ADR-0048). Self-hosts Geist via
// next/font and loads the shared TruePoint tokens, exactly like apps/web, apps/admin and apps/forge — this is
// a different audience, not a different brand.
//
// The chrome is wrapped here rather than per-route so no page can ship without the skip link, the masthead
// and the footer's route to privacy@truepoint.in.
//
// tokens.css is NOT imported here: globals.css already `@import`s it, so a JS import as well would pull the
// same stylesheet into the graph twice. The `@import` is also what fixes the ORDER — tokens must be defined
// before the primitives that consume them.

import { SiteChrome } from "@/components/SiteChrome.tsx";
import { SITE_ORIGIN, SITE_TAGLINE } from "@/content/site.ts";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  // metadataBase makes every relative canonical and social URL resolve absolutely. Without it Next emits
  // relative URLs that crawlers and link unfurlers resolve against the wrong host.
  metadataBase: new URL(SITE_ORIGIN),
  title: { default: "TruePoint Data", template: "%s · TruePoint Data" },
  description: SITE_TAGLINE,
  applicationName: "TruePoint",
  // The opposite of apps/auth, which sets index:false. This site is meant to be found — the plan's own
  // position is that the documentation is the sales team.
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { themeColor: "#2563C9" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <SiteChrome>{children}</SiteChrome>
      </body>
    </html>
  );
}
