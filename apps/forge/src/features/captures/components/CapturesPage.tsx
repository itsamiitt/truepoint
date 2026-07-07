// CapturesPage.tsx — the captured-items feed: a DataTable of source, parser, status and capture time. Every
// async state renders through the shared State Kit. Public slice component; reads only, via the forge-api BFF.
"use client";

import {
  type Column,
  DataTable,
  EmptyState,
  StateSwitch,
  StatusBadge,
  type StatusTone,
} from "@leadwolf/ui";
import { ScanLine } from "lucide-react";
import { useCaptures } from "../hooks/useCaptures";
import type { Capture } from "../types";

function statusTone(status: string): StatusTone {
  if (status === "synced" || status === "parsed") return "success";
  if (status === "failed") return "danger";
  if (status === "pending" || status === "captured") return "warning";
  return "muted";
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 16);
}

const columns: Column<Capture>[] = [
  {
    key: "source",
    header: "Source",
    sortValue: (c) => c.source,
    cell: (c) => (
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span style={{ fontWeight: 500, color: "var(--tp-ink)" }}>{c.source}</span>
        {c.sourceUrl ? <span className="tp-cell-mono">{c.sourceUrl}</span> : null}
      </div>
    ),
  },
  {
    key: "parser",
    header: "Parser",
    sortValue: (c) => c.parser ?? "",
    cell: (c) => c.parser ?? <span className="app-muted">—</span>,
  },
  {
    key: "status",
    header: "Status",
    sortValue: (c) => c.status,
    cell: (c) => <StatusBadge tone={statusTone(c.status)}>{c.status}</StatusBadge>,
  },
  {
    key: "capturedAt",
    header: "Captured",
    sortValue: (c) => c.capturedAt,
    cell: (c) => <span className="tp-cell-mono">{shortTime(c.capturedAt)}</span>,
  },
];

export function CapturesPage() {
  const { captures, loading, error, reload } = useCaptures();

  return (
    <div className="tp-page">
      <div className="tp-page-head">
        <div>
          <h2 className="tp-page-title">Captures</h2>
          <p className="tp-page-sub">
            Everything the sources have captured — what parsed cleanly, what failed, and what is
            waiting.
          </p>
        </div>
      </div>

      <StateSwitch
        loading={loading}
        error={error}
        empty={!!captures && captures.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon={<ScanLine size={20} />}
            title="No captures"
            description="Captured items will appear here as sources produce them."
          />
        }
      >
        <DataTable columns={columns} rows={captures ?? []} rowKey={(c) => c.id} />
      </StateSwitch>
    </div>
  );
}
