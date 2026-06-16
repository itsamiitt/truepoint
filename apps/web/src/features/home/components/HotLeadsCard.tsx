// HotLeadsCard.tsx — top-priority leads for this workspace (facets only — no PII; see home.ts). Each row
// shows name + title/domain, an outreach-status badge, and the priority score. Calm empty/loading/error.
"use client";

import { Card, Spinner, StatusBadge } from "@leadwolf/ui";
import type { HotLead } from "../types";
import styles from "./HomePage.module.css";

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
}: {
  leads: HotLead[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Hot leads</h2>
      </div>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading hot leads…
        </div>
      ) : leads.length === 0 ? (
        <p className={styles.muted}>
          No prioritized leads yet. Reveal or score contacts and the highest-priority ones surface
          here.
        </p>
      ) : (
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
      )}
    </Card>
  );
}
