// layout.tsx — root layout for the app domain (app.truepoint.in). Loads the shared TruePoint tokens.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@leadwolf/ui/tokens.css";
import "./globals.css";

export const metadata: Metadata = { title: "TruePoint" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
