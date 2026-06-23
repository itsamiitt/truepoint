// SequencesPage.tsx — the Sequences destination (11 §4.3, ADR-0009). A Tabs switch across three surfaces:
// "Sequences" (the list + builder Drawer + the selected sequence's enrollment Drawer), "Templates" (library +
// merge fields + the AI draft → review seam), and "Send status" (the per-sequence delivery funnel). Composes
// the slice's hooks + components; all data flows through api.ts. The list's data is shared with Send status so
// we never double-fetch. Public slice component.
"use client";

import { PageHeader } from "@/components/PageHeader";
import { Tabs } from "@leadwolf/ui";
import { useCallback, useState } from "react";
import { useSequences } from "../hooks/useSequences";
import styles from "../sequences.module.css";
import type { SequenceSummary } from "../types";
import { DraftReviewPanel } from "./DraftReviewPanel";
import { EnrollmentPanel } from "./EnrollmentPanel";
import { SendStatusDashboard } from "./SendStatusDashboard";
import { SequenceBuilder } from "./SequenceBuilder";
import { SequenceList } from "./SequenceList";
import { TemplatesPanel } from "./TemplatesPanel";

type TabKey = "sequences" | "templates" | "status";

const TABS = [
  { value: "sequences", label: "Sequences" },
  { value: "templates", label: "Templates" },
  { value: "status", label: "Send status" },
];

export function SequencesPage() {
  const { sequences, error, loading, reload, setStatus, pendingId } = useSequences();
  const [tab, setTab] = useState<TabKey>("sequences");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [selected, setSelected] = useState<SequenceSummary | null>(null);

  const handleChanged = useCallback(() => {
    void reload();
  }, [reload]);

  const handleSetStatus = useCallback(
    (s: SequenceSummary) => {
      void setStatus(s.id, s.status === "paused" ? "active" : "paused");
    },
    [setStatus],
  );

  return (
    <main className={styles.page}>
      <PageHeader
        title="Sequences"
        subtitle="Multi-step outreach: build a sequence, enroll revealed contacts, send step by step."
      />

      <div className={styles.tabsRow}>
        <Tabs
          items={TABS}
          value={tab}
          onChange={(v) => setTab(v as TabKey)}
          aria-label="Sequences views"
        />
      </div>

      {tab === "sequences" && (
        <div className={styles.tabPanel}>
          <SequenceList
            sequences={sequences}
            loading={loading}
            error={error}
            onRetry={handleChanged}
            onSelect={setSelected}
            onCreate={() => setBuilderOpen(true)}
            onSetStatus={handleSetStatus}
            pendingId={pendingId}
          />
        </div>
      )}

      {tab === "templates" && <TemplatesPanel />}

      {tab === "status" && (
        <div className={styles.tabPanel}>
          <SendStatusDashboard
            sequences={sequences}
            loading={loading}
            error={error}
            onRetry={handleChanged}
          />
          <DraftReviewPanel />
        </div>
      )}

      <SequenceBuilder
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        onCreated={() => {
          setBuilderOpen(false);
          handleChanged();
        }}
      />

      {selected && (
        <EnrollmentPanel
          key={selected.id}
          sequence={selected}
          onClose={() => setSelected(null)}
          onChanged={handleChanged}
        />
      )}
    </main>
  );
}
