// layout.tsx — root layout for the auth origin. Loads the shared TruePoint tokens + Geist (light theme
// only) and marks the whole origin noindex (auth pages are never indexed).
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
