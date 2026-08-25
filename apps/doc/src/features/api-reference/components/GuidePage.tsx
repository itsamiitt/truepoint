// GuidePage.tsx — renders one prose guide. Every /docs/[slug] page and the /docs index go through here, so
// they cannot diverge in heading scale, spacing or measure.

import { Prose } from "@/components/Prose.tsx";
import type { Guide } from "@/content/types.ts";
import { PageHeader } from "@leadwolf/ui";

export function GuidePage({ guide }: { guide: Guide }) {
  return (
    <article>
      <PageHeader eyebrow="Documentation" title={guide.title} subtitle={guide.summary} />
      <div style={{ marginTop: "var(--tp-space-8)" }}>
        <Prose blocks={guide.blocks} />
      </div>
    </article>
  );
}
