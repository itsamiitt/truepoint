// TemplatesPanel.tsx — the "Templates" tab: the owner-scoped message-template library (M12 P2) plus a
// merge-field reference. The backend is LIVE: click a card to edit/view it, "New template" to author one — both
// open the TemplateEditor dialog (versioned content, server-side safe preview, share/archive, version history).
// An Active/Archived filter makes archiving reversible (an archived template opens with "Restore to active").
// The library is keyset-paginated ("Load more"); a load-more failure surfaces inline and never tears down the
// already-loaded grid. The merge-field hints are static documentation, always shown. Pure presentation.
"use client";

import { Card, EmptyState, Icon, StateSwitch, StatusBadge, TpButton, TpChip } from "@leadwolf/ui";
import { FileText } from "lucide-react";
import { useState } from "react";
import { useTemplates } from "../hooks/useTemplates";
import styles from "../sequences.module.css";
import { CHANNEL_LABEL, MERGE_FIELDS, SEQUENCE_STATUS_TONE, type TemplateSummary } from "../types";
import { TemplateEditor } from "./TemplateEditor";

function TemplateCard({
  template,
  onOpen,
}: {
  template: TemplateSummary;
  onOpen: () => void;
}) {
  return (
    <button type="button" className={styles.templateCardButton} onClick={onOpen}>
      <div className={styles.templateHead}>
        <span className={styles.templateName}>{template.name}</span>
        <StatusBadge tone="muted">{CHANNEL_LABEL[template.channel]}</StatusBadge>
      </div>
      {template.subject && <span className={styles.templateSubject}>{template.subject}</span>}
      <p className={styles.templateBody}>{template.body}</p>
    </button>
  );
}

export function TemplatesPanel() {
  const {
    data,
    status,
    setStatus,
    available,
    nextCursor,
    loading,
    loadingMore,
    error,
    loadMoreError,
    reload,
    loadMore,
  } = useTemplates();
  const [editor, setEditor] = useState<{ open: boolean; id: string | null }>({
    open: false,
    id: null,
  });

  const closeEditor = () => setEditor({ open: false, id: null });
  const archived = status === "archived";

  return (
    <div className={styles.tabPanel}>
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderText}>
            <h2 className={styles.cardTitle}>Template library</h2>
            <p className={styles.cardHint}>
              Reusable subject + body templates with merge fields, versioned and shareable across
              your sequences.
            </p>
          </div>
          {available && !archived ? (
            <TpButton size="sm" onClick={() => setEditor({ open: true, id: null })}>
              New template
            </TpButton>
          ) : null}
        </div>

        {available ? (
          <div className={styles.templateFilterRow}>
            <TpChip active={!archived} onClick={() => setStatus("active")}>
              Active
            </TpChip>
            <TpChip active={archived} onClick={() => setStatus("archived")}>
              Archived
            </TpChip>
          </div>
        ) : null}

        <StateSwitch
          loading={loading}
          error={error}
          onRetry={reload}
          empty={!available || data.length === 0}
          emptyState={
            <EmptyState
              icon={<Icon icon={FileText} size={28} />}
              title={
                !available
                  ? "Templates aren't available"
                  : archived
                    ? "No archived templates"
                    : "No templates yet"
              }
              description={
                !available
                  ? "The template library couldn't be reached. Refresh, or compose copy directly in each sequence step using the merge fields below."
                  : archived
                    ? "Templates you archive land here. Open one to restore it to your active library."
                    : "Create your first reusable template, or save a step's copy as one. Templates you own and ones shared with your workspace appear here."
              }
            />
          }
        >
          <div className={styles.templateGrid}>
            {data.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                onOpen={() => setEditor({ open: true, id: t.id })}
              />
            ))}
          </div>
          {nextCursor ? (
            <div className={styles.loadMoreRow}>
              <TpButton
                variant="secondary"
                size="sm"
                onClick={() => void loadMore()}
                loading={loadingMore}
              >
                Load more
              </TpButton>
              {loadMoreError ? (
                <span className={styles.templateFormError}>{loadMoreError}</span>
              ) : null}
            </div>
          ) : null}
        </StateSwitch>
      </section>

      <Card>
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderText}>
            <h2 className={styles.cardTitle}>Merge fields & snippets</h2>
            <p className={styles.cardHint}>
              Drop these tokens into any step or template — they resolve from the contact at send
              time.
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

      {editor.open ? (
        <TemplateEditor
          templateId={editor.id}
          open={editor.open}
          onClose={closeEditor}
          onSaved={reload}
        />
      ) : null}
    </div>
  );
}
