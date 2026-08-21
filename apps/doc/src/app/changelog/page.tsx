// changelog/page.tsx — the dated record of contract, price and sourcing changes.

import { ChangelogPage } from "@/features/changelog/index.ts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every change to the published API contract, pricing and sourcing posture, dated.",
};

export default function ChangelogRoute() {
  return <ChangelogPage />;
}
