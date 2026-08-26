// DataHealthCell.tsx — the derived Data Health cell (list-plan/06 §3.3): a 0–100 score pill plus the
// server-computed freshness band. Read-side and presentational only; the server is the single computer of
// record for both numbers, and nothing here is ever sent back.
//
// It lives in components/ rather than in a feature because two features render it — the list-detail members
// table and the Search people grid ([S-10]: verification recency visible at a glance) — and a feature slice
// may not import another one (lint:cross-feature). Like components/search, this imports nothing from
// features/.
"use client";

import type { ContactDataHealth } from "@leadwolf/types";
import { StatusBadge, type StatusTone, Tooltip } from "@leadwolf/ui";
import styles from "./dataHealth.module.css";

/** freshness_status → tone + label. fresh = good, aging/stale = degrading, expired = needs re-verify. */
const FRESHNESS_BADGE: Record<
  ContactDataHealth["freshnessStatus"],
  { tone: StatusTone; label: string }
> = {
  fresh: { tone: "success", label: "Fresh" },
  aging: { tone: "warning", label: "Aging" },
  stale: { tone: "warning", label: "Stale" },
  expired: { tone: "danger", label: "Expired" },
};

/** The score's dot colour. A band, not a gradient — and never the only carrier of the meaning: the number
 *  itself is right beside it and the band is spelled out in the badge (design: no meaning by colour alone). */
function scoreTone(score: number): string {
  if (score >= 80) return "var(--success)";
  if (score >= 50) return "var(--warning)";
  return "var(--tp-ink-4)";
}

export function DataHealthCell({ health }: { health: ContactDataHealth | undefined }) {
  if (!health) return <span className={styles.empty}>—</span>;
  const badge = FRESHNESS_BADGE[health.freshnessStatus];
  return (
    <span className={styles.healthCell}>
      <Tooltip label={`Data quality ${health.score}/100 · ${badge.label.toLowerCase()}`}>
        <span className={styles.scorePill}>
          <span
            className={styles.scoreDot}
            style={{ background: scoreTone(health.score) }}
            aria-hidden
          />
          {health.score}
        </span>
      </Tooltip>
      <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
    </span>
  );
}
