// layout.tsx — root layout for the app domain (app.truepoint.in). Self-hosts Geist via next/font (the
// `geist` package) and loads the shared TruePoint tokens.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@leadwolf/ui/tokens.css";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
