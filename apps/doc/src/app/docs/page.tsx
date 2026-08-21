// docs/page.tsx — the quickstart, which is the documentation index itself rather than a page beneath it.

import { QUICKSTART } from "@/content/guides/index.ts";
import { GuidePage } from "@/features/api-reference/index.ts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quickstart",
  description:
    "What the TruePoint data API does, what a call costs, and how to make your first one.",
};

export default function DocsRoute() {
  return <GuidePage guide={QUICKSTART} />;
}
