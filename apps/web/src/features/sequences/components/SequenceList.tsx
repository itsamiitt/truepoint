// SequenceList.tsx — the sequence list on the shared DataTable: name, status (StatusBadge), enrolled count,
// and a compact send funnel (sent · open% · reply%) per row, plus a pause/resume action and a row click that
// opens the enrollment detail. All async chrome (loading skeleton, error+retry, empty) renders through the
// State Kit's <StateSwitch> so it matches every other surface. Pure presentation; data arrives via the page.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  Icon,
  Progress,
  StateSwitch,
  StatusBadge,
  TpButton,
} from "@leadwolf/ui";
import { ListPlus, Pause, Play } from "lucide-react";
import styles from "../sequences.module.css";
import {
  EMPTY_METRICS,
  formatPct,
  rate,
  SEQUENCE_STATUS_LABEL,
  SEQUENCE_STATUS_TONE,
  type SequenceSummary,
} from "../types";

export function SequenceList({
  sequences,
  loading,
  error,
  onRetry,
  onSelect,
  onCreate,
  onSetStatus,
  pendingId,
}: {
  sequences: SequenceSummary[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onSelect: (s: SequenceSummary) => void;
  onCreate: () => void;
  onSetStatus: (s: SequenceSummary) => void;
  pendingId: string | null;
}) {
  const columns: Column<SequenceSummary>[] = [
    {
      key: "name",
      header: "Sequence",
      sortValue: (s) => s.name.toLowerCase(),
      cell: (s) => (
        <div className={styles.seqName}>
          <span className={styles.seqNameMain}>{s.name}</span>
          <span className={styles.seqNameSub}>
            {s.stepCount} step{s.stepCount === 1 ? "" : "s"}
          </span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortValue: (s) => s.status,
      cell: (s) => (
        <StatusBadge tone={SEQUENCE_STATUS_TONE[s.status]}>
          {SEQUENCE_STATUS_LABEL[s.status]}
        </StatusBadge>
      ),
    },
    {
      key: "enrolled",
      header: "Enrolled",
      align: "right",
      sortValue: (s) => s.enrolledCount,
      cell: (s) => <span className={styles.numCell}>{s.enrolledCount.toLocaleString()}</span>,
    },
    {
      key: "sent",
      header: "Sent",
      align: "right",
      sortValue: (s) => (s.metrics ?? EMPTY_METRICS).sent,
      cell: (s) => (
        <span className={styles.numCell}>{(s.metrics ?? EMPTY_METRICS).sent.toLocaleString()}</span>
      ),
    },
    {
      key: "engagement",
      header: "Open / Reply",
      sortValue: (s) => {
        const m = s.metrics ?? EMPTY_METRICS;
        return rate(m.replied, m.sent);
      },
      cell: (s) => {
        const m = s.metrics ?? EMPTY_METRICS;
        const openRate = rate(m.opened, m.sent);
        const replyRate = rate(m.replied, m.sent);
        return (
          <div className={styles.funnelCell}>
            <div className={styles.funnelTop}>
              <span className={styles.funnelTopValue}>{formatPct(openRate)}</span>
              <span className={styles.funnelTopMuted}>open</span>
            </div>
            <Progress value={m.opened} max={Math.max(1, m.sent)} label="Open rate" />
            <div className={styles.funnelTop}>
              <span className={styles.funnelTopValue}>{formatPct(replyRate)}</span>
              <span className={styles.funnelTopMuted}>reply</span>
            </div>
          </div>
        );
      },
    },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (s) => {
        if (s.status === "archived") return null;
        const paused = s.status === "paused";
        return (
          <div className={styles.rowActions}>
            <TpButton
              variant="secondary"
              size="sm"
              loading={pendingId === s.id}
              leftIcon={<Icon icon={paused ? Play : Pause} size={14} />}
              onClick={(e) => {
                e.stopPropagation();
                onSetStatus(s);
              }}
            >
              {paused ? "Resume" : "Pause"}
            </TpButton>
          </div>
        );
      },
    },
  ];

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardHeaderText}>
          <h2 className={styles.cardTitle}>Your sequences</h2>
          <p className={styles.cardHint}>Select a sequence to enroll contacts and send steps.</p>
        </div>
        <TpButton
          variant="primary"
          size="sm"
          leftIcon={<Icon icon={ListPlus} size={14} />}
          onClick={onCreate}
        >
          New sequence
        </TpButton>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={sequences.length === 0}
        emptyState={
          <EmptyState
            icon={<Icon icon={ListPlus} size={28} />}
            title="No sequences yet"
            description="A sequence is an ordered set of outreach steps. Once it exists you enroll revealed contacts, and every send passes the suppression and CAN-SPAM gates."
            action={
              <TpButton variant="primary" size="sm" onClick={onCreate}>
                Create your first sequence
              </TpButton>
            }
          />
        }
      >
        <DataTable
          columns={columns}
          rows={sequences}
          rowKey={(s) => s.id}
          onRowClick={onSelect}
        />
      </StateSwitch>
    </section>
  );
}
