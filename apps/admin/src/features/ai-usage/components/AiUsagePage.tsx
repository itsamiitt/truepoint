// AiUsagePage.tsx — the AI-usage cockpit (M14 / 13a Area 14). A read-only cross-tenant view of AI NL-search
// metering: request volume, non-ok outcomes, repair rate, latency + token totals over a selectable window,
// with a per-tenant breakdown. NON-PII — call metadata + counts only (the query text is never stored). Renders
// async state through the State Kit.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  PageContainer,
  PageHeader,
  StatTile,
  StateSwitch,
  StatusBadge,
  TpSelect,
} from "@leadwolf/ui";
import type { ReactNode } from "react";
import { useAiUsage } from "../hooks/useAiUsage";
import type { AiUsageTenant } from "../types";

const WINDOWS = [7, 30, 90] as const;

const fmt = (n: number): string => n.toLocaleString();
const latency = (ms: number | null): string => (ms === null ? "—" : `${Math.round(ms)} ms`);

/** Right-aligned tabular figure — counts and latencies line up digit-for-digit as the window changes. */
const num = (v: string): ReactNode => (
  <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
);

const COLUMNS: Column<AiUsageTenant>[] = [
  {
    key: "tenant",
    header: "Tenant",
    cell: (t) => t.tenantName,
    sortValue: (t) => t.tenantName,
  },
  {
    key: "requests",
    header: "Requests",
    align: "right",
    cell: (t) => num(fmt(t.requests)),
    sortValue: (t) => t.requests,
  },
  {
    key: "failures",
    header: "Non-ok",
    align: "right",
    cell: (t) =>
      t.failures > 0 ? (
        <span
          // --warning-700, not --warning: this is a NUMBER, and the base tone is 3.19:1 on white — under the
          // 4.5:1 AA floor for text. The base tone stays correct for fills and icons.
          style={{
            color: "var(--warning-700)",
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmt(t.failures)}
        </span>
      ) : (
        num("0")
      ),
    sortValue: (t) => t.failures,
  },
  {
    key: "repairs",
    header: "Repairs",
    align: "right",
    cell: (t) => num(fmt(t.repairs)),
    sortValue: (t) => t.repairs,
  },
  {
    key: "latency",
    header: "Avg latency",
    align: "right",
    cell: (t) => num(latency(t.avgLatencyMs)),
    sortValue: (t) => t.avgLatencyMs ?? -1,
  },
  {
    key: "tokens",
    header: "Tokens",
    align: "right",
    cell: (t) => num(fmt(t.inputTokens + t.outputTokens)),
    sortValue: (t) => t.inputTokens + t.outputTokens,
  },
];

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
    <PageContainer>
      <PageHeader
        title="AI usage"
        subtitle="Cross-tenant AI NL-search metering — request volume, outcomes, repair rate and latency over the window. Call metadata only; the query text is never stored."
        actions={
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--tp-space-2)",
              fontSize: "var(--tp-text-body)",
              color: "var(--tp-ink-3)",
            }}
          >
            <span>Window</span>
            <TpSelect value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {w} days
                </option>
              ))}
            </TpSelect>
          </label>
        }
      />

      <StateSwitch
        loading={loading}
        error={error}
        empty={!loading && !error && !(data && totals)}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            title="No AI usage recorded"
            description="Nothing has been logged for this window yet."
          />
        }
      >
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
            <DataTable
              columns={COLUMNS}
              rows={data.tenants}
              rowKey={(t) => t.tenantId}
              empty={
                <EmptyState title="No AI activity" description="Nothing recorded in this window." />
              }
            />
          </>
        ) : null}
      </StateSwitch>
    </PageContainer>
  );
}
