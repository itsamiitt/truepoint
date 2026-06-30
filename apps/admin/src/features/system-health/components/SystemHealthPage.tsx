// SystemHealthPage.tsx — the System health view (13 §9): service status tiles + a sampled bulk-enrichment job
// tally (queue depth / dead-letter / SUCCESS RATE / per-status) AND the LIVE per-queue BullMQ probe the api
// reads off Redis (depth / dead-letter / connected workers / SATURATION). The sampled figures carry a
// "sampled" note; an unreachable live queue shows reachable:false honestly (never a fabricated zero). Renders
// every async state through the shared State Kit.
"use client";

import { Card, type Column, DataTable, StatTile, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { serviceLabel, serviceTone } from "../format";
import { useSystemHealth } from "../hooks/useSystemHealth";
import type { QueueReport } from "../types";

/** active jobs per connected worker — a saturation proxy (high → the queue is backing up on its workers). */
function saturation(q: QueueReport): string {
  if (!q.reachable || q.active == null) return "—";
  const w = q.workers ?? 0;
  if (w > 0) return `${(q.active / w).toFixed(1)}×`;
  return q.active > 0 ? "∞" : "0×";
}

function num(n: number | null): string {
  return n == null ? "—" : n.toLocaleString();
}

export function SystemHealthPage() {
  const { health, loading, error, reload } = useSystemHealth();

  // Success rate from the sampled tally: of jobs that reached a terminal state, the share that completed.
  const byStatus = health?.jobs.byStatus ?? {};
  const completed = byStatus.completed ?? 0;
  const failedJobs = byStatus.failed ?? 0;
  const terminal = completed + failedJobs;
  const successRate = terminal > 0 ? Math.round((completed / terminal) * 100) : null;
  const successTone =
    successRate == null
      ? "muted"
      : successRate >= 95
        ? "success"
        : successRate >= 80
          ? "warning"
          : "danger";

  const queueColumns: Column<QueueReport>[] = [
    {
      key: "name",
      header: "Queue",
      sortValue: (q) => q.name,
      cell: (q) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{q.name}</span>,
    },
    {
      key: "reachable",
      header: "Status",
      sortValue: (q) => (q.reachable ? 0 : 1),
      cell: (q) => (
        <StatusBadge tone={q.reachable ? "success" : "danger"}>
          {q.reachable ? "reachable" : "unreachable"}
        </StatusBadge>
      ),
    },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      sortValue: (q) => q.waiting ?? -1,
      cell: (q) => num(q.waiting),
    },
    {
      key: "active",
      header: "Active",
      align: "right",
      sortValue: (q) => q.active ?? -1,
      cell: (q) => num(q.active),
    },
    {
      key: "delayed",
      header: "Delayed",
      align: "right",
      sortValue: (q) => q.delayed ?? -1,
      cell: (q) => num(q.delayed),
    },
    {
      key: "failed",
      header: "DLQ",
      align: "right",
      sortValue: (q) => q.failed ?? -1,
      cell: (q) => (
        <span style={{ color: (q.failed ?? 0) > 0 ? "var(--danger)" : undefined }}>
          {num(q.failed)}
        </span>
      ),
    },
    {
      key: "workers",
      header: "Workers",
      align: "right",
      sortValue: (q) => q.workers ?? -1,
      cell: (q) => num(q.workers),
    },
    {
      key: "saturation",
      header: "Saturation",
      align: "right",
      // Match the displayed value's ordering: a reachable queue with active work but ZERO workers is "∞"
      // (max saturation) and must sort LAST, not first. Unreachable → -1 (sorts before any real reading).
      sortValue: (q) => {
        if (!q.reachable || q.active == null) return -1;
        const w = q.workers ?? 0;
        return w > 0 ? q.active / w : q.active > 0 ? Number.POSITIVE_INFINITY : 0;
      },
      cell: (q) => saturation(q),
    },
  ];

  const queues = health?.queues ?? [];

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">System health</h2>
          <p className="tp-page-sub">
            Service status, the live job queues, and the bulk-enrichment job sample.
          </p>
        </div>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {health ? (
          <>
            <h3 className="tp-section-title">Services</h3>
            <div className="tp-stat-grid">
              {health.services.map((s) => (
                <StatTile
                  key={s.name}
                  label={serviceLabel(s.name)}
                  value={<StatusBadge tone={serviceTone(s.status)}>{s.status}</StatusBadge>}
                />
              ))}
            </div>

            <h3 className="tp-section-title">Enrichment job queue</h3>
            <div className="tp-stat-grid">
              <StatTile
                label="Queue depth"
                value={health.jobs.queueDepth}
                sublabel="Queued · estimating · running"
              />
              <StatTile
                label="Dead-letter"
                value={health.jobs.deadLetter}
                sublabel="Failed jobs"
                trend={
                  health.jobs.deadLetter > 0 ? (
                    <StatusBadge tone="danger">attention</StatusBadge>
                  ) : (
                    <StatusBadge tone="success">clear</StatusBadge>
                  )
                }
              />
              <StatTile
                label="Success rate"
                value={successRate == null ? "—" : `${successRate}%`}
                sublabel="Completed vs failed (sample)"
                trend={
                  <StatusBadge tone={successTone}>
                    {successRate == null
                      ? "no data"
                      : successTone === "success"
                        ? "healthy"
                        : successTone === "warning"
                          ? "watch"
                          : "low"}
                  </StatusBadge>
                }
              />
              <StatTile
                label="Sampled jobs"
                value={health.jobs.sampleSize}
                sublabel={health.jobs.truncated ? "Bounded sample (truncated)" : "Bounded sample"}
              />
            </div>

            <h3 className="tp-section-title">Live queues</h3>
            {queues.length === 0 ? (
              <Card>
                <p className="app-muted">No live queue readings (Redis unreachable).</p>
              </Card>
            ) : (
              <DataTable columns={queueColumns} rows={queues} rowKey={(q) => q.name} />
            )}

            <Card>
              <h3 className="tp-section-title" style={{ marginBottom: 10 }}>
                By status
              </h3>
              {Object.keys(health.jobs.byStatus).length === 0 ? (
                <p className="app-muted">No jobs in the current sample.</p>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {Object.entries(health.jobs.byStatus).map(([status, n]) => (
                    <StatusBadge key={status}>
                      {status}: {n}
                    </StatusBadge>
                  ))}
                </div>
              )}
            </Card>
          </>
        ) : null}
      </StateSwitch>
    </div>
  );
}
