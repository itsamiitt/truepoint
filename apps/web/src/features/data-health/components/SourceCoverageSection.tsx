// SourceCoverageSection.tsx — the multi-source COVERAGE KPI for the Overview tab (data-management #8): the share of
// contacts whose fields come from 2+ distinct data sources. Sourced from the LATEST daily snapshot (the periodic
// field_provenance scan is too heavy for the live rollup), so it reads the trend series, not the live metrics.
// A COVERAGE proxy — NOT a true "sources disagree" conflict rate. Four states via StateSwitch.
"use client";

import { EmptyState, Icon, Skeleton, StatTile, StateSwitch } from "@leadwolf/ui";
import { Layers } from "lucide-react";
import type { CSSProperties } from "react";
import styles from "../data-health.module.css";
import type { DataQualityTrendPoint } from "../types";

const KPI_CARD: CSSProperties = {
  background: "var(--tp-surface)",
  border: "1px solid var(--tp-hairline-2)",
  borderRadius: "var(--tp-radius-card)",
  boxShadow: "var(--tp-shadow-card)",
};

const pct = (n: number, d: number): string => `${d > 0 ? Math.round((n / d) * 100) : 0}%`;

export function SourceCoverageSection({
  trend,
  loading,
  error,
  onRetry,
}: {
  trend: DataQualityTrendPoint[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const latest = trend?.[0]?.metrics;
  const multi = latest?.multiSourceContacts;
  const total = latest?.total ?? 0;
  // Empty when there is no snapshot yet OR the latest snapshot predates this metric (older rows omit it).
  const noData = multi === undefined || total === 0;
  return (
    <StateSwitch
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && noData}
      skeleton={
        <div className={styles.tiles}>
          <Skeleton height={104} radius="var(--tp-radius-card)" />
        </div>
      }
      emptyState={
        <EmptyState
          icon={<Icon icon={Layers} size={28} />}
          title="Computed daily"
          description="The share of contacts built from 2+ data sources appears here after the next daily snapshot."
        />
      }
    >
      <div className={styles.tiles}>
        <StatTile
          style={KPI_CARD}
          label={<span className={styles.kpiLabel}>Multi-source coverage</span>}
          value={pct(multi ?? 0, total)}
          sublabel={`${(multi ?? 0).toLocaleString()} of ${total.toLocaleString()} contacts built from 2+ sources · updated daily`}
        />
      </div>
    </StateSwitch>
  );
}
