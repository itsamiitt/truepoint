// docs/page.tsx — the quickstart, which is the documentation index itself rather than a page beneath it.
//
// Composed directly (intro + facts strip + prose) rather than through GuidePage, because the index is the one
// documentation page that opens with the reference facts strip — the /docs/[slug] guides stay on GuidePage.

import { PageIntro } from "@/components/PageIntro.tsx";
import { Prose } from "@/components/Prose.tsx";
import { QUICKSTART } from "@/content/guides/index.ts";
import { ApiFactsStrip } from "@/features/api-reference/index.ts";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Quickstart",
  description:
    "What the TruePoint data API does, what a call costs, and how to make your first one.",
};

export default function DocsRoute() {
  return (
    <article>
      <PageIntro eyebrow="Documentation" title={QUICKSTART.title} lede={QUICKSTART.summary} />
      <div style={{ marginTop: "var(--tp-space-6)" }}>
        <ApiFactsStrip />
      </div>
      <div style={{ marginTop: "var(--tp-space-8)" }}>
        <Prose blocks={QUICKSTART.blocks} />
      </div>
    </article>
  );
}
