// SendStatusDashboard.tsx — the "Send status" tab: the per-sequence send funnel. A sequence picker drives a
// row of StatTiles (sent · opened · clicked · replied · bounced) and a proportional funnel (each stage as a
// Progress bar relative to sent, with its rate). Reads the metrics already on the sequence list (no new
// fetch); when the API omits metrics the funnel reads as an honest zero rather than inventing numbers. All
// async chrome via the State Kit. Pure presentation over the sequences the page already loaded.
"use client";

import {
  EmptyState,
  Icon,
  Progress,
  StateSwitch,
  StatTile,
  TpSelect,
} from "@leadwolf/ui";
import { BarChart3 } from "lucide-react";
import { useMemo, useState } from "react";
import styles from "../sequences.module.css";
import {
  EMPTY_METRICS,
  formatPct,
  rate,
  type SequenceMetrics,
  type SequenceSummary,
} from "../types";

const STAGES: Array<{ key: keyof SequenceMetrics; label: string }> = [
  { key: "sent", label: "Sent" },
  { key: "opened", label: "Opened" },
  { key: "clicked", label: "Clicked" },
  { key: "replied", label: "Replied" },
  { key: "bounced", label: "Bounced" },
];

export function SendStatusDashboard({
  sequences,
  loading,
  error,
  onRetry,
}: {
  sequences: SequenceSummary[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string>("");

  const selected = useMemo(
    () => sequences.find((s) => s.id === selectedId) ?? sequences[0] ?? null,
    [sequences, selectedId],
  );

  const metrics = selected?.metrics ?? EMPTY_METRICS;
  const sent = Math.max(1, metrics.sent);

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardHeaderText}>
          <h2 className={styles.cardTitle}>Send status</h2>
          <p className={styles.cardHint}>
            Delivery funnel for a sequence — sent, opened, clicked, replied, and bounced.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={sequences.length === 0}
        emptyState={
          <EmptyState
            icon={<Icon icon={BarChart3} size={28} />}
            title="No send data yet"
            description="Create a sequence and enroll contacts. Once steps start sending, the delivery funnel appears here."
          />
        }
      >
        {selected && (
          <>
            <div className={styles.sendStatusPicker}>
              <TpSelect
                aria-label="Choose a sequence"
                value={selected.id}
                onChange={(e) => setSelectedId(e.target.value)}
              >
                {sequences.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </TpSelect>
            </div>

            <div className={styles.statTiles}>
              {STAGES.map((stage) => (
                <StatTile
                  key={stage.key}
                  label={stage.label}
                  value={metrics[stage.key].toLocaleString()}
                  sublabel={
                    stage.key === "sent"
                      ? `${selected.enrolledCount.toLocaleString()} enrolled`
                      : formatPct(rate(metrics[stage.key], metrics.sent))
                  }
                />
              ))}
            </div>

            <ul className={styles.funnelList}>
              {STAGES.map((stage) => (
                <li key={stage.key} className={styles.funnelStage}>
                  <span className={styles.funnelStageLabel}>{stage.label}</span>
                  <Progress
                    value={metrics[stage.key]}
                    max={sent}
                    tone={stage.key === "bounced" ? "danger" : "ink"}
                    label={`${stage.label} relative to sent`}
                  />
                  <span className={styles.funnelStageValue}>
                    {metrics[stage.key].toLocaleString()}
                    {stage.key !== "sent" && ` · ${formatPct(rate(metrics[stage.key], metrics.sent))}`}
                  </span>
                </li>
              ))}
            </ul>

            <p className={styles.footnote} style={{ marginTop: 16 }}>
              Counts come from the outreach engine. The dedicated analytics pipeline (ClickHouse)
              ships post-MVP; until then the funnel reflects the sequence's send log.
            </p>
          </>
        )}
      </StateSwitch>
    </section>
  );
}
