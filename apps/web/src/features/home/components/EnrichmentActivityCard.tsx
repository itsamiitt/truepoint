// EnrichmentActivityCard.tsx — recent enrichment-provider calls: provider name, a cache-hit/live tag, an
// outcome status badge, and when it ran. Pure presentation over HomeSummary.enrichmentActivity; all four
// async states render through the shared WidgetCard → StateSwitch. Public slice component.
"use client";

import { StatusBadge, type StatusTone } from "@leadwolf/ui";
import { Database } from "lucide-react";
import type { EnrichmentActivity } from "../types";
import { formatRelative } from "./format";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

/** Map a provider call status to a monochrome-system tone (only the badge earns color). */
function statusTone(status: string): StatusTone {
  const s = status.toLowerCase();
  if (s === "ok" || s === "success" || s === "hit") return "success";
  if (s === "error" || s === "failed" || s === "failure") return "danger";
  if (s === "miss" || s === "empty" || s === "not_found") return "warning";
  return "muted";
}

export function EnrichmentActivityCard({
  activity,
  loading,
  error,
  onRetry,
}: {
  activity: EnrichmentActivity[];
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  return (
    <WidgetCard
      title="Enrichment activity"
      icon={Database}
      loading={loading}
      error={error}
      empty={activity.length === 0}
      onRetry={onRetry}
      emptyIcon={Database}
      emptyTitle="No enrichment calls yet"
      emptyDescription="Provider lookups run as you reveal and enrich contacts — their outcomes appear here."
    >
      <div className={styles.list}>
        {activity.map((a, i) => (
          <div key={`${a.providerName}-${a.calledAt}-${i}`} className={styles.row}>
            <span className={styles.rowStack}>
              <span className={styles.rowLabel}>{a.providerName}</span>
              <span className={styles.rowMeta}>
                {a.cacheHit ? "Cache hit" : "Live"} · {formatRelative(a.calledAt)}
              </span>
            </span>
            <span className={styles.rowAside}>
              <StatusBadge tone={statusTone(a.status)}>{a.status}</StatusBadge>
            </span>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}
