// SystemHealthPage.tsx — the System health view (13 §9): service status tiles + the bulk-enrichment job queue
// (queue depth / dead-letter / per-status breakdown) read from the api `/admin/system-health` surface. The
// queue figures are a bounded sample (the queue-depth/DLQ proxy until a dedicated worker-metrics surface
// exists) — surfaced honestly with a "sampled" note. Renders every async state through the shared State Kit.
"use client";

import { Card, StatTile, StateSwitch, StatusBadge } from "@leadwolf/ui";
import { serviceLabel, serviceTone } from "../format";
import { useSystemHealth } from "../hooks/useSystemHealth";

export function SystemHealthPage() {
  const { health, loading, error, reload } = useSystemHealth();

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">System health</h2>
          <p className="tp-page-sub">Service status and the bulk-enrichment job queue.</p>
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
                label="Sampled jobs"
                value={health.jobs.sampleSize}
                sublabel={health.jobs.truncated ? "Bounded sample (truncated)" : "Bounded sample"}
              />
            </div>

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
