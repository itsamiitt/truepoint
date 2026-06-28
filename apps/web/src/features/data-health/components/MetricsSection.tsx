// MetricsSection.tsx — the headline Data Health KPIs for the Overview tab: total contacts + the three workspace
// rates the rollup supports (email coverage, email deliverable, freshness). The per-contact COMPOSITE quality
// score (data_quality_score, 22 §2) is NOT in WorkspaceDataQuality (a counts-only rollup), so it is OUT OF SCOPE
// here — we surface the coverage / deliverability / freshness the DTO actually carries. Four states via StateSwitch.
"use client";

import { EmptyState, Icon, Skeleton, StatTile, StateSwitch } from "@leadwolf/ui";
import { HeartPulse } from "lucide-react";
import type { CSSProperties } from "react";
import styles from "../data-health.module.css";
import type { WorkspaceDataQuality } from "../types";

const KPI_CARD: CSSProperties = {
  background: "var(--tp-surface)",
  border: "1px solid var(--tp-hairline-2)",
  borderRadius: "var(--tp-radius-card)",
  boxShadow: "var(--tp-shadow-card)",
};

const rate = (n: number, d: number): number => (d > 0 ? n / d : 0);
const pct = (r: number): string => `${Math.round(r * 100)}%`;

export function MetricsSection({
  metrics,
  loading,
  error,
  onRetry,
}: {
  metrics: WorkspaceDataQuality | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const total = metrics?.total ?? 0;
  return (
    <StateSwitch
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && total === 0}
      skeleton={
        <div className={styles.tiles}>
          {["total", "coverage", "deliverable", "freshness"].map((k) => (
            <Skeleton key={k} height={104} radius="var(--tp-radius-card)" />
          ))}
        </div>
      }
      emptyState={
        <EmptyState
          icon={<Icon icon={HeartPulse} size={28} />}
          title="No contacts yet"
          description="Import or reveal contacts and their coverage, deliverability, and freshness appear here."
        />
      }
    >
      {metrics ? (
        <div className={styles.tiles}>
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Total contacts</span>}
            value={total.toLocaleString()}
            sublabel="Live contacts in this workspace"
          />
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Email coverage</span>}
            value={pct(rate(metrics.withEmail, total))}
            sublabel={`${metrics.withEmail.toLocaleString()} of ${total.toLocaleString()} with an email`}
          />
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Email deliverable</span>}
            value={pct(rate(metrics.emailValid, metrics.withEmail))}
            sublabel={`${metrics.emailValid.toLocaleString()} valid of ${metrics.withEmail.toLocaleString()} with email`}
          />
          <StatTile
            style={KPI_CARD}
            label={<span className={styles.kpiLabel}>Freshness</span>}
            value={pct(rate(metrics.fresh, total))}
            sublabel={`${metrics.fresh.toLocaleString()} verified within SLA`}
          />
        </div>
      ) : null}
    </StateSwitch>
  );
}
