"use client";

// CodeBlock.tsx — a fenced code sample, as the API-documentation design's dark panel: twilight surface,
// a labelled header row, and a copy control.
//
// No syntax highlighter. A highlighter is a runtime dependency and a bundle cost, and on a page whose samples
// are four-line curl invocations it buys colour, not comprehension. The language is stated in the header
// instead. Source is rendered as a text child, never as HTML — nothing on this site parses markup.
//
// "use client" because of the clipboard write. The copy confirmation swaps the button label ("Copy" →
// "Copied"), which also announces via the button's aria-live region — the state change is text, not colour.
//
// The copy control is a styled <button>, not TpButton — same reasoning as ButtonLink.tsx: every TpButton
// variant is drawn for light surfaces, and this control sits on the twilight panel. The DS ships no
// dark-surface button, so the look lives in prose.module.css beside the panel it belongs to.

import { useEffect, useRef, useState } from "react";
import styles from "./prose.module.css";

export function CodeBlock({ language, source }: { language: string; source: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function copy() {
    // Clipboard access can be denied (permissions policy, insecure context). The sample is still selectable
    // text either way, so a failed write just skips the confirmation rather than surfacing an error state.
    navigator.clipboard?.writeText(source).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      },
      () => undefined,
    );
  }

  return (
    <div className={styles.codeWrap}>
      <div className={styles.codeHead}>
        <span className={styles.codeLang}>{language}</span>
        <button type="button" className={styles.codeCopy} onClick={copy} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className={styles.code}>
        <code>{source}</code>
      </pre>
    </div>
  );
}
