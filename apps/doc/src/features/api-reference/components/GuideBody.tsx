// GuideBody.tsx — a guide's blocks, laid out as the design's paired sections.
//
// Prose on the left, that section's samples pinned beside it. Used by every /docs/[slug] guide and by the
// /docs index, so the quickstart and the guides cannot diverge in layout.

import { CodeBlock } from "@/components/CodeBlock.tsx";
import { Prose } from "@/components/Prose.tsx";
import type { Block } from "@/content/types.ts";
import styles from "../api-reference.module.css";
import { toSections } from "../guideSections.ts";

export function GuideBody({ blocks }: { blocks: readonly Block[] }) {
  const sections = toSections(blocks);

  return (
    <>
      {sections.map((section, index) => (
        // Sections are static content in source order and are never reordered, so the index is the honest
        // identity here — the same reasoning as Prose.tsx's block keys. A heading is not unique enough: two
        // sections may legitimately share one.
        <section
          // biome-ignore lint/suspicious/noArrayIndexKey: static content, never reordered — see above.
          key={index}
          className={section.samples.length > 0 ? styles.guideSplit : styles.guideSingle}
        >
          <div className={styles.guideProse}>
            <Prose blocks={section.prose} />
          </div>
          {section.samples.length > 0 ? (
            <aside
              className={styles.aside}
              aria-label={section.heading ? `${section.heading} — examples` : "Examples"}
            >
              {section.samples.map((sample) => (
                <CodeBlock key={sample.source} language={sample.language} source={sample.source} />
              ))}
            </aside>
          ) : null}
        </section>
      ))}
    </>
  );
}
