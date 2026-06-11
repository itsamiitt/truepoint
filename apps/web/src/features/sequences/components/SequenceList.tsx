// SequenceList.tsx — the sequence list card (name · status badge · step/enrolled counts) with row
// selection that opens the enrollment panel. Quiet empty state pointing at the builder below. Pure
// presentation; data arrives from useSequences via the page.
"use client";

import { Spinner, StatusBadge } from "@leadwolf/ui";
import styles from "../sequences.module.css";
import { SEQUENCE_STATUS_LABEL, SEQUENCE_STATUS_TONE, type SequenceSummary } from "../types";

export function SequenceList({
  sequences,
  loading,
  selectedId,
  onSelect,
}: {
  sequences: SequenceSummary[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Your sequences</h2>
        <p className={styles.cardHint}>Select a sequence to enroll contacts and send steps.</p>
      </div>

      {loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading sequences…
        </div>
      ) : sequences.length === 0 ? (
        <p className={styles.muted}>
          No sequences yet. A sequence is an ordered set of email steps; once it exists you enroll
          revealed contacts and every send passes the suppression and CAN-SPAM gates. Create your
          first one below.
        </p>
      ) : (
        <ul className={styles.seqList}>
          {sequences.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={styles.seqRow}
                aria-pressed={s.id === selectedId}
                onClick={() => onSelect(s.id)}
              >
                <span className={styles.seqName}>{s.name}</span>
                <StatusBadge tone={SEQUENCE_STATUS_TONE[s.status]}>
                  {SEQUENCE_STATUS_LABEL[s.status]}
                </StatusBadge>
                <span className={styles.seqMeta}>
                  {s.stepCount} step{s.stepCount === 1 ? "" : "s"} · {s.enrolledCount} enrolled
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
