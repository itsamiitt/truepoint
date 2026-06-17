// DataHealthSection.tsx — the Data health dashboard: deliverable-rate / coverage / staleness Progress bars
// over the top, then contacts per email verification status (StatusBadge tones — the one place this page earns
// color) with a per-status Progress share. StateSwitch handles loading/empty/error. Presentation only.
"use client";

import { EmptyState, Icon, Progress, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { ShieldCheck } from "lucide-react";
import styles from "../reports.module.css";
import type { DataHealthRollup } from "../types";

function RateBar({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: "ink" | "success" | "warning";
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className={styles.rate}>
      <div className={styles.rateHead}>
        <span className={styles.rateLabel}>{label}</span>
        <span className={styles.rateValue}>{pct}%</span>
      </div>
      <Progress value={value} max={total || 1} tone={tone} label={label} />
      <span className={styles.rateSub}>
        {value.toLocaleString()} of {total.toLocaleString()} contact{total === 1 ? "" : "s"}
      </span>
    </div>
  );
}

export function DataHealthSection({
  rollup,
  loading,
  error,
  onRetry,
}: {
  rollup: DataHealthRollup | null;
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
          icon={<Icon icon={ShieldCheck} size={28} />}
          title="No contacts yet"
          description="Email deliverability and coverage appear once contacts are in the workspace."
        />
      }
    >
      {rollup ? (
        <>
          <div className={styles.rates}>
            <RateBar label="Deliverable" value={rollup.valid} total={rollup.total} tone="success" />
            <RateBar
              label="Email coverage"
              value={rollup.withEmail}
              total={rollup.total}
              tone="ink"
            />
            <RateBar
              label="Unverified"
              value={rollup.unverified}
              total={rollup.total}
              tone="warning"
            />
          </div>

          <h3 className={styles.subheading}>Verification breakdown</h3>
          <ul className={styles.healthList}>
            {rollup.rows.map((row) => (
              <li key={row.status} className={styles.healthRow}>
                <span className={styles.healthBadge}>
                  <StatusBadge tone={row.tone}>{row.label}</StatusBadge>
                </span>
                <span className={styles.healthTrack}>
                  <Progress value={row.count} max={rollup.total || 1} label={row.label} />
                </span>
                <span className={styles.healthCount}>
                  {row.count.toLocaleString()} · {row.pct}%
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </StateSwitch>
  );
}
