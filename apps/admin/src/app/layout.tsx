// layout.tsx — root layout for the staff-console domain (admin.truepoint.internal). Self-hosts Geist via
// next/font and loads the shared TruePoint tokens, exactly like apps/web — the console is the same brand.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@leadwolf/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "TruePoint — Platform Admin",
  description: "TruePoint platform staff console.",
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
