// AiUsagePage.tsx — the AI-usage cockpit (M14 / 13a Area 14). A read-only cross-tenant view of AI NL-search
// metering: request volume, non-ok outcomes, repair rate, latency + token totals over a selectable window,
// with a per-tenant breakdown. NON-PII — call metadata + counts only (the query text is never stored). Renders
// async state through the State Kit.
"use client";

import { Card, StatTile, StateSwitch, StatusBadge } from "@leadwolf/ui";
import styles from "../aiUsage.module.css";
import { useAiUsage } from "../hooks/useAiUsage";

const WINDOWS = [7, 30, 90] as const;

const fmt = (n: number): string => n.toLocaleString();
const latency = (ms: number | null): string => (ms === null ? "—" : `${Math.round(ms)} ms`);

export function AiUsagePage() {
  const { data, loading, error, days, setDays, reload } = useAiUsage();

  const totals = data
    ? data.tenants.reduce(
        (a, t) => ({
          requests: a.requests + t.requests,
          failures: a.failures + t.failures,
          repairs: a.repairs + t.repairs,
          tokens: a.tokens + t.inputTokens + t.outputTokens,
        }),
        { requests: 0, failures: 0, repairs: 0, tokens: 0 },
      )
    : null;

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">AI usage</h2>
          <p className="tp-page-sub">
            Cross-tenant AI NL-search metering — request volume, outcomes, repair rate and latency
            over the window. Call metadata only; the query text is never stored.
          </p>
        </div>
        <label className={styles.window}>
          <span>Window</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w} days
              </option>
            ))}
          </select>
        </label>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {data && totals ? (
          <>
            <div className="tp-stat-grid">
              <StatTile
                label="Requests"
                value={totals.requests}
                sublabel={`over ${data.windowDays} days`}
              />
              <StatTile
                label="Non-ok outcomes"
                value={totals.failures}
                sublabel="rejected / budget / error"
                trend={
                  totals.failures > 0 ? (
                    <StatusBadge tone="warning">review</StatusBadge>
                  ) : (
                    <StatusBadge tone="success">clear</StatusBadge>
                  )
                }
              />
              <StatTile label="Repairs" value={totals.repairs} sublabel="needed a repair pass" />
              <StatTile label="Tokens" value={totals.tokens} sublabel="in + out" />
            </div>

            <h3 className="tp-section-title">By tenant</h3>
            {data.tenants.length === 0 ? (
              <Card>
                <p className="app-muted">No AI activity in this window.</p>
              </Card>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Tenant</th>
                      <th className={styles.num}>Requests</th>
                      <th className={styles.num}>Non-ok</th>
                      <th className={styles.num}>Repairs</th>
                      <th className={styles.num}>Avg latency</th>
                      <th className={styles.num}>Tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.tenants.map((t) => (
                      <tr key={t.tenantId}>
                        <td>{t.tenantName}</td>
                        <td className={styles.num}>{fmt(t.requests)}</td>
                        <td className={styles.num}>
                          {t.failures > 0 ? (
                            <span className={styles.warn}>{fmt(t.failures)}</span>
                          ) : (
                            "0"
                          )}
                        </td>
                        <td className={styles.num}>{fmt(t.repairs)}</td>
                        <td className={styles.num}>{latency(t.avgLatencyMs)}</td>
                        <td className={styles.num}>{fmt(t.inputTokens + t.outputTokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </StateSwitch>
    </div>
  );
}
