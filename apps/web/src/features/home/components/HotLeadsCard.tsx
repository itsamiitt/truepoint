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
        {leads.map((lead) => (
          <div key={lead.id} className={styles.row}>
            <span className={styles.rowStack}>
              <span className={styles.leadName}>{leadName(lead)}</span>
              <span className={styles.leadSub}>{leadSub(lead)}</span>
            </span>
            <span className={styles.rowAside}>
              <StatusBadge tone={lead.isRevealed ? "success" : "muted"}>
                {lead.outreachStatus}
              </StatusBadge>
              <span className={styles.score}>{Math.round(lead.priorityScore)}</span>
            </span>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}
