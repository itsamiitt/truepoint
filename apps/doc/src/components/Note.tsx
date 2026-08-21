// Note.tsx — an inline callout.
//
// Two tones, and each states its own name. The coloured left border is the fast visual signal; the label is
// what actually carries the meaning for a reader who cannot see the border, which is why it is text and not
// an icon-only treatment (truepoint-design: never convey meaning by colour alone).

import styles from "./prose.module.css";

const LABEL = { info: "Note", warning: "Heads up" } as const;

export function Note({ tone, children }: { tone: "info" | "warning"; children: string }) {
  return (
    <aside className={`${styles.note} ${tone === "info" ? styles.noteInfo : styles.noteWarning}`}>
      <span className={styles.noteLabel}>{LABEL[tone]}</span>
      <p className={styles.noteBody}>{children}</p>
    </aside>
  );
}
