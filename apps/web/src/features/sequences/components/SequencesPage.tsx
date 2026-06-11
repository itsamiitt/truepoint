// SequencesPage.tsx — the Sequences destination (11 §4.3, ADR-0009 MVP slice): the sequence list, the
// selected sequence's enrollment panel (selected state, not a route), and the create-sequence builder.
// Composes the slice's hooks + components; all data flows through api.ts. Public slice component.
"use client";

import { useCallback, useMemo, useState } from "react";
import { useSequences } from "../hooks/useSequences";
import styles from "../sequences.module.css";
import { EnrollmentPanel } from "./EnrollmentPanel";
import { SequenceBuilder } from "./SequenceBuilder";
import { SequenceList } from "./SequenceList";

export function SequencesPage() {
  const { sequences, error, loading, reload } = useSequences();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = useMemo(
    () => sequences.find((s) => s.id === selectedId) ?? null,
    [sequences, selectedId],
  );

  const handleChanged = useCallback(() => {
    void reload();
  }, [reload]);

  return (
    <main className={styles.page}>
      <header className={styles.heading}>
        <h1 className={styles.title}>Sequences</h1>
        <p className={styles.subtitle}>
          Multi-step email outreach: build a sequence, enroll revealed contacts, send step by step.
        </p>
      </header>

      {error && <p className={styles.error}>{error}</p>}

      <SequenceList
        sequences={sequences}
        loading={loading}
        selectedId={selectedId}
        onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
      />

      {selected && (
        <EnrollmentPanel key={selected.id} sequence={selected} onChanged={handleChanged} />
      )}

      <SequenceBuilder onChanged={handleChanged} />
    </main>
  );
}
