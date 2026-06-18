// FunnelSection.tsx — the Pipeline funnel dashboard: contacts per outreach status, drawn as an on-brand SVG
// FunnelChart for the journey (new → in_sequence → replied → meeting_booked) and a monochrome BarChart for the
// off-ramps, each paired with a screen-reader-friendly exact-figures list. StateSwitch handles
// loading/empty/error. Presentation only.
"use client";

import { EmptyState, Icon, StateSwitch } from "@leadwolf/ui";
import { Filter } from "lucide-react";
import { BarChart, FunnelChart } from "../charts";
import styles from "../reports.module.css";
import type { FunnelRollup } from "../types";

export function FunnelSection({
  rollup,
  loading,
  error,
  onRetry,
}: {
  rollup: FunnelRollup | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <StateSwitch
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && (rollup?.total ?? 0) === 0}
      emptyState={
        <EmptyState
          icon={<Icon icon={Filter} size={28} />}
          title="No contacts yet"
          description="Import a CSV or prospect to start filling the pipeline. Stage counts and conversion appear here as contacts move through outreach."
        />
      }
    >
      {rollup ? (
        <>
          <p className={styles.cardHint}>
            {rollup.total.toLocaleString()} contact{rollup.total === 1 ? "" : "s"} by outreach
            status — conversion measured from the top of the journey.
          </p>

          <div className={styles.chartBlock}>
            <FunnelChart
              data={rollup.primary.map((s) => ({
                key: s.status,
                label: s.label,
                count: s.count,
                conversionPct: s.conversionPct,
              }))}
              max={rollup.maxCount}
              ariaLabel="Pipeline journey funnel"
            />
          </div>
          <ul className={styles.figureList}>
            {rollup.primary.map((stage) => (
              <li key={stage.status} className={styles.figureRow}>
                <span className={styles.figureLabel}>{stage.label}</span>
                <span className={styles.figureValue}>
                  {stage.count.toLocaleString()}
                  <span className={styles.barConv}> · {stage.conversionPct}%</span>
                </span>
              </li>
            ))}
          </ul>

          <div className={styles.secondaryBlock}>
            <p className={styles.secondaryLabel}>Out of the funnel</p>
            <div className={styles.chartBlock}>
              <BarChart
                data={rollup.secondary.map((s) => ({
                  key: s.status,
                  label: s.label,
                  value: s.count,
                  muted: true,
                }))}
                max={rollup.maxCount}
                ariaLabel="Out-of-funnel statuses"
              />
            </div>
          </div>
        </>
      ) : null}
    </StateSwitch>
  );
}
