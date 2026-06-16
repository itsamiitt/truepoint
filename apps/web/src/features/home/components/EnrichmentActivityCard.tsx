// EnrichmentActivityCard.tsx — recent enrichment-provider calls: provider name, a cache-hit/live tag, an
// outcome status badge, and when it ran. Pure presentation over HomeSummary.enrichmentActivity.
"use client";

import { Card, Spinner, StatusBadge, type StatusTone } from "@leadwolf/ui";
import type { EnrichmentActivity } from "../types";
import styles from "./HomePage.module.css";
import { formatRelative } from "./format";

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
}: {
  activity: EnrichmentActivity[];
  loading: boolean;
  error: string | null;
}) {
  return (
    <Card>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardTitle}>Enrichment activity</h2>
      </div>
      {error ? (
        <p className={styles.error}>{error}</p>
      ) : loading ? (
        <div className={styles.loadingRow}>
          <Spinner /> Loading enrichment activity…
        </div>
      ) : activity.length === 0 ? (
        <p className={styles.muted}>No enrichment calls yet in this workspace.</p>
      ) : (
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
      )}
    </Card>
  );
}
