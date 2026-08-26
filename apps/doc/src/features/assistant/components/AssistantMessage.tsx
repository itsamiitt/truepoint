// AssistantMessage.tsx — one turn in the assistant transcript.
//
// The assistant's own turns carry their sources as real links rather than as a sentence naming a page, so the
// answer is one click from the page it was composed out of. That is the honesty mechanism for this feature:
// nothing it says is unattributable, and a reader who suspects the summary can go read the source.

import Link from "next/link";
import type { AnswerLink } from "../answer.ts";
import styles from "../assistant.module.css";

export interface Turn {
  readonly id: number;
  readonly from: "reader" | "assistant";
  readonly text: string;
  readonly links: readonly AnswerLink[];
}

export function AssistantMessage({ turn }: { turn: Turn }) {
  const fromReader = turn.from === "reader";
  return (
    <div className={fromReader ? styles.rowReader : styles.rowAssistant}>
      <div className={fromReader ? styles.bubbleReader : styles.bubbleAssistant}>
        <p className={styles.bubbleText}>{turn.text}</p>
        {turn.links.length > 0 ? (
          <ul className={styles.sources}>
            {turn.links.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className={styles.source}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
