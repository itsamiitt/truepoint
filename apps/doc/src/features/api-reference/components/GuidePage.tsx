// GuidePage.tsx — renders one prose guide. Every /docs/[slug] page goes through here, and the /docs index
// shares its body renderer, so they cannot diverge in heading scale, spacing or measure.

import { PageIntro } from "@/components/PageIntro.tsx";
import type { Guide } from "@/content/types.ts";
import { GuideBody } from "./GuideBody.tsx";

export function GuidePage({ guide }: { guide: Guide }) {
  return (
    <article>
      <PageIntro eyebrow="Documentation" title={guide.title} lede={guide.summary} />
      <GuideBody blocks={guide.blocks} />
    </article>
  );
}
