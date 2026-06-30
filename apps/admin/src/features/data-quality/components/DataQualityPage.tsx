// DataQualityPage.tsx — the Data-quality cockpit (P5; 10 §5 Data Health + PLAN_06 re-verification). A read-only
// platform view over the data the core data-health workers already write: the cross-tenant rollup of the latest
// per-workspace data_quality_snapshots (coverage / validity / freshness rates) + the re-verification ledger
// (windowed totals + recent runs). NON-PII — counts only. Renders async state through the State Kit.
"use client";

import { type Column, DataTable, EmptyState, StateSwitch, TpSelect } from "@leadwolf/ui";
import { Gauge } from "lucide-react";
import { useDataQuality } from "../hooks/useDataQuality";
import type { VerificationRun } from "../types";

/** A whole-number percentage of n/d, or "—" when the denominator is zero. */
function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

function shortDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 16).replace("T", " ");
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--tp-line)",
        borderRadius: 10,
        padding: "12px 14px",
        minWidth: 130,
        flex: "1 1 130px",
      }}
    >
      <div style={{ fontSize: 12, color: "var(--tp-ink-3)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: "var(--tp-ink)", marginTop: 2 }}>
        {value}
      </div>
      {sub ? (
        <div className="app-muted" style={{ fontSize: 11, marginTop: 2 }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

const WINDOWS = [7, 30, 90];

export function DataQualityPage() {
  const { data, error, loading, days, applyDays, reload } = useDataQuality();

  const runColumns: Column<VerificationRun>[] = [
    {
      key: "finishedAt",
      header: "Finished",
      sortValue: (r) => r.finishedAt,
      cell: (r) => <span className="tp-cell-mono">{shortDateTime(r.finishedAt)}</span>,
    },
    {
      key: "tenant",
      header: "Tenant",
      sortValue: (r) => r.tenantName,
      cell: (r) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{r.tenantName}</span>,
    },
    {
      key: "scanned",
      header: "Scanned",
      align: "right",
      sortValue: (r) => r.scanned,
      cell: (r) => r.scanned.toLocaleString(),
    },
    {
      key: "reverified",
      header: "Re-verified",
      align: "right",
      sortValue: (r) => r.reverified,
      cell: (r) => r.reverified.toLocaleString(),
    },
    {
      key: "errored",
      header: "Errored",
      align: "right",
      sortValue: (r) => r.errored,
      cell: (r) => (
        <span style={{ color: r.errored > 0 ? "var(--danger)" : undefined }}>
          {r.errored.toLocaleString()}
        </span>
      ),
    },
  ];

  const rollup = data?.rollup;
  const totals = data?.verification.totals;

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Data quality</h2>
          <p className="tp-page-sub">
            Cross-tenant data health — coverage, validity and freshness from the latest
            per-workspace snapshots, plus the re-verification ledger. Counts only; no contact data
            is shown.
          </p>
        </div>
        <TpSelect
          aria-label="Window"
          value={String(days)}
          onChange={(e) => applyDays(Number(e.currentTarget.value))}
        >
          {WINDOWS.map((w) => (
            <option key={w} value={w}>
              Last {w} days
            </option>
          ))}
        </TpSelect>
      </div>

      <StateSwitch loading={loading} error={error} onRetry={() => void reload()}>
        {rollup ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <section>
              <h3 className="tp-section-title">Contact data health</h3>
              <p className="app-muted" style={{ margin: "4px 0 12px", fontSize: 12 }}>
                {rollup.workspaces.toLocaleString()} workspace
                {rollup.workspaces === 1 ? "" : "s"} reporting · latest snapshot{" "}
                {shortDate(rollup.latestAt)}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                <Tile label="Contacts" value={rollup.total.toLocaleString()} />
                <Tile
                  label="Email coverage"
                  value={pct(rollup.withEmail, rollup.total)}
                  sub={`${rollup.withEmail.toLocaleString()} with email`}
                />
                <Tile
                  label="Valid email"
                  value={pct(rollup.emailValid, rollup.total)}
                  sub={`${rollup.emailValid.toLocaleString()} valid`}
                />
                <Tile
                  label="Phone coverage"
                  value={pct(rollup.withPhone, rollup.total)}
                  sub={`${rollup.withPhone.toLocaleString()} with phone`}
                />
                <Tile
                  label="Fresh"
                  value={pct(rollup.fresh, rollup.total)}
                  sub={`${rollup.stale.toLocaleString()} stale`}
                />
                <Tile
                  label="Never verified"
                  value={pct(rollup.neverVerified, rollup.total)}
                  sub={`${rollup.neverVerified.toLocaleString()} contacts`}
                />
              </div>
              {rollup.total === 0 ? (
                <p className="app-muted" style={{ marginTop: 12, fontSize: 13 }}>
                  No data-quality snapshots captured yet — the daily data-health sweep populates
                  this.
                </p>
              ) : null}
            </section>

            <section>
              <h3 className="tp-section-title">Re-verification (last {data?.windowDays} days)</h3>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: "12px 0" }}>
                <Tile label="Runs" value={(totals?.runs ?? 0).toLocaleString()} />
                <Tile label="Scanned" value={(totals?.scanned ?? 0).toLocaleString()} />
                <Tile label="Re-verified" value={(totals?.reverified ?? 0).toLocaleString()} />
                <Tile label="Errored" value={(totals?.errored ?? 0).toLocaleString()} />
              </div>
              {data && data.verification.recentRuns.length > 0 ? (
                <DataTable
                  columns={runColumns}
                  rows={data.verification.recentRuns}
                  rowKey={(r) => `${r.tenantId}-${r.finishedAt}`}
                />
              ) : (
                <EmptyState
                  icon={<Gauge size={20} />}
                  title="No re-verification runs"
                  description="The freshness re-verification worker has not recorded a run in this window."
                />
              )}
            </section>
          </div>
        ) : null}
      </StateSwitch>
    </div>
  );
}
