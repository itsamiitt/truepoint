// docs/page.tsx — the quickstart, which is the documentation index itself rather than a page beneath it.
//
// Composed directly (intro + facts strip + prose) rather than through GuidePage, because the index is the one
// documentation page that opens with the reference facts strip — the /docs/[slug] guides stay on GuidePage.

import { QUICKSTART } from "@/content/guides/index.ts";
import { ApiFactsStrip, GuideBody } from "@/features/api-reference/index.ts";
import { PageHeader } from "@leadwolf/ui";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quickstart",
  description:
    "What the TruePoint data API does, what a call costs, and how to make your first one.",
};

export default function DocsRoute() {
  return (
    <article>
      <PageHeader eyebrow="Documentation" title={QUICKSTART.title} subtitle={QUICKSTART.summary} />
      <div style={{ marginTop: "var(--tp-space-6)" }}>
        <ApiFactsStrip />
      </div>
      <GuideBody blocks={QUICKSTART.blocks} />
    </article>
  );
}
