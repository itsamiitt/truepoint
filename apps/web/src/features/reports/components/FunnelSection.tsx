// FunnelSection.tsx — the Pipeline funnel dashboard: contacts per outreach status as a labeled stage list
// with proportional CSS bars + a conversion % per journey stage. The journey stages lead; the off-ramp
// statuses sit in a muted secondary block. StateSwitch handles loading/empty/error. Presentation only.
"use client";

import { EmptyState, Icon, StateSwitch } from "@leadwolf/ui";
import { Filter } from "lucide-react";
import styles from "../reports.module.css";
import type { FunnelRollup, FunnelStage } from "../types";

function StageRow({
  stage,
  max,
  muted,
  showConversion,
}: {
  stage: FunnelStage;
  max: number;
  muted?: boolean;
  showConversion?: boolean;
}) {
  return (
    <li className={styles.barRow}>
      <span className={styles.barLabel}>{stage.label}</span>
      <span className={styles.barTrack}>
        <span
          className={muted ? `${styles.barFill} ${styles.barFillMuted}` : styles.barFill}
          style={{ width: `${(stage.count / max) * 100}%` }}
        />
      </span>
      <span className={styles.barValue}>
        {stage.count.toLocaleString()}
        {showConversion ? <span className={styles.barConv}> · {stage.conversionPct}%</span> : null}
      </span>
    </li>
  );
}

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
            {rollup.total.toLocaleString()} contact{rollup.total === 1 ? "" : "s"} by outreach status
            — conversion measured from the top of the journey.
          </p>
          <ul className={styles.barList}>
            {rollup.primary.map((stage) => (
              <StageRow key={stage.status} stage={stage} max={rollup.maxCount} showConversion />
            ))}
          </ul>

          <div className={styles.secondaryBlock}>
            <p className={styles.secondaryLabel}>Out of the funnel</p>
            <ul className={styles.barList}>
              {rollup.secondary.map((stage) => (
                <StageRow key={stage.status} stage={stage} max={rollup.maxCount} muted />
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </StateSwitch>
  );
}
