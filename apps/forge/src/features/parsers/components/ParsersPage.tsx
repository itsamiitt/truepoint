// ParsersPage.tsx — the parser registry: a DataTable of name, kind, status, recent success rate and last run.
// Every async state renders through the shared State Kit. Public slice component; reads only, via the forge-api
// BFF.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  StatusBadge,
  type StatusTone,
} from "@leadwolf/ui";
import { Braces } from "lucide-react";
import { useParsers } from "../hooks/useParsers";
import type { Parser } from "../types";

function statusTone(status: string): StatusTone {
  if (status === "active") return "success";
  if (status === "disabled") return "danger";
  if (status === "draft") return "warning";
  return "muted";
}

function pct(rate: number): string {
  if (typeof rate !== "number" || Number.isNaN(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 16);
}

const columns: Column<Parser>[] = [
  {
    key: "name",
    header: "Parser",
    sortValue: (p) => p.name,
    cell: (p) => <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{p.name}</span>,
  },
  {
    key: "kind",
    header: "Kind",
    sortValue: (p) => p.kind,
    cell: (p) => <span className="tp-cell-mono">{p.kind}</span>,
  },
  {
    key: "status",
    header: "Status",
    sortValue: (p) => p.status,
    cell: (p) => <StatusBadge tone={statusTone(p.status)}>{p.status}</StatusBadge>,
  },
  {
    key: "successRate",
    header: "Success",
    align: "right",
    sortValue: (p) => p.successRate,
    cell: (p) => pct(p.successRate),
  },
  {
    key: "lastRunAt",
    header: "Last run",
    sortValue: (p) => p.lastRunAt ?? "",
    cell: (p) => <span className="tp-cell-mono">{shortTime(p.lastRunAt)}</span>,
  },
];

export function ParsersPage() {
  const { parsers, loading, error, reload } = useParsers();

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Parsers</h2>
          <p className="tp-page-sub">
            The registered parsers that turn captures into structured records, and how they are
            faring.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!parsers && parsers.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<Braces size={20} />}
            title="No parsers"
            description="No parsers have been registered yet."
          />
        }
      >
        <DataTable columns={columns} rows={parsers ?? []} rowKey={(p) => p.id} />
      </StateSwitch>
    </div>
  );
}
