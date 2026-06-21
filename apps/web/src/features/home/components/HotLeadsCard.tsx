// HotLeadsCard.tsx — top-priority leads for this workspace (facets only — no PII; see home.ts). Each row
// shows name + title/domain, an outreach-status badge, and the priority score. All four async states render
// through the shared WidgetCard → StateSwitch. Public slice component.
"use client";

import { StatusBadge } from "@leadwolf/ui";
import { Flame } from "lucide-react";
import type { HotLead } from "../types";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

function leadName(lead: HotLead): string {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim();
  return name || "Unnamed lead";
}

function leadSub(lead: HotLead): string {
  return [lead.jobTitle, lead.emailDomain].filter(Boolean).join(" · ") || "No title on file";
}

export function HotLeadsCard({
  leads,
  loading,
  error,
  onRetry,
}: {
  leads: HotLead[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  // The single highest-priority lead earns the Cobalt fill; its bar is the reference width for the rest.
  const maxScore = leads.reduce((hi, l) => Math.max(hi, l.priorityScore), 0);
  const topIndex = leads.findIndex((l) => l.priorityScore === maxScore);

  return (
    <WidgetCard
      title="Hot leads"
      icon={Flame}
      hint={leads.length > 0 ? "By priority" : undefined}
      loading={loading}
      error={error}
      empty={leads.length === 0}
      onRetry={onRetry}
      emptyIcon={Flame}
      emptyTitle="No prioritized leads yet"
      emptyDescription="Reveal or score contacts and the highest-priority ones surface here."
    >
      <div className={styles.list}>
        {leads.map((lead, i) => {
          const score = Math.round(lead.priorityScore);
          // Bar width is relative to the busiest lead, so the top score always reads as a full bar.
          const pct =
            maxScore > 0 ? Math.max(4, Math.min(100, (lead.priorityScore / maxScore) * 100)) : 0;
          const isTop = i === topIndex && maxScore > 0;
          return (
            <div key={lead.id} className={styles.row}>
              <span className={styles.rowStack}>
                <span className={styles.leadName}>{leadName(lead)}</span>
                <span className={styles.leadSub}>{leadSub(lead)}</span>
              </span>
              <span className={styles.rowAside}>
                <StatusBadge tone={lead.isRevealed ? "success" : "muted"}>
                  {lead.outreachStatus}
                </StatusBadge>
                <span className={`${styles.score}${isTop ? ` ${styles.scoreTop}` : ""}`}>
                  <span className={styles.scoreTrack}>
                    <span className={styles.scoreFill} style={{ width: `${pct}%` }} />
                  </span>
                  <span className={styles.scoreNum}>{score}</span>
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </WidgetCard>
  );
}
