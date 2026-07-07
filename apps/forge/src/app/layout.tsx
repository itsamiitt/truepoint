// layout.tsx — root layout for the Forge operator-console domain (forge.truepoint.in). Self-hosts Geist via
// next/font and loads the shared TruePoint tokens, exactly like apps/admin — the console is the same brand.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@leadwolf/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "TruePoint — Forge",
  description: "TruePoint Forge operator console.",
  applicationName: "TruePoint",
};

export const viewport: Viewport = { themeColor: "#2563C9" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
