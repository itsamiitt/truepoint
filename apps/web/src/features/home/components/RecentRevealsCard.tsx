// RecentRevealsCard.tsx — the most recent reveals in this workspace: a reveal-type badge, relative time, and
// the credits consumed. Pure presentation over HomeSummary.recentReveals; all four async states render
// through the shared WidgetCard → StateSwitch. Public slice component.
"use client";

import { StatusBadge, type StatusTone } from "@leadwolf/ui";
import { Sparkles } from "lucide-react";
import type { RecentReveal } from "../types";
import { formatRelative } from "./format";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

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
  onRetry,
}: {
  reveals: RecentReveal[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <WidgetCard
      title="Recent reveals"
      icon={Sparkles}
      loading={loading}
      error={error}
      empty={reveals.length === 0}
      onRetry={onRetry}
      emptyIcon={Sparkles}
      emptyTitle="No reveals yet"
      emptyDescription="Reveal a verified email or phone from Prospect and it will show up here."
    >
      <div className={styles.list}>
        {reveals.map((r) => (
          <div key={r.id} className={styles.row}>
            <span className={styles.rowMain}>
              <StatusBadge tone={REVEAL_TONE[r.revealType]}>
                {REVEAL_LABEL[r.revealType]}
              </StatusBadge>
              <span className={styles.rowMeta}>{formatRelative(r.revealedAt)}</span>
            </span>
            <span className={styles.mono}>
              −{r.creditsConsumed} credit{r.creditsConsumed === 1 ? "" : "s"}
            </span>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}
