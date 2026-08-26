// GuidePage.tsx — renders one prose guide. Every /docs/[slug] page goes through here, and the /docs index
// shares its body renderer, so they cannot diverge in heading scale, spacing or measure.

import type { Guide } from "@/content/types.ts";
import { PageHeader } from "@leadwolf/ui";
import { GuideBody } from "./GuideBody.tsx";

export function GuidePage({ guide }: { guide: Guide }) {
  return (
    <article>
      <PageHeader eyebrow="Documentation" title={guide.title} subtitle={guide.summary} />
      {/* No spacer: every GuideBody section carries `padding: var(--tp-space-8) 0` of its own. */}
      <GuideBody blocks={guide.blocks} />
    </article>
  );
}
