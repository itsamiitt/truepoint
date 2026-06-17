// DraftReviewPanel.tsx — the AI draft → review → send seam (05 §13/§16) inside the Templates tab. LeadWolf is
// augmented-human: a draft is never auto-sent — it is gated on human review. The drafts backend is post-MVP,
// so when useDrafts reports available=false this renders a first-class "connect …" EmptyState. When drafts
// DO exist, each shows its review-gated status and copy, but the send button is intentionally disabled with a
// "review required" note — there is NO send call wired (no fake sends). Pure presentation.
"use client";

import { EmptyState, Icon, StateSwitch, StatusBadge, TpButton } from "@leadwolf/ui";
import { Send, Sparkles } from "lucide-react";
import { useDrafts } from "../hooks/useDrafts";
import styles from "../sequences.module.css";
import {
  DRAFT_STATUS_LABEL,
  DRAFT_STATUS_TONE,
  type DraftSummary,
  formatEventDate,
  shortId,
} from "../types";

function DraftCard({ draft }: { draft: DraftSummary }) {
  const tone = DRAFT_STATUS_TONE[draft.status];
  const reviewed = draft.status === "approved" || draft.status === "sent";
  return (
    <div className={styles.draftCard}>
      <div className={styles.draftHead}>
        <div className={styles.draftMeta}>
          <span className={styles.draftSubject}>{draft.subject || "(no subject)"}</span>
          <span className={styles.mono}>{shortId(draft.contactId)}</span>
        </div>
        {tone === "neutral" ? (
          <span className={styles.neutralPill}>{DRAFT_STATUS_LABEL[draft.status]}</span>
        ) : (
          <StatusBadge tone={tone}>{DRAFT_STATUS_LABEL[draft.status]}</StatusBadge>
        )}
      </div>

      <p className={styles.draftBody}>{draft.body}</p>

      <div className={styles.draftFooter}>
        <p className={styles.reviewGate}>
          <Icon icon={Sparkles} size={14} style={{ flex: "0 0 auto", marginTop: 1 }} />
          <span>
            {reviewed
              ? `Reviewed · updated ${formatEventDate(draft.updatedAt)}`
              : "Review required before this draft can be sent — sending stays human-reviewed."}
          </span>
        </p>
        {/* No send is wired: the engine is post-MVP and sending is gated on review. Always disabled. */}
        <TpButton
          variant="secondary"
          size="sm"
          disabled
          leftIcon={<Icon icon={Send} size={13} />}
          title="Sending ships with the M9 outreach update"
        >
          {draft.status === "sent" ? "Sent" : "Send"}
        </TpButton>
      </div>
    </div>
  );
}

export function DraftReviewPanel() {
  const { data, available, loading, error, reload } = useDrafts();

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardHeaderText}>
          <h2 className={styles.cardTitle}>AI drafts — review</h2>
          <p className={styles.cardHint}>
            AI-drafted first-touches wait here for your review. Sending is always human-reviewed.
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
            icon={<Icon icon={Sparkles} size={28} />}
            title={available ? "No drafts to review" : "AI drafting isn't connected yet"}
            description={
              available
                ? "When a step is AI-drafted from a revealed contact's profile, it appears here for review before any send."
                : "AI outreach drafting (draft → review → send) ships with the M9 outreach update. Drafts will appear here for human review — nothing is ever sent automatically."
            }
          />
        }
      >
        <div className={styles.draftList}>
          {data.map((d) => (
            <DraftCard key={d.id} draft={d} />
          ))}
        </div>
      </StateSwitch>
    </section>
  );
}
