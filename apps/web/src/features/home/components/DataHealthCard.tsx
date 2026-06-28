// DataHealthCard.tsx — the per-workspace Data Health summary (10 §5 / 22): coverage + deliverability + freshness
// rates over the workspace's contacts, from GET /home/data-quality (counts only — no PII). All four async states
// render through the shared WidgetCard → StateSwitch. Props-driven (HomePage supplies the data via
// useDataQuality), mirroring the other cockpit cards. Public slice component.
"use client";

import { StatusBadge, type StatusTone } from "@leadwolf/ui";
import { HeartPulse } from "lucide-react";
import type { WorkspaceDataQuality } from "../types";
import styles from "./HomePage.module.css";
import { WidgetCard } from "./WidgetCard";

const rate = (numerator: number, denominator: number): number =>
  denominator > 0 ? numerator / denominator : 0;

function toneFor(r: number): StatusTone {
  if (r >= 0.8) return "success";
  if (r >= 0.5) return "warning";
  return "danger";
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

export function DataHealthCard({
  metrics,
  loading,
  error,
  onRetry,
}: {
  metrics: WorkspaceDataQuality | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}) {
  const total = metrics?.total ?? 0;
  const rows = metrics
    ? [
        {
          key: "email",
          label: "Email coverage",
          sub: `${metrics.withEmail.toLocaleString()} of ${total.toLocaleString()} contacts`,
          r: rate(metrics.withEmail, total),
        },
        {
          key: "deliverable",
          label: "Email deliverable",
          sub: `${metrics.emailValid.toLocaleString()} valid of ${metrics.withEmail.toLocaleString()} with email`,
          r: rate(metrics.emailValid, metrics.withEmail),
        },
        {
          key: "phone",
          label: "Phone coverage",
          sub: `${metrics.withPhone.toLocaleString()} of ${total.toLocaleString()} contacts`,
          r: rate(metrics.withPhone, total),
        },
        {
          key: "fresh",
          label: "Freshness",
          sub: `${metrics.fresh.toLocaleString()} verified within SLA`,
          r: rate(metrics.fresh, total),
        },
      ]
    : [];

  return (
    <WidgetCard
      title="Data health"
      icon={HeartPulse}
      hint={total > 0 ? `${total.toLocaleString()} contacts` : undefined}
      loading={loading}
      error={error}
      empty={total === 0}
      onRetry={onRetry}
      emptyIcon={HeartPulse}
      emptyTitle="No contacts yet"
      emptyDescription="Import or reveal contacts and their coverage, deliverability, and freshness appear here."
    >
      <div className={styles.list}>
        {rows.map((row) => (
          <div key={row.key} className={styles.row}>
            <span className={styles.rowStack}>
              <span className={styles.leadName}>{row.label}</span>
              <span className={styles.leadSub}>{row.sub}</span>
            </span>
            <span className={styles.rowAside}>
              <StatusBadge tone={toneFor(row.r)}>{pct(row.r)}</StatusBadge>
            </span>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}
