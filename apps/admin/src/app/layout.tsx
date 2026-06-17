// layout.tsx — root layout for the staff-console domain (admin.truepoint.internal). Self-hosts Geist via
// next/font and loads the shared TruePoint tokens, exactly like apps/web — the console is the same brand.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@leadwolf/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = { title: "TruePoint — Platform Admin" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
