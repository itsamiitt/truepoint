// TrustAbusePage.tsx — the Trust & abuse cockpit (P6; 13 §3 abuse-ops). A read-only platform view over signals
// we already own: signup velocity (tenants/users), a free/disposable-email heuristic, the active account holds
// by kind, and the tenant-status mix. NON-PII — counts only. Renders async state through the State Kit.
"use client";

import { Card, StatTile, StateSwitch, StatusBadge, type StatusTone } from "@leadwolf/ui";
import { useTrustAbuse } from "../hooks/useTrustAbuse";

function statusTone(status: string): StatusTone {
  if (status === "active") return "success";
  if (status === "suspended") return "danger";
  if (status === "pending") return "warning";
  return "muted";
}

export function TrustAbusePage() {
  const { data, loading, error, reload } = useTrustAbuse();

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Trust & abuse</h2>
          <p className="tp-page-sub">
            Cross-tenant abuse signals — signup velocity, non-business email signups, active holds
            and the tenant-status mix. Counts only; no identities are shown.
          </p>
        </div>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {data ? (
          <>
            <h3 className="tp-section-title">Signups</h3>
            <div className="tp-stat-grid">
              <StatTile
                label="New tenants (7d)"
                value={data.signals.tenants.d7}
                sublabel={`today ${data.signals.tenants.d1} · 30d ${data.signals.tenants.d30} · total ${data.signals.tenants.total}`}
              />
              <StatTile
                label="New users (7d)"
                value={data.signals.users.d7}
                sublabel={`today ${data.signals.users.d1} · 30d ${data.signals.users.d30} · total ${data.signals.users.total}`}
              />
              <StatTile
                label="Free / disposable email (30d)"
                value={data.signals.freeEmailSignups30d}
                sublabel="Heuristic — staff triage"
                trend={
                  data.signals.freeEmailSignups30d > 0 ? (
                    <StatusBadge tone="warning">review</StatusBadge>
                  ) : (
                    <StatusBadge tone="success">clear</StatusBadge>
                  )
                }
              />
            </div>

            <h3 className="tp-section-title">Active account holds</h3>
            {data.holds.length === 0 ? (
              <Card>
                <p className="app-muted">No active holds across the platform.</p>
              </Card>
            ) : (
              <div className="tp-stat-grid">
                {data.holds.map((h) => (
                  <StatTile
                    key={h.key}
                    label={h.key}
                    value={h.count}
                    sublabel="active holds"
                    trend={<StatusBadge tone="danger">held</StatusBadge>}
                  />
                ))}
              </div>
            )}

            <h3 className="tp-section-title">Tenant status</h3>
            <div className="tp-stat-grid">
              {data.tenantStatus.map((t) => (
                <StatTile
                  key={t.key}
                  label={t.key}
                  value={t.count}
                  sublabel="tenants"
                  trend={<StatusBadge tone={statusTone(t.key)}>{t.key}</StatusBadge>}
                />
              ))}
            </div>
          </>
        ) : null}
      </StateSwitch>
    </div>
  );
}
