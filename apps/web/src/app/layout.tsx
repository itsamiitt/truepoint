// layout.tsx — root layout for the app domain (app.truepoint.in). Self-hosts Geist via next/font (the
// `geist` package) and loads the shared TruePoint tokens.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@leadwolf/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = { title: "TruePoint" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
