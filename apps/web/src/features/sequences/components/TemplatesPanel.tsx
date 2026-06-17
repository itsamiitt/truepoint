// TemplatesPanel.tsx — the "Templates" tab: the message-template library (M9, panel within Sequences) plus a
// merge-field reference. The templates backend isn't wired yet, so when useTemplates reports available=false
// the library shows a first-class "connect …" EmptyState (no invented templates) while the merge-field hints
// — which are static documentation, not data — always render so a rep composing a step knows the vocabulary.
// All async chrome via the State Kit. Pure presentation.
"use client";

import { Card, EmptyState, Icon, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { FileText } from "lucide-react";
import { useTemplates } from "../hooks/useTemplates";
import styles from "../sequences.module.css";
import { CHANNEL_LABEL, MERGE_FIELDS, SEQUENCE_STATUS_TONE, type TemplateSummary } from "../types";

function TemplateCard({ template }: { template: TemplateSummary }) {
  return (
    <div className={styles.templateCard}>
      <div className={styles.templateHead}>
        <span className={styles.templateName}>{template.name}</span>
        <StatusBadge tone="muted">{CHANNEL_LABEL[template.channel]}</StatusBadge>
      </div>
      {template.subject && <span className={styles.templateSubject}>{template.subject}</span>}
      <p className={styles.templateBody}>{template.body}</p>
    </div>
  );
}

export function TemplatesPanel() {
  const { data, available, loading, error, reload } = useTemplates();

  return (
    <div className={styles.tabPanel}>
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderText}>
            <h2 className={styles.cardTitle}>Template library</h2>
            <p className={styles.cardHint}>
              Reusable subject + body templates with merge fields, shared across your sequences.
            </p>
          </div>
        </div>

        <StateSwitch
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!available || data.length === 0}
          emptyState={
            <EmptyState
              icon={<Icon icon={FileText} size={28} />}
              title={available ? "No templates yet" : "Templates aren't connected yet"}
              description={
                available
                  ? "Save a step's copy as a template to reuse it across sequences. Templates land here once you create them."
                  : "The shared template library ships with the M9 outreach update. Until then, compose copy directly in each sequence step using the merge fields below."
              }
            />
          }
        >
          <div className={styles.templateGrid}>
            {data.map((t) => (
              <TemplateCard key={t.id} template={t} />
            ))}
          </div>
        </StateSwitch>
      </section>

      <Card>
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderText}>
            <h2 className={styles.cardTitle}>Merge fields & snippets</h2>
            <p className={styles.cardHint}>
              Drop these tokens into any step or template — they resolve from the contact at send time.
            </p>
          </div>
          <StatusBadge tone={SEQUENCE_STATUS_TONE.active}>Always available</StatusBadge>
        </div>

        <ul className={styles.mergeFieldList}>
          {MERGE_FIELDS.map((field) => (
            <li key={field.token} className={styles.mergeFieldRow}>
              <code className={styles.mergeToken}>{field.token}</code>
              <span className={styles.mergeDesc}>{field.description}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
