"use client";

// SnippetTabs.tsx — the worked request in the reader's language of choice.
//
// Client-side only for the selection itself. The snippets are computed on the server and passed in as plain
// data, so choosing a language costs nothing but a re-render — no fetch, and the page is complete without
// JavaScript: the first snippet is rendered as normal markup, and a reader with scripting off still gets a
// working cURL example rather than an empty box.
//
// The selector is the design system's SegmentedControl. It is a RADIOGROUP, not a tablist — the DS made that
// split deliberately (a segmented control picks a value; a tablist switches panels), so the panel below can
// no longer claim role="tabpanel": a tabpanel with no tab that owns it is an orphan the accessibility tree
// reports as a broken relationship. It is a named group instead, which is what it actually is: the code
// sample for the language currently chosen.

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
      <div
        // The rule's native suggestion is <fieldset>, which is wrong here: a fieldset groups FORM CONTROLS
        // and there are none inside — it is a code sample — and its native legend box would draw a second
        // frame around the panel. role="group" is the plain "these belong together, and here is what they
        // are" grouping, which is exactly the relationship the segmented control above needs named.
        // biome-ignore lint/a11y/useSemanticElements: <fieldset> groups form controls; this groups a code sample
        role="group"
        aria-label={`${active.label} example`}
      >
        <CodeBlock language={active.language} source={active.source} />
      </div>
    </div>
  );
}
