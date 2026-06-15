// layout.tsx — root layout for the auth origin. Self-hosts Geist via next/font (the `geist` package) so
// the brand typeface loads reliably with no external request, and marks the whole origin noindex.
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@leadwolf/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sign in · TruePoint",
  description: "Authentication for TruePoint.",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon-180.png",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
