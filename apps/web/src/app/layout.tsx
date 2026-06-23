// layout.tsx — root layout for the app domain (app.truepoint.in). Self-hosts Geist via next/font (the
// `geist` package) and loads the shared TruePoint tokens.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { API_BASE, AUTH_ORIGIN } from "../lib/publicConfig";
import "@leadwolf/ui/tokens.css";
import "./globals.css";

// Warm the cross-origin connections on the sign-in critical path. The first fetch to the auth
// and API origins (PKCE redirect, token exchange, data load) otherwise pays a fresh DNS lookup +
// TLS handshake; preconnect kicks that off while the document is still parsing. dns-prefetch is
// the cheaper fallback for clients that don't honour preconnect. Skipped when the origin is empty
// (single-domain deployments proxy auth + API through the app origin — same-origin, no handshake).
const PRECONNECT_ORIGINS: readonly string[] = [...new Set([AUTH_ORIGIN, API_BASE])].filter(Boolean);

export const metadata: Metadata = {
  title: { default: "TruePoint", template: "%s · TruePoint" },
  description: "The intelligent prospecting CRM. Find, reveal, score and pursue.",
  applicationName: "TruePoint",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = { themeColor: "#2563C9" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        {PRECONNECT_ORIGINS.map((origin) => (
          <link key={origin} rel="preconnect" href={origin} crossOrigin="anonymous" />
        ))}
        {PRECONNECT_ORIGINS.map((origin) => (
          <link key={origin} rel="dns-prefetch" href={origin} />
        ))}
      </head>
      <body>{children}</body>
    </html>
  );
}
