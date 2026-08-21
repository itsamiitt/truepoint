// Prose.tsx — renders a Block[] from the content layer.
//
// This is the whole reason content is typed data rather than markdown: there is no parser here and no
// dangerouslySetInnerHTML anywhere on the site. A block is one of six known shapes, the switch is exhaustive,
// and adding a seventh shape is a type error at every call site rather than a page that silently renders
// nothing.

import type { Block } from "@/content/types.ts";
import { CodeBlock } from "./CodeBlock.tsx";
import { Note } from "./Note.tsx";
import { ReferenceTable } from "./ReferenceTable.tsx";
import styles from "./prose.module.css";

/** Stable per-block key. Blocks are static content in source order and are never reordered at runtime, so
 *  the index is the honest identity here — there is no id to prefer over it. */
function renderBlock(block: Block, index: number) {
  switch (block.kind) {
    case "h2":
      return (
        <h2 key={index} id={slugify(block.text)} className={styles.h2}>
          {block.text}
        </h2>
      );
    case "p":
      return (
        <p key={index} className={styles.p}>
          {block.text}
        </p>
      );
    case "list":
      return (
        <ul key={index} className={styles.list}>
          {block.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      );
    case "code":
      return <CodeBlock key={index} language={block.language} source={block.source} />;
    case "note":
      return (
        <Note key={index} tone={block.tone}>
          {block.text}
        </Note>
      );
    case "table":
      return <ReferenceTable key={index} headers={block.headers} rows={block.rows} />;
  }
}

/** Heading anchors, so a reader can link a colleague to one section rather than to a page. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function Prose({ blocks }: { blocks: readonly Block[] }) {
  return <div className={styles.prose}>{blocks.map(renderBlock)}</div>;
}
