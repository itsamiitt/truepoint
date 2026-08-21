// CodeBlock.tsx — a fenced code sample.
//
// No syntax highlighter. A highlighter is a runtime dependency and a bundle cost, and on a page whose samples
// are four-line curl invocations it buys colour, not comprehension. The language is stated in the header
// instead. Source is rendered as a text child, never as HTML — nothing on this site parses markup.

import styles from "./prose.module.css";

export function CodeBlock({ language, source }: { language: string; source: string }) {
  return (
    <div className={styles.codeWrap}>
      <span className={styles.codeLang}>{language}</span>
      <pre className={styles.code}>
        <code>{source}</code>
      </pre>
    </div>
  );
}
