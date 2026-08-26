// guideSections.ts — fold a guide's blocks into the design's two-column sections.
//
// The reference design reads as prose on the left with the worked sample pinned beside it, section by
// section — the shape endpoint pages already use. Guides were a single linear column, so a reader following
// the authentication guide scrolled the header example off the top while reading what it meant.
//
// This is a PRESENTATION fold, deliberately: no content module changes, no new block kind, nothing for an
// author to remember. A section is whatever follows an h2; its code blocks go to the sticky column and
// everything else stays in the reading column, in source order within each. A guide that ships no code
// renders exactly as before, because a section with no samples is rendered as one full-width column.

import type { Block } from "../../content/types.ts";

export interface GuideSection {
  /** The h2 that opened the section, or undefined for blocks appearing before the first one. */
  readonly heading?: string;
  readonly prose: readonly Block[];
  readonly samples: readonly Extract<Block, { kind: "code" }>[];
}

export function toSections(blocks: readonly Block[]): readonly GuideSection[] {
  const sections: GuideSection[] = [];
  let prose: Block[] = [];
  let samples: Extract<Block, { kind: "code" }>[] = [];
  let heading: string | undefined;
  let started = false;

  function flush() {
    // The lead block group is only a section if the guide actually opened with prose; a guide whose first
    // block is its h2 must not produce an empty section above it.
    if (!started && prose.length === 0 && samples.length === 0) return;
    sections.push({ heading, prose, samples });
    prose = [];
    samples = [];
  }

  for (const block of blocks) {
    if (block.kind === "h2") {
      flush();
      started = true;
      heading = block.text;
      // The heading stays in the reading column: it is the section's title, not a label on the pair.
      prose = [block];
      continue;
    }
    if (block.kind === "code") samples.push(block);
    else prose.push(block);
  }
  flush();

  return sections;
}
