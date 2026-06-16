// RecentRevealsCard.tsx — the most recent reveals in this workspace: reveal-type badge, date, and credits
// consumed. Pure presentation over HomeSummary.recentReveals (extracted from the cockpit shell).
"use client";

import { Card, Spinner, StatusBadge, type StatusTone } from "@leadwolf/ui";
import type { RecentReveal } from "../types";
import styles from "./HomePage.module.css";
import { formatDate } from "./format";

const REVEAL_LABEL: Record<RecentReveal["revealType"], string> = {
  email: "Email",
  phone: "Phone",
  full_profile: "Full profile",
};

const REVEAL_TONE: Record<RecentReveal["revealType"], StatusTone> = {
  email: "success",
  phone: "warning",
  full_profile: "muted",
};

export function RecentRevealsCard({
  reveals,
  loading,
  error,
}: {
  reveals: RecentReveal[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Recent reveals</h2>
      </div>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading recent reveals…
        </div>
      ) : reveals.length === 0 ? (
        <p className={styles.muted}>
          No reveals yet. Reveal a verified email or phone from Prospect and it will show up here.
        </p>
      ) : (
        <div className={styles.list}>
          {reveals.map((r) => (
            <div key={r.id} className={styles.row}>
              <span className={styles.rowMain}>
                <StatusBadge tone={REVEAL_TONE[r.revealType]}>
                  {REVEAL_LABEL[r.revealType]}
                </StatusBadge>
                <span className={styles.rowMeta}>{formatDate(r.revealedAt)}</span>
              </span>
              <span className={styles.mono}>
                −{r.creditsConsumed} credit{r.creditsConsumed === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
