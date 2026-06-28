// PerFieldFill.tsx — per-field coverage for the Overview tab: a responsive grid of coverage cards, one per
// expected contact field the rollup COUNTS (name / email / phone / title / company / LinkedIn / location), each a
// label + fill % + Progress bar + "N of M". Derived ONLY from WorkspaceDataQuality `with*` counts — no invented
// fields. Four async states via StateSwitch (empty when the workspace has no contacts yet).
"use client";

import { EmptyState, Icon, Progress, StateSwitch } from "@leadwolf/ui";
import { Columns3 } from "lucide-react";
import styles from "../data-health.module.css";
import type { WorkspaceDataQuality } from "../types";

interface FieldRow {
  key: string;
  label: string;
  count: number;
}

function fieldRows(m: WorkspaceDataQuality): FieldRow[] {
  return [
    { key: "name", label: "Name", count: m.withName },
    { key: "email", label: "Email", count: m.withEmail },
    { key: "phone", label: "Phone", count: m.withPhone },
    { key: "title", label: "Title", count: m.withTitle },
    { key: "company", label: "Company", count: m.withCompany },
    { key: "linkedin", label: "LinkedIn", count: m.withLinkedin },
    { key: "location", label: "Location", count: m.withLocation },
  ];
}

function FieldCard({ label, count, total }: { label: string; count: number; total: number }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className={styles.rate}>
      <div className={styles.rateHead}>
        <span className={styles.rateLabel}>{label}</span>
        <span className={styles.rateValue}>{pct}%</span>
      </div>
      <Progress value={count} max={total || 1} label={`${label} coverage`} />
      <span className={styles.rateSub}>
        {count.toLocaleString()} of {total.toLocaleString()} contact{total === 1 ? "" : "s"}
      </span>
    </div>
  );
}

export function PerFieldFill({
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
      emptyState={
        <EmptyState
          icon={<Icon icon={Columns3} size={28} />}
          title="No contacts yet"
          description="Per-field coverage appears once contacts are in this workspace."
        />
      }
    >
      {metrics ? (
        <div className={styles.fieldGrid}>
          {fieldRows(metrics).map((f) => (
            <FieldCard key={f.key} label={f.label} count={f.count} total={total} />
          ))}
        </div>
      ) : null}
    </StateSwitch>
  );
}
