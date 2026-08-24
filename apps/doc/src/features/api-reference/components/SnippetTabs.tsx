"use client";

// SnippetTabs.tsx — the worked request in the reader's language of choice.
//
// Client-side only for the selection itself. The snippets are computed on the server and passed in as plain
// data, so choosing a language costs nothing but a re-render — no fetch, and the page is complete without
// JavaScript: the first snippet is rendered as normal markup, and a reader with scripting off still gets a
// working cURL example rather than an empty box.
//
// The selector is the design system's SegmentedControl, which renders role="tablist"/"tab"; the code panel
// below carries role="tabpanel" and names its language, so the pair announces as a tab set rather than as
// three unexplained buttons and an unrelated region.

import { CodeBlock } from "@/components/CodeBlock.tsx";
import type { Snippet } from "@/content/snippets.ts";
import { SegmentedControl } from "@leadwolf/ui";
import { useState } from "react";
import styles from "../api-reference.module.css";

export function SnippetTabs({ snippets }: { snippets: readonly Snippet[] }) {
  const [selected, setSelected] = useState(snippets[0]?.id ?? "curl");
  const active = snippets.find((snippet) => snippet.id === selected) ?? snippets[0];
  if (!active) return null;

  return (
    <div className={styles.snippets}>
      <SegmentedControl
        aria-label="Example language"
        items={snippets.map((snippet) => ({ value: snippet.id, label: snippet.label }))}
        value={active.id}
        onChange={setSelected}
      />
      <div role="tabpanel" aria-label={`${active.label} example`}>
        <CodeBlock language={active.language} source={active.source} />
      </div>
    </div>
  );
}
